import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";

/**
 * Refunds — full and partial (FP-212). Two registrations, one handler:
 *
 *   POST /v1/refunds                          merchant from the credential
 *   POST /v1/merchants/:merchantId/refunds    path merchant, scope-checked
 *
 * Body: { transactionId, amountFils?, reason? }. Omitting amountFils refunds
 * everything still refundable. Idempotency-Key header required, as on capture.
 */
// FIX R-7: was a 501 stub. The draft handler left in the comments here generated a fresh
// randomUUID() idempotency key per request (so a client retry after a timeout refunded twice) and
// spread the raw body into the call (so a body `merchantId` could override the authenticated one).
// Here the key comes from the client's header and only whitelisted body fields are read.

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.trim() === "") {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return value;
}

function parseRefundBody(body: RefundBody | undefined) {
  const transactionId = body?.transactionId;
  if (typeof transactionId !== "string" || !UUID_RE.test(transactionId)) {
    throw new BadRequestError("invalid_request", "transactionId must be a transaction id");
  }
  const amountFils = body?.amountFils;
  if (amountFils !== undefined && (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils))) {
    throw new BadRequestError("invalid_request", "amountFils must be an integer number of fils");
  }
  const reason = body?.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    throw new BadRequestError("invalid_request", "reason must be a string of at most 500 characters");
  }
  return {
    transactionId,
    // Negative/zero amounts reach the validator, which answers 422 refund_amount_invalid.
    amountFils: amountFils === undefined ? undefined : toFils(amountFils as number, { allowNegative: true }),
    reason: reason as string | undefined,
  };
}

async function handleRefund(app: FastifyInstance, request: FastifyRequest, merchantId: string) {
  const idempotencyKey = getIdempotencyKey(request);
  const body = parseRefundBody(request.body as RefundBody | undefined);
  return initiateMerchantRefund(app.db, app.acquirer, {
    merchantId,
    transactionId: body.transactionId,
    amountFils: body.amountFils,
    reason: body.reason,
    idempotencyKey,
    actor: requireMerchantWriterActor(request.merchantAuth!),
  });
}

/** Registered with prefix '/v1/refunds'. */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const result = await handleRefund(app, request, request.merchantAuth!.merchantId);
      reply.code(result.statusCode).send(result.body);
    },
  );
}

/** Registered with prefix '/v1/merchants' — the path apps/web's RefundDrawer calls. */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { merchantId: string } }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertRefundRequestScope(request.merchantAuth!, request.params.merchantId);
      const result = await handleRefund(app, request, request.merchantAuth!.merchantId);
      reply.code(result.statusCode).send(result.body);
    },
  );
}
