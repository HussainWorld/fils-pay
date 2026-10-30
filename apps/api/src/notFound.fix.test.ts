/** Unknown routes answer with the API's standard error shape, not Fastify's default. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { app, closeAll } from "./fixesTestSupport.js";

test.after(closeAll);

test("an unknown /v1 route is a 404 with { error: 'not_found' }", async () => {
  for (const url of ["/v1/", "/v1/does-not-exist?x=1"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.error, "not_found");
    assert.equal(typeof body.message, "string");
    assert.ok(!String(body.message).includes("?"), "query string is not echoed back");
    assert.equal(body.statusCode, undefined, "no Fastify default fields");
  }
});
