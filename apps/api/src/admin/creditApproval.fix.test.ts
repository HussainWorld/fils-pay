import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { assertDistinctApprover } from "./creditApproval.js";

test("the same admin cannot self-approve just because their display name changed", () => {
  const id = randomUUID();
  assert.throws(
    () => assertDistinctApprover({ adminUserId: id, displayName: "Dana" }, { adminUserId: id, displayName: "Dana F." }),
    /self_approval_forbidden/,
  );
});

test("two different admins who share a display name can approve each other", () => {
  assert.doesNotThrow(() =>
    assertDistinctApprover(
      { adminUserId: randomUUID(), displayName: "Ali" },
      { adminUserId: randomUUID(), displayName: "Ali" },
    ),
  );
});
