import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCredentials,
  codexAuthPath,
  codexPlanLabel,
  readSubscriptionStatus,
  writeCodexApiKey,
  writeCodexTokens,
} from "./credentials.js";

const homes: string[] = [];

function newHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "codex-login-"));
  homes.push(home);
  return home;
}

function jwt(payload: object): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

afterEach(() => {
  while (homes.length > 0) {
    rmSync(homes.pop() ?? "", { recursive: true, force: true });
  }
});

describe("codex credential file round trip", () => {
  it("writes ChatGPT tokens the status reader and the CLI layout expect", async () => {
    const home = newHome();
    const accessToken = jwt({
      exp: 2_000_000_000,
      email: "codex@example.com",
    });
    const idToken = jwt({
      email: "codex@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "chatgpt-account-1",
        chatgpt_plan_type: "pro",
      },
    });
    await writeCodexTokens(
      {
        accessToken,
        refreshToken: "refresh-secret",
        idToken,
        accountId: "chatgpt-account-1",
        accountEmail: "codex@example.com",
        planType: "pro",
        expiresAt: 2_000_000_000_000,
      },
      home,
      {},
    );

    const authPath = codexAuthPath(home, {});
    expect(authPath).toBe(path.join(home, ".codex", "auth.json"));
    const written = JSON.parse(readFileSync(authPath, "utf8"));
    expect(written).toMatchObject({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: "refresh-secret",
        account_id: "chatgpt-account-1",
      },
    });
    expect(statSync(authPath).mode & 0o777).toBe(0o600);

    await expect(readSubscriptionStatus(home, {})).resolves.toEqual({
      loggedIn: true,
      mode: "chatgpt",
      planLabel: "Pro",
      accountEmail: "codex@example.com",
      expiresAt: 2_000_000_000_000,
    });
  });

  it("honours the CODEX_HOME override", async () => {
    const home = newHome();
    const codexHome = path.join(home, "custom-codex-home");
    await writeCodexApiKey("sk-test", home, { CODEX_HOME: codexHome });
    expect(readFileSync(path.join(codexHome, "auth.json"), "utf8")).toContain(
      "sk-test",
    );
  });

  it("writes an API key as apikey auth", async () => {
    const home = newHome();
    await writeCodexApiKey("sk-test", home, {});
    const written = JSON.parse(readFileSync(codexAuthPath(home, {}), "utf8"));
    expect(written).toMatchObject({
      auth_mode: "apikey",
      OPENAI_API_KEY: "sk-test",
      tokens: null,
    });
    await expect(readSubscriptionStatus(home, {})).resolves.toEqual({
      loggedIn: true,
      mode: "apiKey",
      planLabel: null,
      accountEmail: null,
      expiresAt: null,
    });
  });

  it("reports signed out when the auth file is missing or cleared", async () => {
    const home = newHome();
    await expect(readSubscriptionStatus(home, {})).resolves.toEqual({
      loggedIn: false,
      mode: null,
      planLabel: null,
      accountEmail: null,
      expiresAt: null,
    });
    await writeCodexApiKey("sk-test", home, {});
    await clearCredentials(home, {});
    await expect(readSubscriptionStatus(home, {})).resolves.toMatchObject({
      loggedIn: false,
    });
  });
});

describe("codexPlanLabel", () => {
  it("maps ChatGPT plan types to display labels", () => {
    expect(codexPlanLabel("pro")).toBe("Pro");
    expect(codexPlanLabel("plus")).toBe("Plus");
    expect(codexPlanLabel("team")).toBe("Team");
    expect(codexPlanLabel(null)).toBeNull();
    expect(codexPlanLabel("")).toBeNull();
  });
});
