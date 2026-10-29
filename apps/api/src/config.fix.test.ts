/**
 * FIX D-6 and I-1 regressions. No database needed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { generateInviteCode } from "./admin/inviteCode.js";

test("D-6: development boots without an explicit webhook key (the built-in dev key is 32 bytes)", () => {
  const config = loadConfig({ DATABASE_URL: "postgres://unused/unused", NODE_ENV: "development" });
  assert.equal(Buffer.from(config.webhookSecretEncryptionKey, "base64").length, 32);
});

test("D-6: production still refuses to boot without a real key", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://unused/unused",
        NODE_ENV: "production",
        SETTLEMENT_INTERNAL_TOKEN: "t",
        ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
      }),
    /WEBHOOK_SECRET_ENCRYPTION_KEY/,
  );
});

test("I-1: admin invite codes never use Math.random", () => {
  const original = Math.random;
  Math.random = () => {
    throw new Error("Math.random must not be used for invite codes");
  };
  try {
    const code = generateInviteCode();
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  } finally {
    Math.random = original;
  }
});
