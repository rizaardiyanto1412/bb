import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  cliCommand,
  defineCli,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  AUTH_REALTIME_CHANNEL,
  classifyCodexAuthJson,
  claudePlanLabel,
  completeRequestSchema,
  extractAuthorizeUrl,
  lastOutputLine,
  loginSessionSchema,
  parseClaudeAccountEmail,
  parseClaudeCredentialsFile,
  providerSchema,
  providerStatusSchema,
  ROUTES,
  startRequestSchema,
  type AuthChangedPayload,
  type LoginSession,
  type LoginSessionState,
  type ProviderId,
  type ProviderStatus,
} from "./contract.js";

const execFileAsync = promisify(execFile);

const SETUP_TOKEN_URL_TIMEOUT_MS = 30_000;
const LOGIN_EXIT_TIMEOUT_MS = 60_000;
const FLOW_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_SESSION_TTL_MS = 5 * 60_000;
const PRUNE_INTERVAL_MS = 30_000;
const CHILD_OUTPUT_MAX_CHARS = 64_000;
const ERROR_DETAIL_MAX_CHARS = 300;

const CLAUDE_COMMAND = "claude";
const CODEX_COMMAND = "codex";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

interface FlowSession {
  record: LoginSession;
  child: ChildProcess | null;
  output: string;
  updatedAt: number;
}

function terminalRecord(
  provider: ProviderId,
  state: Extract<LoginSessionState, "completed" | "failed">,
  error: string | null,
): LoginSession {
  return loginSessionSchema.parse({
    provider,
    state,
    url: null,
    error,
  });
}

function stopChild(child: ChildProcess | null): void {
  if (child === null || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    child.kill("SIGKILL");
  } catch {}
}

function appendOutput(session: FlowSession, chunk: string): void {
  session.output = `${session.output}${chunk}`.slice(-CHILD_OUTPUT_MAX_CHARS);
}

function redactSecret(output: string, secret: string): string {
  if (secret.length < 4) return output;
  return output.split(secret).join("[redacted]");
}

function childErrorDetail(output: string, exitCode: number | null): string {
  const detail = lastOutputLine(output, ERROR_DETAIL_MAX_CHARS);
  if (detail !== null) return detail;
  return exitCode === null ? "login process ended" : `exit code ${exitCode}`;
}

async function readClaudeKeychainCredentials(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const argumentSets = [
    [
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-a",
      os.userInfo().username,
      "-w",
    ],
    ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
  ];
  for (const args of argumentSets) {
    try {
      const { stdout } = await execFileAsync("security", args, {
        timeout: 10_000,
      });
      if (stdout.trim()) return stdout.trim();
    } catch {}
  }
  return null;
}

async function readClaudeAccountEmail(): Promise<string | null> {
  try {
    return parseClaudeAccountEmail(
      await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

async function readClaudeStatus(): Promise<ProviderStatus> {
  const loggedOut: ProviderStatus = providerStatusSchema.parse({
    provider: "claude",
    loggedIn: false,
    planLabel: null,
    expiresAt: null,
    accountEmail: null,
  });
  const keychainRaw = await readClaudeKeychainCredentials();
  const keychainCredentials =
    keychainRaw === null ? null : parseClaudeCredentialsFile(keychainRaw);
  let fileCredentials = null;
  try {
    fileCredentials = parseClaudeCredentialsFile(
      await fs.readFile(
        path.join(os.homedir(), ".claude", ".credentials.json"),
        "utf8",
      ),
    );
  } catch {}
  const credentials = keychainCredentials ?? fileCredentials;
  if (credentials === null) return loggedOut;
  const [email] = await Promise.all([readClaudeAccountEmail()]);
  const expired =
    credentials.expiresAt !== null && Date.now() >= credentials.expiresAt;
  return providerStatusSchema.parse({
    provider: "claude",
    loggedIn: !expired,
    planLabel: claudePlanLabel(credentials),
    expiresAt: credentials.expiresAt,
    accountEmail: email,
  });
}

function resolveCodexHome(): string {
  const override = process.env.CODEX_HOME?.trim();
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), ".codex");
}

async function readCodexStatus(): Promise<ProviderStatus> {
  const loggedOut: ProviderStatus = providerStatusSchema.parse({
    provider: "codex",
    loggedIn: false,
    planLabel: null,
    expiresAt: null,
    accountEmail: null,
  });
  let raw: string;
  try {
    raw = await fs.readFile(
      path.join(resolveCodexHome(), "auth.json"),
      "utf8",
    );
  } catch {
    return loggedOut;
  }
  const auth = classifyCodexAuthJson(raw);
  if (auth === null) return loggedOut;
  if (auth.kind === "apiKey") {
    return providerStatusSchema.parse({
      provider: "codex",
      loggedIn: true,
      planLabel: null,
      expiresAt: null,
      accountEmail: null,
    });
  }
  return providerStatusSchema.parse({
    provider: "codex",
    loggedIn: !auth.expired,
    planLabel: null,
    expiresAt: auth.expiresAtMs,
    accountEmail: auth.accountEmail,
  });
}

async function readStatus(provider: ProviderId): Promise<ProviderStatus> {
  return provider === "claude" ? readClaudeStatus() : readCodexStatus();
}

function waitForClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = (exitCode: number | null, timedOut: boolean): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ exitCode, timedOut });
    };
    timer = setTimeout(() => {
      stopChild(child);
      done(null, true);
    }, timeoutMs);
    timer.unref();
    child.once("close", (code) => done(code, false));
    child.once("error", () => done(null, false));
  });
}

function waitForSetupTokenUrl(
  child: ChildProcess,
  session: FlowSession,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const done = (url: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      resolve(url);
    };
    const onData = (chunk: Buffer | string): void => {
      appendOutput(session, chunk.toString());
      const found = extractAuthorizeUrl(session.output);
      if (found !== null) done(found);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    timer = setTimeout(() => {
      stopChild(child);
      done(extractAuthorizeUrl(session.output));
    }, timeoutMs);
    timer.unref();
    child.once("close", () => done(extractAuthorizeUrl(session.output)));
    child.once("error", (error: unknown) => {
      appendOutput(
        session,
        error instanceof Error ? error.message : String(error),
      );
      done(null);
    });
  });
}

export default async function plugin(bb: BbPluginApi) {
  const sessions = new Map<ProviderId, FlowSession>();

  function publish(provider: ProviderId, state: string): void {
    const payload: AuthChangedPayload = { provider, state };
    bb.realtime.publish(AUTH_REALTIME_CHANNEL, payload);
  }

  function storeTerminal(
    provider: ProviderId,
    state: Extract<LoginSessionState, "completed" | "failed">,
    error: string | null,
  ): LoginSession {
    const previous = sessions.get(provider);
    stopChild(previous?.child ?? null);
    const record = terminalRecord(provider, state, error);
    sessions.set(provider, {
      record,
      child: null,
      output: "",
      updatedAt: Date.now(),
    });
    publish(provider, state);
    return record;
  }

  function failStale(provider: ProviderId, error: string): LoginSession {
    return storeTerminal(provider, "failed", error);
  }

  async function startClaude(): Promise<LoginSession> {
    const current = await readClaudeStatus();
    if (current.loggedIn) return storeTerminal("claude", "completed", null);
    stopChild(sessions.get("claude")?.child ?? null);
    let child: ChildProcess;
    try {
      child = spawn(CLAUDE_COMMAND, ["setup-token"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return failStale(
        "claude",
        error instanceof Error ? error.message : String(error),
      );
    }
    const session: FlowSession = {
      record: loginSessionSchema.parse({
        provider: "claude",
        state: "awaiting-user",
        url: null,
        error: null,
      }),
      child,
      output: "",
      updatedAt: Date.now(),
    };
    sessions.set("claude", session);
    const url = await waitForSetupTokenUrl(
      child,
      session,
      SETUP_TOKEN_URL_TIMEOUT_MS,
    );
    if (url === null || child.exitCode !== null) {
      const detail = childErrorDetail(session.output, child.exitCode);
      stopChild(child);
      return failStale(
        "claude",
        `claude setup-token ended before printing an authorize URL (${detail})`,
      );
    }
    session.record = loginSessionSchema.parse({
      provider: "claude",
      state: "awaiting-user",
      url,
      error: null,
    });
    session.updatedAt = Date.now();
    publish("claude", "awaiting-user");
    return session.record;
  }

  async function completeClaude(token: string): Promise<LoginSession> {
    const session = sessions.get("claude");
    const child = session?.child ?? null;
    if (
      session === undefined ||
      session.record.state !== "awaiting-user" ||
      child === null ||
      child.exitCode !== null ||
      child.stdin === null ||
      child.stdin.destroyed
    ) {
      return failStale("claude", "start a Claude login flow first");
    }
    try {
      child.stdin.write(`${token}\n`);
      child.stdin.end();
    } catch (error) {
      return failStale(
        "claude",
        error instanceof Error ? error.message : String(error),
      );
    }
    const { exitCode, timedOut } = await waitForClose(
      child,
      LOGIN_EXIT_TIMEOUT_MS,
    );
    const redacted = redactSecret(session.output, token);
    if (timedOut) {
      return failStale("claude", "claude setup-token timed out");
    }
    if (exitCode !== 0) {
      return failStale(
        "claude",
        `claude setup-token failed (${childErrorDetail(redacted, exitCode)})`,
      );
    }
    const status = await readClaudeStatus();
    if (!status.loggedIn) {
      return failStale(
        "claude",
        "claude setup-token exited but no credentials were found",
      );
    }
    return storeTerminal("claude", "completed", null);
  }

  async function probeExecutable(command: string): Promise<boolean> {
    try {
      await execFileAsync(command, ["--version"], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  async function startCodex(): Promise<LoginSession> {
    const current = await readCodexStatus();
    if (current.loggedIn) return storeTerminal("codex", "completed", null);
    if (!(await probeExecutable(CODEX_COMMAND))) {
      return failStale(
        "codex",
        "codex CLI was not found on the bb server host",
      );
    }
    stopChild(sessions.get("codex")?.child ?? null);
    const record = loginSessionSchema.parse({
      provider: "codex",
      state: "awaiting-user",
      url: null,
      error: null,
    });
    sessions.set("codex", {
      record,
      child: null,
      output: "",
      updatedAt: Date.now(),
    });
    publish("codex", "awaiting-user");
    return record;
  }

  async function completeCodex(apiKey: string): Promise<LoginSession> {
    stopChild(sessions.get("codex")?.child ?? null);
    let child: ChildProcess;
    try {
      child = spawn(CODEX_COMMAND, ["login", "--with-api-key"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return failStale(
        "codex",
        error instanceof Error ? error.message : String(error),
      );
    }
    const session: FlowSession = {
      record: loginSessionSchema.parse({
        provider: "codex",
        state: "awaiting-user",
        url: null,
        error: null,
      }),
      child,
      output: "",
      updatedAt: Date.now(),
    };
    sessions.set("codex", session);
    child.stdout?.on("data", (chunk: Buffer | string) =>
      appendOutput(session, chunk.toString()),
    );
    child.stderr?.on("data", (chunk: Buffer | string) =>
      appendOutput(session, chunk.toString()),
    );
    child.once("error", (error: unknown) =>
      appendOutput(
        session,
        error instanceof Error ? error.message : String(error),
      ),
    );
    if (child.stdin === null || child.stdin.destroyed) {
      return failStale("codex", "codex login process has no stdin");
    }
    try {
      child.stdin.write(`${apiKey}\n`);
      child.stdin.end();
    } catch (error) {
      return failStale(
        "codex",
        error instanceof Error ? error.message : String(error),
      );
    }
    const { exitCode, timedOut } = await waitForClose(
      child,
      LOGIN_EXIT_TIMEOUT_MS,
    );
    const redacted = redactSecret(session.output, apiKey);
    if (timedOut) {
      return failStale("codex", "codex login timed out");
    }
    if (exitCode !== 0) {
      return failStale(
        "codex",
        `codex login failed (${childErrorDetail(redacted, exitCode)})`,
      );
    }
    const status = await readCodexStatus();
    if (!status.loggedIn) {
      return failStale(
        "codex",
        "codex login exited but no credentials were found",
      );
    }
    return storeTerminal("codex", "completed", null);
  }

  async function readHttpInput<Schema extends z.ZodType>(
    context: Parameters<Parameters<BbPluginApi["http"]["route"]>[2]>[0],
    schema: Schema,
  ): Promise<
    { ok: true; value: z.output<Schema> } | { ok: false; response: Response }
  > {
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return {
        ok: false,
        response: context.json(
          { error: { code: "invalid_json", message: "body must be JSON" } },
          400,
        ),
      };
    }
    const result = await schema.safeParseAsync(input);
    if (result.success) return { ok: true, value: result.data };
    return {
      ok: false,
      response: context.json(
        {
          error: {
            code: "invalid_input",
            message:
              result.error.issues[0]?.message ?? "request failed validation",
          },
        },
        400,
      ),
    };
  }

  bb.http.route(
    "POST",
    ROUTES.start,
    async (context) => {
      const input = await readHttpInput(context, startRequestSchema);
      if (!input.ok) return input.response;
      try {
        const record =
          input.value.provider === "claude"
            ? await startClaude()
            : await startCodex();
        return context.json(record);
      } catch (error) {
        const record = failStale(
          input.value.provider,
          error instanceof Error ? error.message : String(error),
        );
        return context.json(record, 500);
      }
    },
    { auth: "local" },
  );

  bb.http.route(
    "POST",
    ROUTES.complete,
    async (context) => {
      const input = await readHttpInput(context, completeRequestSchema);
      if (!input.ok) return input.response;
      const secret = input.value.tokenOrKey;
      try {
        const record =
          input.value.provider === "claude"
            ? await completeClaude(secret)
            : await completeCodex(secret);
        return context.json(record);
      } catch (error) {
        const record = failStale(
          input.value.provider,
          error instanceof Error ? error.message : String(error),
        );
        return context.json(record, 500);
      }
    },
    { auth: "local" },
  );

  bb.http.route(
    "GET",
    ROUTES.status,
    async (context) => {
      const parsed = providerSchema.safeParse(
        context.req.query("provider") ?? undefined,
      );
      if (!parsed.success) {
        return context.json(
          {
            error: {
              code: "invalid_input",
              message: "query param provider must be claude or codex",
            },
          },
          400,
        );
      }
      return context.json(await readStatus(parsed.data));
    },
    { auth: "local" },
  );

  bb.http.route(
    "DELETE",
    ROUTES.login,
    async (context) => {
      const parsed = providerSchema.safeParse(
        context.req.query("provider") ?? undefined,
      );
      if (!parsed.success) {
        return context.json(
          {
            error: {
              code: "invalid_input",
              message: "query param provider must be claude or codex",
            },
          },
          400,
        );
      }
      const session = sessions.get(parsed.data);
      stopChild(session?.child ?? null);
      sessions.delete(parsed.data);
      publish(parsed.data, "cancelled");
      return context.json({ provider: parsed.data, cancelled: true });
    },
    { auth: "local" },
  );

  bb.background.service("provider-auth", {
    async start(signal) {
      try {
        while (!signal.aborted) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, PRUNE_INTERVAL_MS);
            timer.unref();
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          if (signal.aborted) break;
          const now = Date.now();
          for (const [provider, session] of sessions) {
            const age = now - session.updatedAt;
            if (
              session.record.state === "awaiting-user" &&
              age > FLOW_TIMEOUT_MS
            ) {
              storeTerminal(provider, "failed", "login flow timed out");
            } else if (
              session.record.state !== "awaiting-user" &&
              age > TERMINAL_SESSION_TTL_MS
            ) {
              sessions.delete(provider);
            }
          }
        }
      } finally {
        for (const session of sessions.values()) stopChild(session.child);
      }
    },
  });

  bb.onDispose(() => {
    for (const session of sessions.values()) stopChild(session.child);
  });

  bb.cli.register(
    defineCli({
      name: "provider-auth",
      summary: "Check provider CLI login state on this host",
      description:
        "Reads the same credential files the provider plugins read. Never prints tokens or keys.",
      commands: {
        status: cliCommand({
          summary: "Show Claude and Codex login state",
          options: {
            provider: {
              type: "enum",
              values: ["claude", "codex"],
              description: "Only show one provider",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          run: async (input) => {
            const selected =
              input.options.provider === undefined
                ? (["claude", "codex"] as const)
                : [input.options.provider] as const;
            const statuses: ProviderStatus[] = [];
            for (const provider of selected) {
              statuses.push(await readStatus(provider));
            }
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  input.options.provider === undefined
                    ? statuses
                    : statuses[0],
                ),
              };
            }
            const lines = statuses.map((status) => {
              const state = status.loggedIn ? "logged in" : "logged out";
              const extras = [
                status.planLabel,
                status.accountEmail,
                status.expiresAt === null
                  ? null
                  : `expires ${new Date(status.expiresAt).toISOString()}`,
              ].filter((part): part is string => part !== null);
              return `${status.provider}: ${state}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
            });
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
      },
    }),
  );
}

export const __testing = {
  terminalRecord,
};
