/**
 * Razorpay webhook (public; no session). Configure it in the Razorpay
 * Dashboard → Webhooks with the URL {APP_URL}/api/payments/razorpay, the
 * events payment.captured, order.paid, payment.failed and refund.processed, and a secret that
 * is also set as RAZORPAY_WEBHOOK_SECRET.
 *
 * The X-Razorpay-Signature header must equal HMAC-SHA256(raw body, secret),
 * compared in constant time. Deliveries are recorded once (by
 * x-razorpay-event-id) and a payment is never recorded twice, even when the
 * family's browser has already confirmed it.
 */
import { clientIpFrom } from "@/lib/auth/client-ip";
import { handleGatewayWebhook } from "@/lib/services/payments";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512_000;

/**
 * The body as text, or null once it passes MAX_BODY_BYTES. Read in pieces, so
 * a body sent without Content-Length (chunked) can't fill the server's memory.
 */
async function readLimited(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return Response.json({ error: "Body too large" }, { status: 413 });
  const raw = await readLimited(request);
  if (raw === null) return Response.json({ error: "Body too large" }, { status: 413 });
  const ip = clientIpFrom(request.headers);
  const result = await handleGatewayWebhook("razorpay", raw, request.headers.get("x-razorpay-signature"), request.headers.get("x-razorpay-event-id"), ip);
  if (result.status >= 400) console.warn(`[payments] Razorpay webhook refused (${result.status}): ${String(result.body.error ?? "")}`);
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
