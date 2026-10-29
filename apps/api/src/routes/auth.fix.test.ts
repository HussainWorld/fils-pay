import assert from "node:assert/strict";
import { test } from "node:test";
import { app, closeAll, createLoginableMerchant, merchantLogin, passwordStep } from "../fixesTestSupport.js";

test.after(closeAll);

test("a pending (password-only) session cannot call merchant routes", async () => {
  const { merchantId, email } = await createLoginableMerchant("otp-skip");
  const { cookie } = await passwordStep(merchantId, email);
  const res = await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie } });
  assert.equal(res.statusCode, 401, res.body);
});

test("after the OTP is verified the same routes work", async () => {
  const { merchantId, email } = await createLoginableMerchant("otp-ok");
  const cookie = await merchantLogin(merchantId, email);
  const res = await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie } });
  assert.equal(res.statusCode, 200, res.body);
});

test("parallel OTP guesses cannot exceed max_attempts", async () => {
  const { merchantId, email } = await createLoginableMerchant("otp-race");
  const { cookie, code } = await passwordStep(merchantId, email);
  const wrong = code === "000000" ? "111111" : "000000";
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: wrong } }),
    ),
  );
  const guessed = results.filter((r) => r.statusCode === 401 && r.json().error !== "no_pending_session").length;
  assert.ok(guessed <= 5, `${guessed} guesses were evaluated, max_attempts is 5`);
});

test("the session belongs to the merchant whose password was checked, even if the email exists elsewhere", async () => {
  const shared = `shared-${Date.now()}@example.test`;
  const other = await createLoginableMerchant("email-other", shared);
  const mine = await createLoginableMerchant("email-mine", shared);
  void other;
  const cookie = await merchantLogin(mine.merchantId, shared);
  const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal((me.json() as { merchant: { id: string } }).merchant.id, mine.merchantId);
});
