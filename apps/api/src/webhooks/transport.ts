/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */

/**
 * @property timeoutMs Covers the whole exchange including reading the body (the abort
 * signal stays armed until the body has been read).
 */
export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

/** FIX (B80): webhook_deliveries only stores a 2000-char excerpt. */
const RESPONSE_BODY_MAX_BYTES = 8 * 1024;

/** Reads at most maxBytes of the body as UTF-8, then cancels the stream. */
async function readAtMost(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

/** Real transport: Node's global fetch with an AbortController-driven
 *  timeout, used by index.ts's production wiring. */
export function createFetchTransport(): WebhookTransport {
  return async (req: WebhookTransportRequest): Promise<WebhookTransportResponse> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      // YA: create.ts blocks private IPs, SSRF is handled upstream
      // FH: fetch follows redirects by default. claude: "set redirect: 'manual' to prevent SSRF via an open redirect"
      const response = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
        // FIX (SSRF): fetch follows redirects by default, so a public URL
        // that answers 307 -> http://169.254.169.254/... or an internal
        // service bypassed every URL check. A redirect is now just a failed
        // (non-2xx) delivery.
        redirect: "manual",
      });
      // unbounded read, a 1gb response would oom us? — am
      // MK: timeoutMs bounds it. fine for now, revisit after Eid inshallah
      // FIX (B80): response.text() buffered the WHOLE body before the SQL
      // left(..., 2000) excerpt threw almost all of it away. The timeout
      // bounds how long, not how much: a fast endpoint can stream hundreds
      // of MB inside it. Read only what we keep (plus margin) and cancel
      // the rest of the stream.
      const body = await readAtMost(response, RESPONSE_BODY_MAX_BYTES);
      return { statusCode: response.status, body };
    } catch (err) {
      return {
        statusCode: null,
        body: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}
