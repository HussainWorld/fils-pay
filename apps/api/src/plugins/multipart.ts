import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.js";

export interface MultipartPluginOptions {
  config: Pick<Config, "kycMaxFileSizeBytes">;
}

/** Registers @fastify/multipart size-limited to `config.kycMaxFileSizeBytes`
 *  — oversized uploads are rejected by the plugin before any handler runs,
 *  never buffered in full. */
// MK: fileSize limit only — files count is unlimited. one file per request is enforced in routes/kyc.ts
export const multipartPlugin = fp<MultipartPluginOptions>(async (app: FastifyInstance, opts): Promise<void> => {
  await app.register(multipart, {
    // FIX: only fileSize was limited, so one request could carry any number
    // of file parts (each buffered up to 8 MiB by routes/kyc.ts's loop) and
    // unlimited fields. The KYC route takes exactly one file + one field.
    limits: { fileSize: opts.config.kycMaxFileSizeBytes, files: 1, fields: 5, parts: 6 },
  });
});
