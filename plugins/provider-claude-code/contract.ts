import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const SUBSCRIPTION_CHANGED_CHANNEL = "subscription-changed";

export const subscriptionStatusSchema = z
  .object({
    loggedIn: z.boolean(),
    planLabel: z.string().nullable(),
    accountEmail: z.string().nullable(),
    expiresAt: z.number().nullable(),
  })
  .strict();

export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const subscriptionStartSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("awaiting-user"),
      sessionId: z.string().min(1),
      authorizeUrl: z.string().min(1),
    })
    .strict(),
  z.object({ state: z.literal("completed") }).strict(),
]);

export type SubscriptionStartResult = z.infer<typeof subscriptionStartSchema>;

export const claudeSubscriptionRpcContract = defineRpcContract({
  "subscription.status": {
    input: z.null(),
    output: subscriptionStatusSchema,
  },
  "subscription.start": {
    input: z.null(),
    output: subscriptionStartSchema,
  },
  "subscription.complete": {
    input: z
      .object({ sessionId: z.string().min(1), code: z.string() })
      .strict(),
    output: subscriptionStatusSchema,
  },
  "subscription.cancel": {
    input: z.object({ sessionId: z.string().min(1) }).strict(),
    output: z.object({ cancelled: z.boolean() }).strict(),
  },
  "subscription.logout": {
    input: z.null(),
    output: subscriptionStatusSchema,
  },
});
