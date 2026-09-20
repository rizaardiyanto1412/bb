import { z } from "zod";

export const PLUGIN_ID = "repile-provider-auth";

export const AUTH_REALTIME_CHANNEL = "auth-changed";

export const ROUTES = {
  start: "/auth/start",
  complete: "/auth/complete",
  status: "/auth/status",
  login: "/auth/login",
} as const;

export const providerSchema = z.enum(["claude", "codex"]);

export type ProviderId = z.infer<typeof providerSchema>;

export const PROVIDERS: readonly ProviderId[] = ["claude", "codex"];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
};

export const loginSessionStateSchema = z.enum([
  "awaiting-user",
  "completed",
  "failed",
]);

export type LoginSessionState = z.infer<typeof loginSessionStateSchema>;

export const loginSessionSchema = z
  .object({
    provider: providerSchema,
    state: loginSessionStateSchema,
    url: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export type LoginSession = z.infer<typeof loginSessionSchema>;

export const startRequestSchema = z
  .object({ provider: providerSchema })
  .strict();

export type StartRequest = z.infer<typeof startRequestSchema>;

export const completeRequestSchema = z
  .object({
    provider: providerSchema,
    tokenOrKey: z.string().min(1).max(8192),
  })
  .strict();

export type CompleteRequest = z.infer<typeof completeRequestSchema>;

export interface NormalizedToken {
  ok: boolean;
  token: string;
  reason: string | null;
}

export function normalizeSetupToken(raw: string): NormalizedToken {
  const token = raw.trim().replace(/\s+/gu, "");
  if (token.length === 0) {
    return { ok: false, token: "", reason: "Paste a value first." };
  }
  if (token.includes("http://") || token.includes("https://")) {
    return {
      ok: false,
      token: "",
      reason: "That looks like the authorize page URL. Paste only the code.",
    };
  }
  return { ok: true, token, reason: null };
}

export const providerStatusSchema = z
  .object({
    provider: providerSchema,
    loggedIn: z.boolean(),
    planLabel: z.string().nullable(),
    expiresAt: z.number().nullable(),
    accountEmail: z.string().nullable(),
  })
  .strict();

export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const authChangedPayloadSchema = z
  .object({ provider: providerSchema, state: z.string().min(1) })
  .strict();

export type AuthChangedPayload = z.infer<typeof authChangedPayloadSchema>;

const AUTHORIZE_URL_PATTERN = /https?:\/\/[^\s"'<>\\]+/u;

const CSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/gu;
const OSC_OPEN_PATTERN = /\u001B\]8;[^;]*;/gu;
const OSC_CLOSE_PATTERN = /\u001B\]8;;(?:\u0007|\u001B\\)/gu;
const BELL_PATTERN = /\u0007/gu;

export function stripAnsi(output: string): string {
  return output
    .replace(OSC_OPEN_PATTERN, "")
    .replace(OSC_CLOSE_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(BELL_PATTERN, "");
}

function dedupeDoubledUrl(url: string): string {
  const half = url.length / 2;
  if (Number.isInteger(half) && url.slice(0, half) === url.slice(half)) {
    return url.slice(0, half);
  }
  return url;
}

export function extractAuthorizeUrl(output: string): string | null {
  const found = AUTHORIZE_URL_PATTERN.exec(stripAnsi(output))?.[0] ?? null;
  return found === null ? null : dedupeDoubledUrl(found);
}

const claudeCredentialsFileSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullish(),
    subscriptionType: z.string().nullish(),
    rateLimitTier: z.string().nullish(),
  }),
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
  credentials: Pick<ClaudeCredentialsView, "subscriptionType" | "rateLimitTier">,
): string | null {
  const maxMatch = (credentials.rateLimitTier ?? "").match(/max_(\d+)x/u);
  if (maxMatch) return `Max (${maxMatch[1]}x)`;
  const subscription = credentials.subscriptionType;
  return subscription
    ? subscription.charAt(0).toUpperCase() + subscription.slice(1)
    : null;
}

const claudeAccountFileSchema = z.object({
  oauthAccount: z
    .object({
      emailAddress: z.string().email().nullish(),
      accountUuid: z.string().uuid().nullish(),
    })
    .nullish(),
});

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

const base64UrlToBase64 = (value: string): string =>
  value.replace(/-/gu, "+").replace(/_/gu, "/");

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return null;
  try {
    const decoded = atob(base64UrlToBase64(payload));
    const value: unknown = JSON.parse(decoded);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function jwtClaimString(
  payload: Record<string, unknown> | null,
  claimPath: string,
): string | null {
  const claim = payload?.[claimPath];
  if (typeof claim === "object" && claim !== null) {
    const nested = (claim as Record<string, unknown>).chatgpt_account_id;
    return typeof nested === "string" && nested.length > 0 ? nested : null;
  }
  return null;
}

export function jwtExpiryMs(token: string): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

export type CodexAuthView =
  | { kind: "apiKey" }
  | {
      kind: "chatgpt";
      accountId: string;
      accountEmail: string | null;
      expired: boolean;
      expiresAtMs: number | null;
    };

const codexAuthFileSchema = z.object({
  auth_mode: z.string().nullish(),
  OPENAI_API_KEY: z.string().nullish(),
  tokens: z
    .object({
      access_token: z.string().nullish(),
      id_token: z.unknown().nullish(),
      account_id: z.string().nullish(),
    })
    .nullish(),
});

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function classifyCodexAuthJson(raw: string): CodexAuthView | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = codexAuthFileSchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  const data = parsed.data;
  const authMode = nonEmptyString(data.auth_mode);
  const apiKey = nonEmptyString(data.OPENAI_API_KEY);
  if (
    authMode === "apikey" ||
    authMode === "apiKey" ||
    (authMode === null && apiKey !== null)
  ) {
    return apiKey === null ? null : { kind: "apiKey" };
  }
  const accessToken = nonEmptyString(data.tokens?.access_token);
  if (accessToken === null) return null;
  const payload = decodeJwtPayload(accessToken);
  const accountId =
    nonEmptyString(data.tokens?.account_id) ??
    jwtClaimString(payload, "https://api.openai.com/auth");
  if (accountId === null) return null;
  const email =
    nonEmptyString(payload?.email) ??
    (() => {
      const profile = payload?.["https://api.openai.com/profile"];
      if (typeof profile === "object" && profile !== null) {
        return nonEmptyString((profile as Record<string, unknown>).email);
      }
      return null;
    })();
  const expiresAtMs = jwtExpiryMs(accessToken);
  return {
    kind: "chatgpt",
    accountId,
    accountEmail: email,
    expired: expiresAtMs !== null && Date.now() >= expiresAtMs,
    expiresAtMs,
  };
}

export function lastOutputLine(output: string, maxChars: number): string | null {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  return last.length > maxChars ? `${last.slice(0, maxChars - 1)}…` : last;
}
