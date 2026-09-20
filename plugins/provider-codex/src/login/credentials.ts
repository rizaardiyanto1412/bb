import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SubscriptionStatus } from "../../contract.js";
import { readCodexAuthFile } from "../ai/codex-auth.js";
import { resolveCodexHome } from "../codex-home.js";
import { codexJwtExpiryMs, type CodexTokenSet } from "./device-login.js";

const AUTH_FILE_NAME = "auth.json";
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";

const SIGNED_OUT: SubscriptionStatus = {
  loggedIn: false,
  mode: null,
  planLabel: null,
  accountEmail: null,
  expiresAt: null,
};

export function codexAuthPath(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return path.join(resolveCodexHome(homeDir, env), AUTH_FILE_NAME);
}

export function codexPlanLabel(planType: string | null): string | null {
  if (planType === null) return null;
  const normalized = planType.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const labels: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
  };
  return (
    labels[normalized] ??
    normalized.charAt(0).toUpperCase() + normalized.slice(1)
  );
}

function idTokenPlanType(idToken: string | null): string | null {
  if (idToken === null) return null;
  const payloadSegment = idToken.split(".")[1];
  if (payloadSegment === undefined) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    );
    if (payload === null || typeof payload !== "object") return null;
    const direct = Reflect.get(payload, "chatgpt_plan_type");
    if (typeof direct === "string" && direct.length > 0) return direct;
    const authClaim = Reflect.get(payload, CHATGPT_AUTH_CLAIM);
    if (authClaim !== null && typeof authClaim === "object") {
      const plan = Reflect.get(authClaim, "chatgpt_plan_type");
      if (typeof plan === "string" && plan.length > 0) return plan;
    }
  } catch {}
  return null;
}

async function readRawAuthFile(authPath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(authPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeAuthFile(authPath: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(authPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(authPath, `${body}\n`, { mode: 0o600 });
}

export async function readSubscriptionStatus(
  homeDir: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SubscriptionStatus> {
  const auth = await readCodexAuthFile(homeDir, env);
  if (auth.state !== "ok") return SIGNED_OUT;
  const credentials = auth.credentials;
  if (credentials.type === "apiKey") {
    return {
      loggedIn: true,
      mode: "apiKey",
      planLabel: null,
      accountEmail: null,
      expiresAt: null,
    };
  }
  const authPath = codexAuthPath(homeDir, env);
  const raw = await readRawAuthFile(authPath);
  const idToken =
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Reflect.get(raw, "tokens") !== null &&
    typeof Reflect.get(raw, "tokens") === "object"
      ? Reflect.get(Reflect.get(raw, "tokens") as object, "id_token")
      : null;
  return {
    loggedIn: true,
    mode: "chatgpt",
    planLabel: codexPlanLabel(
      idTokenPlanType(typeof idToken === "string" ? idToken : null),
    ),
    accountEmail: credentials.accountEmail,
    expiresAt: codexJwtExpiryMs(credentials.accessToken),
  };
}

export async function writeCodexTokens(
  tokens: CodexTokenSet,
  homeDir: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  await writeAuthFile(
    codexAuthPath(homeDir, env),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        account_id: tokens.accountId,
      },
      last_refresh: new Date().toISOString(),
    }),
  );
}

export async function writeCodexApiKey(
  apiKey: string,
  homeDir: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  await writeAuthFile(
    codexAuthPath(homeDir, env),
    JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: apiKey,
      tokens: null,
      last_refresh: new Date().toISOString(),
    }),
  );
}

export async function clearCredentials(
  homeDir: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  await fs.rm(codexAuthPath(homeDir, env), { force: true });
}
