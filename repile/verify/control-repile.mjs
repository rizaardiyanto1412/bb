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
const CLAUDE_PLUGIN_ID = "provider-claude-code";
const CODEX_PLUGIN_ID = "provider-codex";
const BUNDLED_PLUGIN_IDS = [CLAUDE_PLUGIN_ID, CODEX_PLUGIN_ID];
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
    "  drive-auth      Exercise provider subscription login without human OAuth",
    "  cleanup         Stop launched processes, keep proof artifacts",
    "  vps-doctor      Read-only health check of the production VPS",
    "  vps-drive-auth  Exercise subscription login on the VPS, no real secrets",
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
    throw new Error(
      "no state file: pass --state <path-to-run.json> or set REPILE_VERIFY_STATE",
    );
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
      const port =
        typeof address === "object" && address !== null ? address.port : null;
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
  throw new Error(
    `${label} not ready within ${timeoutMs}ms (last: ${lastError})`,
  );
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EPERM"
    );
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
      [
        "--conditions=source",
        "--import",
        "tsx",
        "apps/cli/src/index.ts",
        ...args,
      ],
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
      resolvePromise({
        exitCode: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
      });
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
    {
      cwd: REPO_ROOT,
      env: serverEnv,
      detached: true,
      stdio: ["ignore", serverFd, serverFd],
    },
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
    [
      "../app/node_modules/vite/bin/vite.js",
      "--config",
      "vite.dev.config.ts",
      "--configLoader",
      "runner",
    ],
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
    pluginIds: BUNDLED_PLUGIN_IDS,
    launchedAt: new Date().toISOString(),
  };
  const statePath = join(proofDir, "run.json");
  writeJson(statePath, state);
  writeText(
    join(proofDir, "urls.txt"),
    `App ${appUrl}\nServer ${serverUrl}\nData ${dataDir}\n`,
  );
  try {
    const health = await waitFor(
      "server /health",
      async () => {
        const extra =
          earlyExit.server === null
            ? ""
            : ` (server exited: ${JSON.stringify(earlyExit.server)})`;
        const result = await fetchJson(`${serverUrl}/health`, {}, 5000);
        if (
          result.status === 200 &&
          result.body !== null &&
          result.body.ok === true
        ) {
          return { ok: true, value: result.body };
        }
        return { ok: false, detail: `HTTP ${result.status}${extra}` };
      },
      SERVER_READY_TIMEOUT_MS,
    );
    writeJson(join(proofDir, "health.json"), health);
    const appBody = await waitFor(
      "app /",
      async () => {
        const extra =
          earlyExit.app === null
            ? ""
            : ` (app exited: ${JSON.stringify(earlyExit.app)})`;
        const response = await fetch(appUrl, {
          signal: AbortSignal.timeout(5000),
        });
        const text = await response.text();
        if (response.status === 200 && text.includes("<title>Repile</title>")) {
          return { ok: true, value: text };
        }
        return { ok: false, detail: `HTTP ${response.status}${extra}` };
      },
      APP_READY_TIMEOUT_MS,
    );
    writeText(join(proofDir, "app-head.html"), appBody.slice(0, 4000));
  } catch (error) {
    state.launchError = error instanceof Error ? error.message : String(error);
    writeJson(statePath, state);
    throw error;
  }
  process.stdout.write(
    `App ${appUrl}\nServer ${serverUrl}\nData ${dataDir}\nState ${statePath}\nProof ${proofDir}\n`,
  );
  return statePath;
}

async function cmdDoctor(state, statePath) {
  const report = {
    state: statePath,
    serverUrl: state.serverUrl,
    appUrl: state.appUrl,
    checks: [],
  };
  const health = await fetchJson(`${state.serverUrl}/health`, {}, 10000);
  const healthOk =
    health.status === 200 && health.body !== null && health.body.ok === true;
  report.checks.push({
    name: "server-health",
    pass: healthOk,
    detail: `HTTP ${health.status}`,
  });
  report.health = health.body;
  let titleOk = false;
  let titleDetail = "";
  try {
    const response = await fetch(state.appUrl, {
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    titleOk = response.status === 200 && text.includes("<title>Repile</title>");
    titleDetail = `HTTP ${response.status}`;
  } catch (error) {
    titleDetail = error instanceof Error ? error.message : String(error);
  }
  report.checks.push({ name: "app-title", pass: titleOk, detail: titleDetail });
  const listed = await runCli(["plugin", "list", "--json"], state, 60000);
  writeText(join(state.proofDir, "doctor-plugin-list.json"), listed.stdout);
  const missing = [];
  let pluginDetail = `exit ${String(listed.exitCode)}`;
  try {
    const parsed = JSON.parse(listed.stdout);
    const candidates = Array.isArray(parsed) ? parsed : (parsed.plugins ?? []);
    const ids = new Set(
      Array.isArray(candidates)
        ? candidates
            .filter(
              (item) =>
                item !== null && typeof item === "object" && "id" in item,
            )
            .map((item) => String(item.id))
        : [],
    );
    for (const id of BUNDLED_PLUGIN_IDS) {
      if (!ids.has(id) && !listed.stdout.includes(id)) missing.push(id);
    }
    pluginDetail =
      missing.length === 0
        ? "bundled provider plugins present"
        : `missing ${missing.join(",")}`;
  } catch {
    for (const id of BUNDLED_PLUGIN_IDS) {
      if (!listed.stdout.includes(id)) missing.push(id);
    }
    pluginDetail =
      missing.length === 0
        ? "ids present in output (unparsed match)"
        : `missing ${missing.join(",")} (unparsed, exit ${String(listed.exitCode)})`;
  }
  report.checks.push({
    name: "provider-plugins-installed",
    pass: missing.length === 0,
    detail: pluginDetail,
  });
  report.pass = report.checks.every((check) => check.pass);
  writeJson(join(state.proofDir, "doctor.json"), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) {
    throw new Error("doctor failed");
  }
}

function checkRecord(checks, name, pass, detail) {
  checks.push({ name, pass, detail });
  return pass;
}

async function cmdDriveAuth(state) {
  const proofDir = state.proofDir;
  const jsonHeaders = { "content-type": "application/json" };
  const checks = [];
  let pass = true;
  const note = (name, ok, detail) => {
    if (!checkRecord(checks, name, ok, detail)) {
      pass = false;
    }
  };
  const rpc = (pluginId, method, input) =>
    fetchJson(
      `${state.serverUrl}/api/v1/plugins/${pluginId}/rpc/${method}`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(input ?? null),
      },
      HTTP_TIMEOUT_MS,
    );
  const rpcError = (result) =>
    result.body !== null &&
    typeof result.body === "object" &&
    typeof result.body.error === "object" &&
    result.body.error !== null
      ? String(result.body.error.message ?? "")
      : "";
  const rpcOk = (result) =>
    result.status === 200 &&
    result.body !== null &&
    result.body.ok === true &&
    result.body.result !== null &&
    typeof result.body.result === "object";

  const claudeStatus = await rpc(CLAUDE_PLUGIN_ID, "subscription.status");
  writeJson(join(proofDir, "status-claude.json"), claudeStatus);
  note(
    "status-claude",
    rpcOk(claudeStatus) &&
      typeof claudeStatus.body.result.loggedIn === "boolean",
    `HTTP ${claudeStatus.status} loggedIn ${String(claudeStatus.body?.result?.loggedIn)}`,
  );
  const codexStatus = await rpc(CODEX_PLUGIN_ID, "subscription.status");
  writeJson(join(proofDir, "status-codex.json"), codexStatus);
  note(
    "status-codex",
    rpcOk(codexStatus) && typeof codexStatus.body.result.loggedIn === "boolean",
    `HTTP ${codexStatus.status} loggedIn ${String(codexStatus.body?.result?.loggedIn)}`,
  );

  const startCodex = await rpc(CODEX_PLUGIN_ID, "subscription.start");
  writeJson(join(proofDir, "start-codex.json"), startCodex);
  const codexStartResult = startCodex.body?.result ?? null;
  const codexStartOk =
    rpcOk(startCodex) &&
    (codexStartResult.state === "completed" ||
      (codexStartResult.state === "awaiting-user" &&
        typeof codexStartResult.verificationUri === "string" &&
        codexStartResult.verificationUri.startsWith("https://") &&
        typeof codexStartResult.userCode === "string" &&
        codexStartResult.userCode.length > 0));
  note(
    "start-codex",
    codexStartOk,
    `HTTP ${startCodex.status} state ${String(codexStartResult?.state)}`,
  );
  if (codexStartOk && codexStartResult.state === "awaiting-user") {
    const pollCodex = await rpc(CODEX_PLUGIN_ID, "subscription.poll", {
      sessionId: codexStartResult.sessionId,
    });
    writeJson(join(proofDir, "poll-codex.json"), pollCodex);
    const pollState = pollCodex.body?.result?.state;
    note(
      "poll-codex",
      rpcOk(pollCodex) &&
        (pollState === "pending" ||
          pollState === "failed" ||
          pollState === "completed"),
      `HTTP ${pollCodex.status} state ${String(pollState)}`,
    );
    const cancelCodex = await rpc(CODEX_PLUGIN_ID, "subscription.cancel", {
      sessionId: codexStartResult.sessionId,
    });
    writeJson(join(proofDir, "cancel-codex.json"), cancelCodex);
    note(
      "cancel-codex",
      rpcOk(cancelCodex) && cancelCodex.body.result.cancelled === true,
      `HTTP ${cancelCodex.status}`,
    );
  } else {
    note(
      "poll-codex",
      true,
      "skipped: codex already signed in or start failed",
    );
    note("cancel-codex", true, "skipped: no awaiting-user codex flow");
  }

  const keyLogin = await rpc(CODEX_PLUGIN_ID, "subscription.loginApiKey", {
    apiKey: INVALID_SECRET,
  });
  writeJson(join(proofDir, "login-codex-apikey-invalid.json"), {
    request: { apiKey: "***redacted***" },
    status: keyLogin.status,
    body: keyLogin.body,
  });
  note(
    "login-codex-apikey",
    rpcOk(keyLogin) &&
      keyLogin.body.result.loggedIn === true &&
      keyLogin.body.result.mode === "apiKey",
    `HTTP ${keyLogin.status} mode ${String(keyLogin.body?.result?.mode)} (codex performs no key validation at login; bad keys fail at first use)`,
  );
  const codexKeyStatus = await rpc(CODEX_PLUGIN_ID, "subscription.status");
  writeJson(join(proofDir, "status-codex-apikey.json"), codexKeyStatus);
  note(
    "status-codex-apikey",
    rpcOk(codexKeyStatus) &&
      codexKeyStatus.body.result.loggedIn === true &&
      codexKeyStatus.body.result.mode === "apiKey",
    `HTTP ${codexKeyStatus.status}`,
  );
  const codexLogout = await rpc(CODEX_PLUGIN_ID, "subscription.logout");
  writeJson(join(proofDir, "logout-codex.json"), codexLogout);
  note(
    "logout-codex",
    rpcOk(codexLogout) && codexLogout.body.result.loggedIn === false,
    `HTTP ${codexLogout.status}`,
  );

  const startClaude = await rpc(CLAUDE_PLUGIN_ID, "subscription.start");
  writeJson(join(proofDir, "start-claude.json"), startClaude);
  const claudeStartResult = startClaude.body?.result ?? null;
  const claudeUrl =
    typeof claudeStartResult?.authorizeUrl === "string"
      ? claudeStartResult.authorizeUrl
      : null;
  const claudeStartOk =
    rpcOk(startClaude) &&
    (claudeStartResult.state === "completed" ||
      (claudeStartResult.state === "awaiting-user" &&
        claudeUrl !== null &&
        claudeUrl.startsWith("https://")));
  note(
    "start-claude",
    claudeStartOk,
    `HTTP ${startClaude.status} state ${String(claudeStartResult?.state)} urlPresent ${String(claudeUrl !== null)}`,
  );
  if (claudeStartOk && claudeStartResult.state === "awaiting-user") {
    const completeClaude = await rpc(
      CLAUDE_PLUGIN_ID,
      "subscription.complete",
      { sessionId: claudeStartResult.sessionId, code: INVALID_SECRET },
    );
    writeJson(join(proofDir, "complete-claude-invalid.json"), {
      request: { sessionId: "***redacted***", code: "***redacted***" },
      status: completeClaude.status,
      body: completeClaude.body,
    });
    const failedOk =
      completeClaude.body !== null &&
      completeClaude.body.ok === false &&
      rpcError(completeClaude).length > 0;
    note(
      "complete-claude-invalid",
      failedOk,
      `HTTP ${completeClaude.status} error ${rpcError(completeClaude).slice(0, 80)}`,
    );
    const glued =
      "repile-verify-code-123https://claude.com/cai/oauth/authorize?code=true";
    const restartMalformed = await rpc(CLAUDE_PLUGIN_ID, "subscription.start");
    if (restartMalformed.body?.result?.state === "awaiting-user") {
      const malformedBegin = Date.now();
      const malformed = await rpc(CLAUDE_PLUGIN_ID, "subscription.complete", {
        sessionId: restartMalformed.body.result.sessionId,
        code: glued,
      });
      const malformedElapsed = Date.now() - malformedBegin;
      writeJson(join(proofDir, "complete-claude-malformed.json"), {
        request: { code: "***redacted***" },
        elapsedMs: malformedElapsed,
        status: malformed.status,
        body: malformed.body,
      });
      note(
        "complete-claude-malformed",
        malformed.body !== null &&
          malformed.body.ok === false &&
          malformedElapsed < 30000,
        `HTTP ${malformed.status} elapsedMs ${String(malformedElapsed)}`,
      );
    } else {
      note(
        "complete-claude-malformed",
        true,
        "skipped: no awaiting-user claude flow on restart",
      );
    }
    const restartCancel = await rpc(CLAUDE_PLUGIN_ID, "subscription.start");
    if (restartCancel.body?.result?.state === "awaiting-user") {
      const cancelClaude = await rpc(CLAUDE_PLUGIN_ID, "subscription.cancel", {
        sessionId: restartCancel.body.result.sessionId,
      });
      writeJson(join(proofDir, "cancel-claude.json"), cancelClaude);
      note(
        "cancel-claude",
        rpcOk(cancelClaude) && cancelClaude.body.result.cancelled === true,
        `HTTP ${cancelClaude.status}`,
      );
    } else {
      note(
        "cancel-claude",
        true,
        "skipped: no awaiting-user claude flow on restart",
      );
    }
  } else {
    writeJson(join(proofDir, "complete-claude-invalid.json"), {
      skipped: "no awaiting-user claude flow",
      state: claudeStartResult?.state ?? null,
    });
    note(
      "complete-claude-invalid",
      true,
      "skipped: start state " + String(claudeStartResult?.state ?? null),
    );
    note(
      "complete-claude-malformed",
      true,
      "skipped: no awaiting-user claude flow",
    );
    note("cancel-claude", true, "skipped: no awaiting-user claude flow");
  }

  const afterClaude = await rpc(CLAUDE_PLUGIN_ID, "subscription.status");
  writeJson(join(proofDir, "status-after-claude.json"), afterClaude);
  note("status-after-claude", rpcOk(afterClaude), `HTTP ${afterClaude.status}`);
  const afterCodex = await rpc(CODEX_PLUGIN_ID, "subscription.status");
  writeJson(join(proofDir, "status-after-codex.json"), afterCodex);
  note(
    "status-after-codex",
    rpcOk(afterCodex) && afterCodex.body.result.loggedIn === false,
    `HTTP ${afterCodex.status}`,
  );
  const summary = {
    proofDir,
    serverUrl: state.serverUrl,
    secretHandling:
      "invalid token sent but never written to proof; request bodies stored redacted",
    checks,
    pass,
  };
  writeJson(join(proofDir, "drive-auth.json"), summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!pass) {
    throw new Error("drive-auth failed");
  }
}

const VPS_HOST = "152.53.82.126";
const VPS_DOMAIN = "https://repile.rizamaulana.com";
const VPS_LOOPBACK = "http://127.0.0.1:38886";
const VPS_SSH_TIMEOUT_MS = 120000;

function runSsh(script, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        `root@${VPS_HOST}`,
        script,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
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
    }, timeoutMs ?? VPS_SSH_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

function newProofDir(root, prefix) {
  const runId = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const proofDir = join(root, "proof", runId);
  mkdirSync(proofDir, { recursive: true });
  return proofDir;
}

async function cmdVpsDoctor(root) {
  const proofDir = newProofDir(root, "vps-doctor");
  const checks = [];
  let pass = true;
  const note = (name, ok, detail) => {
    if (!checkRecord(checks, name, ok, detail)) {
      pass = false;
    }
  };
  const services = await runSsh(
    "systemctl is-active repile.service caddy.service",
  );
  writeText(
    join(proofDir, "vps-services.txt"),
    `$ systemctl is-active\nexit ${String(services.exitCode)}\n${services.stdout}${services.stderr}`,
  );
  note(
    "vps-services",
    services.exitCode === 0 && services.stdout.includes("active"),
    `exit ${String(services.exitCode)}`,
  );
  const loopback = await runSsh(
    `curl -s -o /dev/null -w "%{http_code}" ${VPS_LOOPBACK}/; curl -s ${VPS_LOOPBACK}/ | grep -o "<title>[^<]*</title>"`,
  );
  writeText(
    join(proofDir, "vps-loopback.txt"),
    `$ loopback check\nexit ${String(loopback.exitCode)}\n${loopback.stdout}${loopback.stderr}`,
  );
  note(
    "vps-loopback",
    loopback.stdout.includes("200") &&
      loopback.stdout.includes("<title>Repile</title>"),
    loopback.stdout.trim().split("\n").join(" "),
  );
  const plugin = await runSsh(
    `for id in ${BUNDLED_PLUGIN_IDS.join(" ")}; do curl -s -X POST "${VPS_LOOPBACK}/api/v1/plugins/$id/rpc/subscription.status" -H 'content-type: application/json' -d 'null'; echo; done`,
  );
  writeText(
    join(proofDir, "vps-plugin-status.txt"),
    `$ loopback rpc subscription.status for ${BUNDLED_PLUGIN_IDS.join(", ")}\nexit ${String(plugin.exitCode)}\n${plugin.stdout}${plugin.stderr}`,
  );
  let pluginOk = plugin.exitCode === 0;
  try {
    const lines = plugin.stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    pluginOk =
      pluginOk &&
      lines.length === BUNDLED_PLUGIN_IDS.length &&
      lines.every((line) => {
        const parsed = JSON.parse(line);
        return (
          parsed.ok === true && typeof parsed.result?.loggedIn === "boolean"
        );
      });
  } catch {
    pluginOk = false;
  }
  note("vps-plugin-status", pluginOk, `exit ${String(plugin.exitCode)}`);
  const pub = await fetchJson(VPS_DOMAIN, {}, HTTP_TIMEOUT_MS);
  writeJson(join(proofDir, "vps-public.json"), pub);
  note("vps-public-401", pub.status === 401, `HTTP ${String(pub.status)}`);
  const summary = { proofDir, host: VPS_HOST, checks, pass };
  writeJson(join(proofDir, "vps-doctor.json"), summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!pass) {
    throw new Error("vps-doctor failed");
  }
}

async function cmdVpsDriveAuth(root) {
  const proofDir = newProofDir(root, "vps-drive");
  const checks = [];
  let pass = true;
  const note = (name, ok, detail) => {
    if (!checkRecord(checks, name, ok, detail)) {
      pass = false;
    }
  };
  const rpc = (pluginId, method, body) =>
    runSsh(
      `curl -s -X POST "${VPS_LOOPBACK}/api/v1/plugins/${pluginId}/rpc/${method}" -H 'content-type: application/json' -d '${body}'`,
    );
  const parse = (raw) => {
    try {
      return JSON.parse(raw.stdout.trim());
    } catch {
      return null;
    }
  };
  const rpcOk = (parsed) =>
    parsed !== null &&
    parsed.ok === true &&
    parsed.result !== null &&
    typeof parsed.result === "object";

  const claudeStatus = parse(
    await rpc(CLAUDE_PLUGIN_ID, "subscription.status", "null"),
  );
  writeJson(join(proofDir, "vps-status-claude.json"), claudeStatus);
  note(
    "vps-status-claude",
    rpcOk(claudeStatus) && typeof claudeStatus.result.loggedIn === "boolean",
    `loggedIn ${String(claudeStatus?.result?.loggedIn)}`,
  );
  const codexStatus = parse(
    await rpc(CODEX_PLUGIN_ID, "subscription.status", "null"),
  );
  writeJson(join(proofDir, "vps-status-codex.json"), codexStatus);
  note(
    "vps-status-codex",
    rpcOk(codexStatus) && typeof codexStatus.result.loggedIn === "boolean",
    `loggedIn ${String(codexStatus?.result?.loggedIn)}`,
  );

  const start = parse(
    await rpc(CLAUDE_PLUGIN_ID, "subscription.start", "null"),
  );
  writeJson(join(proofDir, "vps-start-claude.json"), start);
  const startOk =
    rpcOk(start) &&
    (start.result.state === "awaiting-user" ||
      start.result.state === "completed") &&
    (start.result.state === "completed" ||
      (typeof start.result.authorizeUrl === "string" &&
        start.result.authorizeUrl.startsWith("https://")));
  note("vps-start-claude", startOk, `state ${String(start?.result?.state)}`);
  if (rpcOk(start) && start.result.state === "awaiting-user") {
    const complete = parse(
      await rpc(
        CLAUDE_PLUGIN_ID,
        "subscription.complete",
        `{"sessionId":"${start.result.sessionId}","code":"${INVALID_SECRET}"}`,
      ),
    );
    writeJson(join(proofDir, "vps-complete-invalid.json"), {
      request: { sessionId: "***redacted***", code: "***redacted***" },
      response: complete,
    });
    note(
      "vps-complete-invalid",
      complete !== null &&
        complete.ok === false &&
        typeof complete.error?.message === "string" &&
        complete.error.message.length > 0,
      `ok ${String(complete?.ok)} error ${String(complete?.error?.message ?? "").slice(0, 80)}`,
    );
    const restart = parse(
      await rpc(CLAUDE_PLUGIN_ID, "subscription.start", "null"),
    );
    if (rpcOk(restart) && restart.result.state === "awaiting-user") {
      const cancel = parse(
        await rpc(
          CLAUDE_PLUGIN_ID,
          "subscription.cancel",
          `{"sessionId":"${restart.result.sessionId}"}`,
        ),
      );
      writeJson(join(proofDir, "vps-cancel-claude.json"), cancel);
      note(
        "vps-cancel-claude",
        rpcOk(cancel) && cancel.result.cancelled === true,
        `ok ${String(cancel?.ok)}`,
      );
    } else {
      note(
        "vps-cancel-claude",
        true,
        "skipped: no awaiting-user claude flow on restart",
      );
    }
  } else {
    note("vps-complete-invalid", true, "skipped: no awaiting-user claude flow");
    note("vps-cancel-claude", true, "skipped: no awaiting-user claude flow");
  }

  const codexStart = parse(
    await rpc(CODEX_PLUGIN_ID, "subscription.start", "null"),
  );
  writeJson(join(proofDir, "vps-start-codex.json"), codexStart);
  note(
    "vps-start-codex",
    rpcOk(codexStart) &&
      (codexStart.result.state === "awaiting-user" ||
        codexStart.result.state === "completed"),
    `state ${String(codexStart?.result?.state)}`,
  );
  if (rpcOk(codexStart) && codexStart.result.state === "awaiting-user") {
    const poll = parse(
      await rpc(
        CODEX_PLUGIN_ID,
        "subscription.poll",
        `{"sessionId":"${codexStart.result.sessionId}"}`,
      ),
    );
    writeJson(join(proofDir, "vps-poll-codex.json"), poll);
    const pollState = poll?.result?.state;
    note(
      "vps-poll-codex",
      rpcOk(poll) &&
        (pollState === "pending" ||
          pollState === "failed" ||
          pollState === "completed"),
      `state ${String(pollState)}`,
    );
    const cancel = parse(
      await rpc(
        CODEX_PLUGIN_ID,
        "subscription.cancel",
        `{"sessionId":"${codexStart.result.sessionId}"}`,
      ),
    );
    writeJson(join(proofDir, "vps-cancel-codex.json"), cancel);
    note(
      "vps-cancel-codex",
      rpcOk(cancel) && cancel.result.cancelled === true,
      `ok ${String(cancel?.ok)}`,
    );
  } else {
    note("vps-poll-codex", true, "skipped: no awaiting-user codex flow");
    note("vps-cancel-codex", true, "skipped: no awaiting-user codex flow");
  }

  const summary = {
    proofDir,
    host: VPS_HOST,
    secretHandling:
      "invalid token sent but never written to proof; request bodies stored redacted",
    checks,
    pass,
  };
  writeJson(join(proofDir, "vps-drive-auth.json"), summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!pass) {
    throw new Error("vps-drive-auth failed");
  }
}

async function cmdCleanup(state) {
  const proofDir = state.proofDir;
  for (const entry of [
    { label: "server.log", from: state.serverLog },
    { label: "app.log", from: state.appLog },
  ]) {
    try {
      copyFileSync(entry.from, join(proofDir, entry.label));
    } catch {
      writeText(
        join(proofDir, entry.label),
        `log unavailable at ${entry.from}\n`,
      );
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
    stopped.push({
      service: "scratch",
      action: error instanceof Error ? error.message : String(error),
    });
  }
  const report = {
    proofDir,
    stopped,
    scratchRemoved,
    cleanedAt: new Date().toISOString(),
  };
  writeJson(join(proofDir, "cleanup.json"), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "launch") {
    await cmdLaunch(args.root);
    return;
  }
  if (args.command === "vps-doctor") {
    await cmdVpsDoctor(args.root);
    return;
  }
  if (args.command === "vps-drive-auth") {
    await cmdVpsDriveAuth(args.root);
    return;
  }
  const statePath = resolveStatePath(args.state);
  const state = readState(statePath);
  if (args.command === "doctor") {
    await cmdDoctor(state, statePath);
  } else if (args.command === "drive-auth") {
    await cmdDriveAuth(state);
  } else if (args.command === "cleanup") {
    await cmdCleanup(state);
  } else {
    throw new Error(`unknown command: ${args.command}\n${usage()}`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
