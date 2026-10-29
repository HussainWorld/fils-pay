import { ConflictError } from "../lib/errors.js";

/** An operator on one side of a credit's two-person control. */
export interface CreditActor {
  adminUserId: string;
  displayName: string;
}

/** Two-person control: the operator who approves a credit must not be the one who requested it. */
export function assertDistinctApprover(requester: CreditActor, approver: CreditActor): void {
  // FIX (note: "some admin actions don't have the right checks"): this
  // compared displayName. A display name is not an identity: it is free
  // text, not unique, and the requester's is a snapshot taken at request
  // time. An operator who renames themselves (or whose name differs in
  // case/spacing) could approve their own credit, and two different people
  // called "Ali" could never approve each other's. HANDOVER: "The second
  // approver is compared by admin user id". Compare the id.
  if (approver.adminUserId === requester.adminUserId) {
    throw new ConflictError("self_approval_forbidden");
  }
}
