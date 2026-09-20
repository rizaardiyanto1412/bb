import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { SubscriptionStatus } from "../../contract.js";
import { OAUTH_SCOPE_LIST, type ClaudeOAuthAccount } from "./oauth-login.js";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_DIR_NAME = ".claude";
const CREDENTIALS_FILE_NAME = ".credentials.json";
const ACCOUNT_FILE_NAME = ".claude.json";

const claudeCredentialsFileSchema = z
  .object({
    claudeAiOauth: z
      .object({
        accessToken: z.string().min(1),
        expiresAt: z.number().nullish(),
        subscriptionType: z.string().nullish(),
        rateLimitTier: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

const claudeAccountFileSchema = z.object({
  oauthAccount: z
    .object({
      emailAddress: z.string().email().nullish(),
      accountUuid: z.string().uuid().nullish(),
    })
    .nullish(),
});

export interface ClaudeCredentialsView {
  accessToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

function parseCredentialsCandidate(
  candidate: string,
): ClaudeCredentialsView | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch {
    return null;
  }
  const parsed = claudeCredentialsFileSchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  const oauth = parsed.data.claudeAiOauth;
  return {
    accessToken: oauth.accessToken,
    expiresAt: oauth.expiresAt ?? null,
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? null,
  };
}

function hexToUtf8(hex: string): string | null {
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function parseClaudeCredentialsFile(
  raw: string,
): ClaudeCredentialsView | null {
  const trimmed = raw.trim();
  const direct = parseCredentialsCandidate(trimmed);
  if (direct !== null) return direct;
  if (/^(?:[0-9a-f]{2})+$/iu.test(trimmed)) {
    const decoded = hexToUtf8(trimmed);
    if (decoded !== null) return parseCredentialsCandidate(decoded);
  }
  return null;
}

export function claudePlanLabel(
  credentials: Pick<
    ClaudeCredentialsView,
    "subscriptionType" | "rateLimitTier"
  >,
): string | null {
  const maxMatch = (credentials.rateLimitTier ?? "").match(/max_(\d+)x/u);
  if (maxMatch) return `Max (${maxMatch[1]}x)`;
  const subscription = credentials.subscriptionType;
  return subscription
    ? subscription.charAt(0).toUpperCase() + subscription.slice(1)
    : null;
}

export function parseClaudeAccountEmail(raw: string): string | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = claudeAccountFileSchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  return parsed.data.oauthAccount?.emailAddress ?? null;
}

function credentialsPath(homeDir: string): string {
  return path.join(homeDir, CLAUDE_DIR_NAME, CREDENTIALS_FILE_NAME);
}

function accountPath(homeDir: string): string {
  return path.join(homeDir, ACCOUNT_FILE_NAME);
}

async function readKeychainCredentials(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const username = os.userInfo().username;
  const argumentSets = [
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", username, "-w"],
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
  ];
  for (const args of argumentSets) {
    try {
      const result = await execFileAsync("security", args, { timeout: 10_000 });
      if (result.stdout.trim()) return result.stdout.trim();
    } catch {}
  }
  return null;
}

async function writeKeychainCredentials(raw: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const username = os.userInfo().username;
  try {
    await execFileAsync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        username,
        "-w",
        raw,
      ],
      { timeout: 10_000 },
    );
  } catch {}
}

async function deleteKeychainCredentials(): Promise<void> {
  if (process.platform !== "darwin") return;
  const username = os.userInfo().username;
  const argumentSets = [
    ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", username],
    ["delete-generic-password", "-s", KEYCHAIN_SERVICE],
  ];
  for (const args of argumentSets) {
    try {
      await execFileAsync("security", args, { timeout: 10_000 });
    } catch {}
  }
}

async function readFileCredentials(homeDir: string): Promise<string | null> {
  try {
    return await fs.readFile(credentialsPath(homeDir), "utf8");
  } catch {
    return null;
  }
}

async function readStoredCredentials(
  homeDir: string,
): Promise<ClaudeCredentialsView | null> {
  const keychain = await readKeychainCredentials();
  const fromKeychain =
    keychain === null ? null : parseClaudeCredentialsFile(keychain);
  if (fromKeychain !== null) return fromKeychain;
  const file = await readFileCredentials(homeDir);
  return file === null ? null : parseClaudeCredentialsFile(file);
}

async function readAccountEmail(homeDir: string): Promise<string | null> {
  try {
    return parseClaudeAccountEmail(
      await fs.readFile(accountPath(homeDir), "utf8"),
    );
  } catch {
    return null;
  }
}

async function readJsonFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {}
  return {};
}

async function writeFile(filePath: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, body, { mode: 0o600 });
}

export async function readSubscriptionStatus(
  homeDir: string = os.homedir(),
): Promise<SubscriptionStatus> {
  const credentials = await readStoredCredentials(homeDir);
  if (credentials === null) {
    return {
      loggedIn: false,
      planLabel: null,
      accountEmail: null,
      expiresAt: null,
    };
  }
  return {
    loggedIn: true,
    planLabel: claudePlanLabel(credentials),
    accountEmail: await readAccountEmail(homeDir),
    expiresAt: credentials.expiresAt,
  };
}

export async function writeCredentials(
  account: ClaudeOAuthAccount,
  homeDir: string = os.homedir(),
): Promise<void> {
  const body = JSON.stringify(
    {
      claudeAiOauth: {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        expiresAt: account.expiresAt,
        scopes: OAUTH_SCOPE_LIST,
        subscriptionType: account.subscriptionType,
        rateLimitTier: account.rateLimitTier,
      },
    },
    null,
    2,
  );
  await writeFile(credentialsPath(homeDir), `${body}\n`);
  await writeKeychainCredentials(body);
  const settings = await readJsonFile(accountPath(homeDir));
  const existingAccount =
    settings.oauthAccount !== null &&
    typeof settings.oauthAccount === "object" &&
    !Array.isArray(settings.oauthAccount)
      ? (settings.oauthAccount as Record<string, unknown>)
      : {};
  settings.hasCompletedOnboarding = true;
  settings.oauthAccount = {
    ...existingAccount,
    emailAddress: account.email,
    accountUuid: account.accountUuid,
  };
  await writeFile(accountPath(homeDir), `${JSON.stringify(settings)}\n`);
}

export async function clearCredentials(
  homeDir: string = os.homedir(),
): Promise<void> {
  const file = await readJsonFile(credentialsPath(homeDir));
  delete file.claudeAiOauth;
  if (Object.keys(file).length === 0) {
    await fs.rm(credentialsPath(homeDir), { force: true });
  } else {
    await writeFile(credentialsPath(homeDir), `${JSON.stringify(file)}\n`);
  }
  await deleteKeychainCredentials();
  const settings = await readJsonFile(accountPath(homeDir));
  if ("oauthAccount" in settings) {
    delete settings.oauthAccount;
    await writeFile(accountPath(homeDir), `${JSON.stringify(settings)}\n`);
  }
}
