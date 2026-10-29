import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWebhookUrl } from "./create.js";

const prod = { nodeEnv: "production" as const };

test("production webhook URLs must be public https hosts (SSRF)", () => {
  for (const url of [
    "https://127.0.0.1/hook",
    "https://localhost/hook",
    "https://10.0.0.5/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.10/hook",
    "https://172.20.0.3/hook",
    "https://settlement:8091/internal/run-batch",
    "https://postgres/hook",
    "https://[::1]/hook",
    "https://db.internal/hook",
  ]) {
    assert.throws(() => validateWebhookUrl(url, prod), (e: { code?: string }) => e.code === "invalid_url", url);
  }
  assert.equal(validateWebhookUrl("https://shop.example.com/hooks/filspay", prod).hostname, "shop.example.com");
  assert.equal(validateWebhookUrl("https://203.0.113.7/hook", prod).hostname, "203.0.113.7");
});
