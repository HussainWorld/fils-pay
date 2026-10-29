import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toFils, type Fils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError, NotFoundError } from "../lib/errors.js";

/**
 * FP-300: refunds, full and partial, end to end.
 *
 * Two URLs, one handler: `POST /v1/refunds` (the documented API, merchant
 * taken from the credentials) and `POST /v1/merchants/:merchantId/refunds`
 * (what the dashboard RefundDrawer calls; the path merchant must be the
 * authenticated one). Previously the first answered 501 and the second did
 * not exist.
 *
 * Everything that moves money lives in processRefund (one transaction,
 * transaction row locked, acquirer refund, ledger reversal, fee reversal,
 * timeline event, refund.succeeded outbox event, idempotency record).
 * This file only authenticates, authorizes and validates input.
 */

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

interface MerchantIdParams {
  merchantId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same rule as capture: an Idempotency-Key header is required, never generated server-side
 *  (a server-generated key would make every retry a brand new refund). */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || key.length > 255) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

function parseBody(body: RefundBody | undefined): { transactionId: string; amountFils?: Fils; reason?: string } {
  const { transactionId, amountFils, reason } = body ?? {};
  if (typeof transactionId !== "string" || !UUID_RE.test(transactionId)) {
    // a malformed id cannot name a transaction: 404, not a 500 from a failed uuid cast
    throw new NotFoundError("transaction_not_found");
  }
  let amount: Fils | undefined;
  if (amountFils !== undefined && amountFils !== null) {
    // integer fils only (ADR-0001): no decimals, no strings, no floats
    if (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0) {
      throw new BadRequestError("invalid_amount", "amountFils must be a positive integer number of fils");
    }
    amount = toFils(amountFils);
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    throw new BadRequestError("invalid_reason", "reason must be a string of at most 500 characters");
  }
  return {
    transactionId,
    ...(amount === undefined ? {} : { amountFils: amount }),
    ...(typeof reason === "string" && reason.trim() !== "" ? { reason: reason.trim() } : {}),
  };
}

async function handleRefund(
  app: FastifyInstance,
  request: FastifyRequest<{ Body: RefundBody }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = request.merchantAuth!;
  const idempotencyKey = getIdempotencyKey(request);
  const input = parseBody(request.body);
  const result = await initiateMerchantRefund(app.db, app.acquirer, {
    merchantId: auth.merchantId,
    transactionId: input.transactionId,
    ...(input.amountFils === undefined ? {} : { amountFils: input.amountFils }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    idempotencyKey,
    actor: requireMerchantWriterActor(auth),
  });
  reply.code(result.statusCode).send(result.body);
}

// Refunds move money: owner/finance sessions and API keys only. A merchant
// 'support' user and an admin "view as merchant" grant (role support) get 403.
const REFUND_PREHANDLERS = [requireMerchantAuth, requireMerchantRole("owner", "finance")];

/** Registered with prefix '/v1/refunds'. */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>("/", { preHandler: REFUND_PREHANDLERS }, (request, reply) =>
    handleRefund(app, request, reply),
  );
}

/** Registered with prefix '/v1/merchants'. */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: RefundBody }>(
    "/:merchantId/refunds",
    { preHandler: REFUND_PREHANDLERS },
    async (request, reply) => {
      assertRefundRequestScope(request.merchantAuth!, request.params.merchantId);
      await handleRefund(app, request, reply);
    },
  );
}
