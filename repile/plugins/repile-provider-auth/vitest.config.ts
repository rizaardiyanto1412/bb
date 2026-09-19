import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "bb-plugin-repile-provider-auth",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
