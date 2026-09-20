import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const SUBSCRIPTION_CHANGED_CHANNEL = "subscription-changed";

export const subscriptionStatusSchema = z
  .object({
    loggedIn: z.boolean(),
    mode: z.enum(["chatgpt", "apiKey"]).nullable(),
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
      verificationUri: z.string().min(1),
      userCode: z.string().min(1),
      expiresAt: z.number(),
      intervalMs: z.number(),
    })
    .strict(),
  z.object({ state: z.literal("completed") }).strict(),
]);

export type SubscriptionStartResult = z.infer<typeof subscriptionStartSchema>;

export const subscriptionPollSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending"), nextPollMs: z.number() }).strict(),
  z
    .object({
      state: z.literal("completed"),
      status: subscriptionStatusSchema,
    })
    .strict(),
  z.object({ state: z.literal("failed"), error: z.string() }).strict(),
]);

export type SubscriptionPollResult = z.infer<typeof subscriptionPollSchema>;

export const codexSubscriptionRpcContract = defineRpcContract({
  "subscription.status": {
    input: z.null(),
    output: subscriptionStatusSchema,
  },
  "subscription.start": {
    input: z.null(),
    output: subscriptionStartSchema,
  },
  "subscription.poll": {
    input: z.object({ sessionId: z.string().min(1) }).strict(),
    output: subscriptionPollSchema,
  },
  "subscription.cancel": {
    input: z.object({ sessionId: z.string().min(1) }).strict(),
    output: z.object({ cancelled: z.boolean() }).strict(),
  },
  "subscription.loginApiKey": {
    input: z.object({ apiKey: z.string().min(1) }).strict(),
    output: subscriptionStatusSchema,
  },
  "subscription.logout": {
    input: z.null(),
    output: subscriptionStatusSchema,
  },
});
