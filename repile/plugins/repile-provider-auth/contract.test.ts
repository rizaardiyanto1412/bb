import { describe, expect, it } from "vitest";
import {
  classifyCodexAuthJson,
  claudePlanLabel,
  extractAuthorizeUrl,
  jwtExpiryMs,
  lastOutputLine,
  parseClaudeAccountEmail,
  parseClaudeCredentialsFile,
  stripAnsi,
} from "./contract.js";

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

describe("extractAuthorizeUrl", () => {
  it("finds the first URL in setup-token output", () => {
    expect(
      extractAuthorizeUrl(
        "go here to authorize:\nhttps://claude.ai/setup-token/abc-123\nwaiting…",
      ),
    ).toBe("https://claude.ai/setup-token/abc-123");
  });

  it("returns null when no URL was printed", () => {
    expect(extractAuthorizeUrl("still starting…\n")).toBeNull();
  });

  it("finds the URL inside Ink TUI escape sequences", () => {
    const framed =
      "\u001B[38;5;246mBrowser didnt open? Use the url below\u001B[39m\n" +
      "\u001B]8;id=x;https://claude.ai/setup-token/tty-1\u0007https://claude.ai/setup-token/tty-1\u001B]8;;\u0007\n";
    expect(stripAnsi(framed)).not.toContain("\u001B");
    expect(extractAuthorizeUrl(framed)).toBe(
      "https://claude.ai/setup-token/tty-1",
    );
  });
});

describe("parseClaudeCredentialsFile", () => {
  it("reads oauth credentials with expiry and plan fields", () => {
    const parsed = parseClaudeCredentialsFile(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok",
          expiresAt: 1788000000000,
          subscriptionType: "pro",
          rateLimitTier: "default_claude",
        },
      }),
    );
    expect(parsed?.accessToken).toBe("tok");
    expect(parsed?.expiresAt).toBe(1788000000000);
    if (parsed === null) throw new Error("expected credentials");
    expect(claudePlanLabel(parsed)).toBe("Pro");
  });

  it("labels Max plans from the rate limit tier", () => {
    expect(
      claudePlanLabel({ subscriptionType: null, rateLimitTier: "max_5x" }),
    ).toBe("Max (5x)");
  });

  it("rejects credential files without an access token", () => {
    expect(
      parseClaudeCredentialsFile(JSON.stringify({ claudeAiOauth: {} })),
    ).toBeNull();
    expect(parseClaudeCredentialsFile("not json")).toBeNull();
  });

  it("reads the account email", () => {
    expect(
      parseClaudeAccountEmail(
        JSON.stringify({
          oauthAccount: { emailAddress: "dev@example.com" },
        }),
      ),
    ).toBe("dev@example.com");
    expect(parseClaudeAccountEmail("broken")).toBeNull();
  });
});

describe("classifyCodexAuthJson", () => {
  it("accepts API key auth", () => {
    expect(
      classifyCodexAuthJson(
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }),
      ),
    ).toEqual({ kind: "apiKey" });
  });

  it("accepts ChatGPT token auth with a future expiry", () => {
    const accessToken = unsignedJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: "dev@example.com",
    });
    const auth = classifyCodexAuthJson(
      JSON.stringify({
        tokens: { access_token: accessToken, account_id: "acc-1" },
      }),
    );
    expect(auth).toMatchObject({
      kind: "chatgpt",
      accountId: "acc-1",
      accountEmail: "dev@example.com",
      expired: false,
    });
  });

  it("marks expired ChatGPT tokens", () => {
    const accessToken = unsignedJwt({
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const auth = classifyCodexAuthJson(
      JSON.stringify({
        tokens: { access_token: accessToken, account_id: "acc-1" },
      }),
    );
    expect(auth).toMatchObject({ kind: "chatgpt", expired: true });
  });

  it("rejects auth without a usable token", () => {
    expect(classifyCodexAuthJson(JSON.stringify({ tokens: {} }))).toBeNull();
    expect(classifyCodexAuthJson("not json")).toBeNull();
  });
});

describe("jwtExpiryMs", () => {
  it("converts exp seconds to milliseconds", () => {
    expect(jwtExpiryMs(unsignedJwt({ exp: 1000 }))).toBe(1_000_000);
    expect(jwtExpiryMs("malformed")).toBeNull();
  });
});

describe("lastOutputLine", () => {
  it("returns the last non-empty trimmed line", () => {
    expect(lastOutputLine("a\nb\n  \n", 100)).toBe("b");
    expect(lastOutputLine("", 100)).toBeNull();
  });
});
