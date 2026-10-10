/**
 * Webhook for the built-in test checkout, in Razorpay's format, signed with
 * the test key (X-Mock-Signature = HMAC-SHA256(raw body, mockWebhookKey())).
 * Lets the "browser return + webhook both arrive" case be tried locally.
 * Answers 404 whenever the test checkout is switched off (testPaymentsAllowed).
 */
import { clientIpFrom } from "@/lib/auth/client-ip";
import { testPaymentsAllowed } from "@/lib/env";
import { handleGatewayWebhook } from "@/lib/services/payments";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!testPaymentsAllowed()) return Response.json({ error: "Not found" }, { status: 404 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 512_000) return Response.json({ error: "Body too large" }, { status: 413 });
  const raw = await request.text();
  const ip = clientIpFrom(request.headers);
  const result = await handleGatewayWebhook("mock", raw, request.headers.get("x-mock-signature"), request.headers.get("x-mock-event-id"), ip);
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
