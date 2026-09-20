import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  codexSubscriptionRpcContract,
  SUBSCRIPTION_CHANGED_CHANNEL,
} from "../../contract.js";
import {
  clearCredentials,
  readSubscriptionStatus,
  writeCodexApiKey,
  writeCodexTokens,
} from "./credentials.js";
import { CodexDeviceLogin } from "./device-login.js";

export function registerCodexAuth(bb: BbPluginApi): void {
  const login = new CodexDeviceLogin();
  bb.onDispose(() => login.dispose());
  const publishChange = () =>
    bb.realtime.publish(SUBSCRIPTION_CHANGED_CHANNEL, null);

  bb.rpc.register(codexSubscriptionRpcContract, {
    "subscription.status": () => readSubscriptionStatus(),
    "subscription.start": async () => {
      const status = await readSubscriptionStatus();
      if (status.loggedIn) return { state: "completed" as const };
      const started = await login.start();
      return {
        state: "awaiting-user" as const,
        sessionId: started.sessionId,
        verificationUri: started.verificationUri,
        userCode: started.userCode,
        expiresAt: started.expiresAt,
        intervalMs: started.intervalMs,
      };
    },
    "subscription.poll": async ({ sessionId }) => {
      const result = await login.poll({ sessionId });
      if (result.status === "pending") {
        return {
          state: "pending" as const,
          nextPollMs: login.nextPollDelayMs(sessionId),
        };
      }
      if (result.status === "error") {
        return { state: "failed" as const, error: result.message };
      }
      await writeCodexTokens(result.tokens);
      publishChange();
      return {
        state: "completed" as const,
        status: await readSubscriptionStatus(),
      };
    },
    "subscription.cancel": ({ sessionId }) => ({
      cancelled: login.cancel({ sessionId }),
    }),
    "subscription.loginApiKey": async ({ apiKey }) => {
      await writeCodexApiKey(apiKey);
      publishChange();
      return readSubscriptionStatus();
    },
    "subscription.logout": async () => {
      await clearCredentials();
      publishChange();
      return readSubscriptionStatus();
    },
  });
}
