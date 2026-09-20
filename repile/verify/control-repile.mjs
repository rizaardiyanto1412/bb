#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERIFY_ROOT = dirname(SCRIPT_PATH);
const REPO_ROOT = dirname(dirname(dirname(SCRIPT_PATH)));
const PLUGIN_ID = "repile-provider-auth";
const PLUGIN_PATH = join(REPO_ROOT, "repile", "plugins", PLUGIN_ID);
const HTTP_BASE_PATH = `/api/v1/plugins/${PLUGIN_ID}/http`;
const INVALID_SECRET = "repile-verify-invalid-key";
const THREAD_CONTEXT_KEYS = [
  "BB_ENVIRONMENT_ID",
  "BB_THREAD_ID",
  "BB_THREAD_STORAGE",
  "BB_PROJECT_ID",
  "BB_CLI",
  "BB_CLI_REEXEC",
];
const SERVER_READY_TIMEOUT_MS = 120000;
const APP_READY_TIMEOUT_MS = 180000;
const HTTP_TIMEOUT_MS = 90000;
const CLI_TIMEOUT_MS = 300000;
const STOP_GRACE_MS = 8000;

function usage() {
  return [
    "control-repile.mjs <command> [options]",
    "",
    "Commands:",
    "  launch          Start an isolated server + app stack for verification",
    "  doctor          Read-only health check of a launched stack",
    "  install-plugin  Install repile-provider-auth on the launched stack",
    "  drive-auth      Exercise provider-auth without human OAuth",
    "  cleanup         Stop launched processes, keep proof artifacts",
    "",
    "Options:",
    "  --state <path>  Path to run.json (or set REPILE_VERIFY_STATE)",
    "  --root <path>   Verify root override (default: script directory)",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { command: argv[0] ?? null, state: null, root: VERIFY_ROOT };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--state" || flag === "--root") && value !== undefined) {
      if (flag === "--state") {
        out.state = value;
      } else {
        out.root = value;
      }
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag}\n${usage()}`);
    }
  }
  if (out.command === null) {
    throw new Error(usage());
  }
  return out;
}

function resolveStatePath(explicit) {
  const found = explicit ?? process.env.REPILE_VERIFY_STATE ?? null;
  if (found === null) {
    throw new Error("no state file: pass --state <path-to-run.json> or set REPILE_VERIFY_STATE");
  }
  return found;
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        if (port === null) {
          rejectPromise(new Error("could not allocate a free port"));
          return;
        }
        resolvePromise(port);
      });
    });
  });
}

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const key of THREAD_CONTEXT_KEYS) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function writeText(path, text) {
  writeFileSync(path, text, "utf8");
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchJson(url, options, timeoutMs) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs ?? HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = { unparsed: text.slice(0, 2000) };
  }
  return { status: response.status, body };
}

async function waitFor(label, check, timeoutMs) {
  const started = Date.now();
  let lastError = "not attempted";
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result.ok) {
        return result.value;
      }
      lastError = result.detail;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }
  throw new Error(`${label} not ready within ${timeoutMs}ms (last: ${lastError})`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "EPERM";
  }
}

function signalPid(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

async function stopPid(pid) {
  if (pid === null || !pidAlive(pid)) {
    return { pid, action: "already-gone" };
  }
  signalPid(pid, "SIGTERM");
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      return { pid, action: "terminated" };
    }
    await sleep(250);
  }
  signalPid(pid, "SIGKILL");
  await sleep(1000);
  return { pid, action: pidAlive(pid) ? "kill-sent-still-alive" : "killed" };
}

function runCli(args, state, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ["--conditions=source", "--import", "tsx", "apps/cli/src/index.ts", ...args],
      {
        cwd: REPO_ROOT,
        env: cleanEnv({
          BB_SERVER_URL: state.serverUrl,
          BB_DATA_DIR: state.dataDir,
          NODE_ENV: "development",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        return;
      }
    }, timeoutMs ?? CLI_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

async function cmdLaunch(root) {
  const runId = new Date().toISOString().replace(/[:.]/gu, "-");
  const proofDir = join(root, "proof", runId);
  mkdirSync(proofDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "repile-verify-"));
  const dataDir = join(scratch, "data");
  const homeDir = join(scratch, "home");
  const codexHome = join(scratch, "codex-home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const appPort = await freePort();
  const serverPort = await freePort();
  const daemonPort = await freePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const appUrl = `http://127.0.0.1:${appPort}`;
  const serverLog = join(scratch, "server.log");
  const appLog = join(scratch, "app.log");
  const serverFd = openSync(serverLog, "a");
  const appFd = openSync(appLog, "a");
  const earlyExit = { server: null, app: null };
  const serverEnv = cleanEnv({
    HOME: homeDir,
    CODEX_HOME: codexHome,
    BB_DATA_DIR: dataDir,
    BB_SERVER_PORT: String(serverPort),
    BB_HOST_DAEMON_PORT: String(daemonPort),
    BB_DEV_APP_PORT: String(appPort),
    BB_SERVER_URL: serverUrl,
    BB_APP_URL: appUrl,
    BB_TELEMETRY: "false",
    NODE_ENV: "development",
  });
  const serverChild = spawn(
    process.execPath,
    ["--conditions=source", "--import", "tsx", "apps/server/src/index.ts"],
    { cwd: REPO_ROOT, env: serverEnv, detached: true, stdio: ["ignore", serverFd, serverFd] },
  );
  serverChild.on("exit", (code, signal) => {
    earlyExit.server = { code, signal };
  });
  serverChild.unref();
  const appEnv = cleanEnv({
    BB_DEV_APP_PORT: String(appPort),
    BB_SERVER_PORT: String(serverPort),
    NODE_ENV: "development",
  });
  const appChild = spawn(
    process.execPath,
    ["../app/node_modules/vite/bin/vite.js", "--config", "vite.dev.config.ts", "--configLoader", "runner"],
    {
      cwd: join(REPO_ROOT, "apps", "app"),
      env: appEnv,
      detached: true,
      stdio: ["ignore", appFd, appFd],
    },
  );
  appChild.on("exit", (code, signal) => {
    earlyExit.app = { code, signal };
  });
  appChild.unref();
  closeSync(serverFd);
  closeSync(appFd);
  const state = {
    runId,
    verifyRoot: root,
    proofDir,
    scratch,
    dataDir,
    homeDir,
    codexHome,
    appPort,
    serverPort,
    daemonPort,
    appUrl,
    serverUrl,
    serverPid: serverChild.pid ?? null,
    appPid: appChild.pid ?? null,
    serverLog,
    appLog,
    pluginId: PLUGIN_ID,
    pluginPath: PLUGIN_PATH,
    launchedAt: new Date().toISOString(),
  };
  const statePath = join(proofDir, "run.json");
  writeJson(statePath, state);
  writeText(join(proofDir, "urls.txt"), `App ${appUrl}\nServer ${serverUrl}\nData ${dataDir}\n`);
  try {
    const health = await waitFor("server /health", async () => {
      const extra = earlyExit.server === null ? "" : ` (server exited: ${JSON.stringify(earlyExit.server)})`;
      const result = await fetchJson(`${serverUrl}/health`, {}, 5000);
      if (result.status === 200 && result.body !== null && result.body.ok === true) {
        return { ok: true, value: result.body };
      }
      return { ok: false, detail: `HTTP ${result.status}${extra}` };
    }, SERVER_READY_TIMEOUT_MS);
    writeJson(join(proofDir, "health.json"), health);
    const appBody = await waitFor("app /", async () => {
      const extra = earlyExit.app === null ? "" : ` (app exited: ${JSON.stringify(earlyExit.app)})`;
      const response = await fetch(appUrl, { signal: AbortSignal.timeout(5000) });
      const text = await response.text();
      if (response.status === 200 && text.includes("<title>Repile</title>")) {
        return { ok: true, value: text };
      }
      return { ok: false, detail: `HTTP ${response.status}${extra}` };
    }, APP_READY_TIMEOUT_MS);
    writeText(join(proofDir, "app-head.html"), appBody.slice(0, 4000));
  } catch (error) {
    state.launchError = error instanceof Error ? error.message : String(error);
    writeJson(statePath, state);
    throw error;
  }
  process.stdout.write(`App ${appUrl}\nServer ${serverUrl}\nData ${dataDir}\nState ${statePath}\nProof ${proofDir}\n`);
  return statePath;
}

async function cmdDoctor(state, statePath) {
  const report = { state: statePath, serverUrl: state.serverUrl, appUrl: state.appUrl, checks: [] };
  const health = await fetchJson(`${state.serverUrl}/health`, {}, 10000);
  const healthOk = health.status === 200 && health.body !== null && health.body.ok === true;
  report.checks.push({ name: "server-health", pass: healthOk, detail: `HTTP ${health.status}` });
  report.health = health.body;
  let titleOk = false;
  let titleDetail = "";
  try {
    const response = await fetch(state.appUrl, { signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    titleOk = response.status === 200 && text.includes("<title>Repile</title>");
    titleDetail = `HTTP ${response.status}`;
  } catch (error) {
    titleDetail = error instanceof Error ? error.message : String(error);
  }
  report.checks.push({ name: "app-title", pass: titleOk, detail: titleDetail });
  const listed = await runCli(["plugin", "list", "--json"], state, 60000);
  writeText(join(state.proofDir, "doctor-plugin-list.json"), listed.stdout);
  let pluginSeen = false;
  let pluginDetail = `exit ${String(listed.exitCode)}`;
  try {
    const parsed = JSON.parse(listed.stdout);
    const candidates = Array.isArray(parsed) ? parsed : (parsed.plugins ?? []);
    const entry = Array.isArray(candidates) ? candidates.find((item) => item !== null && typeof item === "object" && "id" in item && item.id === PLUGIN_ID) : null;
    if (entry !== null && entry !== undefined) {
      pluginSeen = true;
      pluginDetail = `id ${PLUGIN_ID} status ${String(entry.status ?? "unknown")}`;
    } else if (listed.stdout.includes(PLUGIN_ID)) {
      pluginSeen = true;
      pluginDetail = "id present in output (unstructured match)";
    }
  } catch {
    pluginSeen = listed.stdout.includes(PLUGIN_ID);
    pluginDetail = pluginSeen ? "id present in output (unparsed match)" : `unparseable output exit ${String(listed.exitCode)}`;
  }
  report.checks.push({ name: "plugin-installed", pass: pluginSeen, detail: pluginDetail });
  report.pass = report.checks.every((check) => check.pass);
  writeJson(join(state.proofDir, "doctor.json"), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) {
    throw new Error("doctor failed");
  }
}

async function cmdInstallPlugin(state) {
  const result = await runCli(["plugin", "install", "--yes", `path:${state.pluginPath}`], state, CLI_TIMEOUT_MS);
  writeText(join(state.proofDir, "install-plugin.txt"), `$ bb plugin install --yes path:${state.pluginPath}\nexit ${String(result.exitCode)} timedOut ${String(result.timedOut)}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`);
  process.stdout.write(result.stdout);
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`plugin install failed with exit ${String(result.exitCode)}`);
  }
}

function checkRecord(checks, name, pass, detail) {
  checks.push({ name, pass, detail });
  return pass;
}

async function cmdDriveAuth(state) {
  const proofDir = state.proofDir;
  const base = `${state.serverUrl}${HTTP_BASE_PATH}`;
  const jsonHeaders = { "content-type": "application/json" };
  const checks = [];
  let pass = true;
  const note = (name, ok, detail) => {
    if (!checkRecord(checks, name, ok, detail)) {
      pass = false;
    }
  };
  const statusOf = async (provider) => fetchJson(`${base}/auth/status?provider=${provider}`, {}, HTTP_TIMEOUT_MS);
  const claudeStatus = await statusOf("claude");
  writeJson(join(proofDir, "status-claude.json"), claudeStatus);
  note("status-claude", claudeStatus.status === 200 && claudeStatus.body !== null && claudeStatus.body.provider === "claude" && typeof claudeStatus.body.loggedIn === "boolean", `HTTP ${claudeStatus.status} loggedIn ${String(claudeStatus.body?.loggedIn)}`);
  const codexStatus = await statusOf("codex");
  writeJson(join(proofDir, "status-codex.json"), codexStatus);
  note("status-codex", codexStatus.status === 200 && codexStatus.body !== null && codexStatus.body.provider === "codex" && typeof codexStatus.body.loggedIn === "boolean", `HTTP ${codexStatus.status} loggedIn ${String(codexStatus.body?.loggedIn)}`);
  const startCodex = await fetchJson(`${base}/auth/start`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ provider: "codex" }) }, HTTP_TIMEOUT_MS);
  writeJson(join(proofDir, "start-codex.json"), startCodex);
  const codexStartOk = startCodex.status === 200 && startCodex.body !== null && (startCodex.body.state === "awaiting-user" || startCodex.body.state === "completed") && (startCodex.body.state === "completed" || startCodex.body.url === null);
  note("start-codex", codexStartOk, `HTTP ${startCodex.status} state ${String(startCodex.body?.state)}`);
  const startClaude = await fetchJson(`${base}/auth/start`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ provider: "claude" }) }, HTTP_TIMEOUT_MS);
  writeJson(join(proofDir, "start-claude.json"), startClaude);
  const claudeUrl = startClaude.body !== null && typeof startClaude.body === "object" && "url" in startClaude.body ? startClaude.body.url : null;
  const claudeStartOk =
    startClaude.status === 200 &&
    startClaude.body !== null &&
    (startClaude.body.state === "completed" ||
      (startClaude.body.state === "awaiting-user" && typeof claudeUrl === "string" && claudeUrl.startsWith("https://")));
  note("start-claude", claudeStartOk, `HTTP ${startClaude.status} state ${String(startClaude.body?.state)} urlPresent ${String(typeof claudeUrl === "string")}`);
  const completeCodex = await fetchJson(`${base}/auth/complete`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ provider: "codex", tokenOrKey: INVALID_SECRET }) }, HTTP_TIMEOUT_MS);
  writeJson(join(proofDir, "complete-codex-invalid.json"), { request: { provider: "codex", tokenOrKey: "***redacted***" }, status: completeCodex.status, body: completeCodex.body });
  note("complete-codex-invalid", completeCodex.status === 200 && completeCodex.body !== null && completeCodex.body.state === "completed", `HTTP ${completeCodex.status} state ${String(completeCodex.body?.state)} (codex performs no key validation at login; bad keys fail at first use)`);
  if (startClaude.body !== null && startClaude.body.state === "awaiting-user") {
    const completeClaude = await fetchJson(`${base}/auth/complete`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ provider: "claude", tokenOrKey: INVALID_SECRET }) }, HTTP_TIMEOUT_MS);
    writeJson(join(proofDir, "complete-claude-invalid.json"), { request: { provider: "claude", tokenOrKey: "***redacted***" }, status: completeClaude.status, body: completeClaude.body });
    note("complete-claude-invalid", completeClaude.status === 200 && completeClaude.body !== null && completeClaude.body.state === "failed" && typeof completeClaude.body.error === "string" && completeClaude.body.error.length > 0, `HTTP ${completeClaude.status} state ${String(completeClaude.body?.state)}`);
  } else {
    writeJson(join(proofDir, "complete-claude-invalid.json"), { skipped: "no awaiting-user claude flow (start state: " + String(startClaude.body?.state ?? null) + ")", state: startClaude.body?.state ?? null });
    note("complete-claude-invalid", true, "skipped: start state " + String(startClaude.body?.state ?? null));
  }
  for (const provider of ["claude", "codex"]) {
    const cancelled = await fetchJson(`${base}/auth/login?provider=${provider}`, { method: "DELETE", headers: jsonHeaders }, HTTP_TIMEOUT_MS);
    writeJson(join(proofDir, `cancel-${provider}.json`), cancelled);
    note(`cancel-${provider}`, cancelled.status === 200 && cancelled.body !== null && cancelled.body.cancelled === true, `HTTP ${cancelled.status}`);
  }
  const afterClaude = await statusOf("claude");
  writeJson(join(proofDir, "status-after-claude.json"), afterClaude);
  note("status-after-claude", afterClaude.status === 200, `HTTP ${afterClaude.status}`);
  const afterCodex = await statusOf("codex");
  writeJson(join(proofDir, "status-after-codex.json"), afterCodex);
  note("status-after-codex", afterCodex.status === 200, `HTTP ${afterCodex.status}`);
  const cliStatus = await runCli(["provider-auth", "status"], state, 60000);
  writeText(join(proofDir, "cli-provider-auth-status.txt"), `$ bb provider-auth status\nexit ${String(cliStatus.exitCode)}\n--- stdout ---\n${cliStatus.stdout}\n--- stderr ---\n${cliStatus.stderr}\n`);
  const cliTextOk = cliStatus.exitCode === 0 && cliStatus.stdout.includes("claude") && cliStatus.stdout.includes("codex") && !cliStatus.stdout.includes(INVALID_SECRET) && !cliStatus.stderr.includes(INVALID_SECRET);
  note("cli-provider-auth-status", cliTextOk, `exit ${String(cliStatus.exitCode)}`);
  const cliJson = await runCli(["provider-auth", "status", "--provider", "codex", "--json"], state, 60000);
  writeText(join(proofDir, "cli-provider-auth-codex.txt"), `$ bb provider-auth status --provider codex --json\nexit ${String(cliJson.exitCode)}\n--- stdout ---\n${cliJson.stdout}\n--- stderr ---\n${cliJson.stderr}\n`);
  let cliJsonOk = false;
  let cliJsonDetail = `exit ${String(cliJson.exitCode)}`;
  try {
    const parsed = JSON.parse(cliJson.stdout);
    cliJsonOk = cliJson.exitCode === 0 && parsed !== null && typeof parsed === "object" && parsed.provider === "codex";
    cliJsonDetail = `exit ${String(cliJson.exitCode)} provider ${String(parsed.provider)}`;
  } catch {
    cliJsonDetail = `exit ${String(cliJson.exitCode)} unparseable`;
  }
  note("cli-provider-auth-codex-json", cliJsonOk, cliJsonDetail);
  const summary = { proofDir, serverUrl: state.serverUrl, secretHandling: "invalid token sent but never written to proof; request bodies stored redacted", checks, pass };
  writeJson(join(proofDir, "drive-auth.json"), summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!pass) {
    throw new Error("drive-auth failed");
  }
}

async function cmdCleanup(state) {
  const proofDir = state.proofDir;
  for (const entry of [{ label: "server.log", from: state.serverLog }, { label: "app.log", from: state.appLog }]) {
    try {
      copyFileSync(entry.from, join(proofDir, entry.label));
    } catch {
      writeText(join(proofDir, entry.label), `log unavailable at ${entry.from}\n`);
    }
  }
  const stopped = [];
  if (state.serverPid !== null) {
    stopped.push({ service: "server", ...(await stopPid(state.serverPid)) });
  }
  if (state.appPid !== null) {
    stopped.push({ service: "app", ...(await stopPid(state.appPid)) });
  }
  let scratchRemoved = false;
  try {
    rmSync(state.scratch, { recursive: true, force: true });
    scratchRemoved = true;
  } catch (error) {
    stopped.push({ service: "scratch", action: error instanceof Error ? error.message : String(error) });
  }
  const report = { proofDir, stopped, scratchRemoved, cleanedAt: new Date().toISOString() };
  writeJson(join(proofDir, "cleanup.json"), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "launch") {
    await cmdLaunch(args.root);
    return;
  }
  const statePath = resolveStatePath(args.state);
  const state = readState(statePath);
  if (args.command === "doctor") {
    await cmdDoctor(state, statePath);
  } else if (args.command === "install-plugin") {
    await cmdInstallPlugin(state);
  } else if (args.command === "drive-auth") {
    await cmdDriveAuth(state);
  } else if (args.command === "cleanup") {
    await cmdCleanup(state);
  } else {
    throw new Error(`unknown command: ${args.command}\n${usage()}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
