import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudePlanLabel,
  clearCredentials,
  parseClaudeAccountEmail,
  parseClaudeCredentialsFile,
  readSubscriptionStatus,
  writeCredentials,
} from "./credentials.js";

const homes: string[] = [];

function newHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "claude-login-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length > 0) {
    rmSync(homes.pop() ?? "", { recursive: true, force: true });
  }
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

  it("decodes hex-encoded credential payloads", () => {
    const body = JSON.stringify({
      claudeAiOauth: { accessToken: "tok", expiresAt: 42 },
    });
    const hex = Buffer.from(body, "utf8").toString("hex");
    expect(parseClaudeCredentialsFile(hex)).toMatchObject({
      accessToken: "tok",
      expiresAt: 42,
    });
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

describe("credential file round trip", () => {
  const account = {
    label: "Dev",
    email: "dev@example.com",
    accountUuid: "11111111-2222-4333-8444-555555555555",
    subscriptionType: "pro",
    rateLimitTier: "default_claude_pro",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: 1788000000000,
  };

  it("writes credentials the status reader and the CLI layout expect", async () => {
    const home = newHome();
    await writeCredentials(account, home);

    const written = JSON.parse(
      readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8"),
    );
    expect(written.claudeAiOauth).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 1788000000000,
      subscriptionType: "pro",
    });
    expect(
      statSync(path.join(home, ".claude", ".credentials.json")).mode & 0o777,
    ).toBe(0o600);

    const settings = JSON.parse(
      readFileSync(path.join(home, ".claude.json"), "utf8"),
    );
    expect(settings.hasCompletedOnboarding).toBe(true);
    expect(settings.oauthAccount).toMatchObject({
      emailAddress: "dev@example.com",
      accountUuid: "11111111-2222-4333-8444-555555555555",
    });

    await expect(readSubscriptionStatus(home)).resolves.toEqual({
      loggedIn: true,
      planLabel: "Pro",
      accountEmail: "dev@example.com",
      expiresAt: 1788000000000,
    });
  });

  it("merges into an existing .claude.json without dropping other keys", async () => {
    const home = newHome();
    await writeCredentials(account, home);
    await writeCredentials(
      { ...account, email: "other@example.com", accountUuid: null },
      home,
    );
    const settings = JSON.parse(
      readFileSync(path.join(home, ".claude.json"), "utf8"),
    );
    expect(settings.oauthAccount.emailAddress).toBe("other@example.com");
  });

  it("clears credentials and the stored account identity", async () => {
    const home = newHome();
    await writeCredentials(account, home);
    await clearCredentials(home);

    await expect(readSubscriptionStatus(home)).resolves.toEqual({
      loggedIn: false,
      planLabel: null,
      accountEmail: null,
      expiresAt: null,
    });
    const settings = JSON.parse(
      readFileSync(path.join(home, ".claude.json"), "utf8"),
    );
    expect(settings.oauthAccount).toBeUndefined();
    expect(settings.hasCompletedOnboarding).toBe(true);
  });
});
