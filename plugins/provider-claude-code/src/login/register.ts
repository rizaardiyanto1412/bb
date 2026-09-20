import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  claudeSubscriptionRpcContract,
  SUBSCRIPTION_CHANGED_CHANNEL,
} from "../../contract.js";
import {
  clearCredentials,
  readSubscriptionStatus,
  writeCredentials,
} from "./credentials.js";
import { ClaudeOAuthLogin } from "./oauth-login.js";

export function registerClaudeAuth(bb: BbPluginApi): void {
  const login = new ClaudeOAuthLogin();
  const publishChange = () =>
    bb.realtime.publish(SUBSCRIPTION_CHANGED_CHANNEL, null);

  bb.rpc.register(claudeSubscriptionRpcContract, {
    "subscription.status": () => readSubscriptionStatus(),
    "subscription.start": async () => {
      const status = await readSubscriptionStatus();
      if (status.loggedIn) return { state: "completed" as const };
      const started = login.start();
      return {
        state: "awaiting-user" as const,
        sessionId: started.sessionId,
        authorizeUrl: started.authorizeUrl,
      };
    },
    "subscription.complete": async ({ sessionId, code }) => {
      const account = await login.complete({ sessionId, pasted: code });
      await writeCredentials(account);
      publishChange();
      return readSubscriptionStatus();
    },
    "subscription.cancel": ({ sessionId }) => ({
      cancelled: login.cancel(sessionId),
    }),
    "subscription.logout": async () => {
      await clearCredentials();
      publishChange();
      return readSubscriptionStatus();
    },
  });
}
