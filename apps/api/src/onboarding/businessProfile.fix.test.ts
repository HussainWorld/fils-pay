/**
 * FIX P-1 regression: unknown fields in a business-profile PATCH are ignored
 * instead of turning into `undefined = $n` SQL (a 500). Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { updateBusinessProfile, type BusinessProfilePatch } from "./businessProfile.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("businessProfile.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(() => pool.end());

async function merchantWithProfile(): Promise<string> {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Profile ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  await pool.query(
    `INSERT INTO merchant_business_profiles
       (merchant_id, legal_name, registration_number, business_type, contact_email, contact_phone, address_line1, city)
     VALUES ($1, 'Old Co', 'CR-1', 'llc', 'a@example.test', '+97300000000', 'Road 1', 'Manama')`,
    [merchantId],
  );
  return merchantId;
}

test("P-1: unknown and prototype-named fields are ignored; known fields still update", async () => {
  const merchantId = await merchantWithProfile();
  // Exactly what Fastify hands the route: a parsed JSON body with own "__proto__"/"constructor" keys.
  const body = JSON.parse('{"legalName":"New Co","bogus":"x","__proto__":"y","constructor":"z"}') as BusinessProfilePatch;
  const profile = await updateBusinessProfile(pool, merchantId, body);
  assert.equal(profile.legalName, "New Co");
});

test("P-1: a body with only unknown fields changes nothing and does not throw", async () => {
  const merchantId = await merchantWithProfile();
  const profile = await updateBusinessProfile(pool, merchantId, JSON.parse('{"nope":"1"}') as BusinessProfilePatch);
  assert.equal(profile.legalName, "Old Co");
});
