"use client";

/**
 * Opens Razorpay Standard Checkout (checkout.js, loaded with the page's CSP
 * nonce) for an order the server has already created. The browser only
 * passes the gateway's reply back to the server, which verifies it.
 */
import Link from "next/link";
import Script from "next/script";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Alert, buttonClasses } from "@/components/ui";
import { confirmRazorpayAction } from "./actions";

type RazorpayResponse = { razorpay_payment_id?: string; razorpay_order_id?: string; razorpay_signature?: string };
type RazorpayInstance = { open(): void; on(event: string, cb: (resp: { error?: { description?: string } }) => void): void };
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

export type CheckoutText = {
  pay: string;
  loading: string;
  confirming: string;
  failed: string;
  dismissed: string;
  loadFailed: string;
  backToFees: string;
};

export function RazorpayCheckout({
  nonce,
  keyId,
  orderId,
  providerOrderId,
  amount,
  name,
  description,
  contact,
  lang,
  secondsLeft,
  text,
}: {
  nonce?: string;
  keyId: string;
  orderId: string;
  providerOrderId: string;
  amount: number;
  name: string;
  description: string;
  contact: string | null;
  lang: "en" | "hi";
  secondsLeft: number;
  text: CheckoutText;
}) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<{ kind: "idle" | "working" | "error" | "pending" | "info"; message?: string }>({ kind: "idle" });

  const open = () => {
    if (!window.Razorpay) {
      setState({ kind: "error", message: text.loadFailed });
      return;
    }
    const rzp = new window.Razorpay({
      key: keyId,
      amount,
      currency: "INR",
      name,
      description,
      order_id: providerOrderId,
      prefill: contact ? { contact } : undefined,
      notes: { portal_order: orderId },
      theme: { color: "#1a3827" },
      timeout: Math.max(60, secondsLeft),
      config: { display: { language: lang } },
      modal: {
        confirm_close: true,
        ondismiss: () => setState((s) => (s.kind === "working" ? s : { kind: "info", message: text.dismissed })),
      },
      handler: (resp: RazorpayResponse) => {
        setState({ kind: "working" });
        confirmRazorpayAction(orderId, resp)
          .then((r) => {
            if (r.ok) router.push(r.url);
            else setState({ kind: r.pending ? "pending" : "error", message: r.message });
          })
          .catch(() => setState({ kind: "pending", message: text.confirming }));
      },
    });
    rzp.on("payment.failed", (resp) => setState({ kind: "error", message: `${text.failed}${resp?.error?.description ? ` (${resp.error.description})` : ""}` }));
    setState({ kind: "idle" });
    rzp.open();
  };

  return (
    <div className="grid gap-4">
      <Script
        src="https://checkout.razorpay.com/v1/checkout.js"
        nonce={nonce}
        strategy="afterInteractive"
        onReady={() => setReady(true)}
        onError={() => setState({ kind: "error", message: text.loadFailed })}
      />
      {state.kind === "error" ? <Alert tone="red">{state.message}</Alert> : null}
      {state.kind === "pending" ? (
        <Alert tone="amber">
          {state.message}{" "}
          <Link href="/my/fees?payment=pending" className="font-semibold underline">
            {text.backToFees}
          </Link>
        </Alert>
      ) : null}
      {state.kind === "info" ? <Alert tone="blue">{state.message}</Alert> : null}
      {state.kind === "working" ? (
        <p role="status" className="flex items-center justify-center gap-2 font-semibold text-forest-800">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          {text.confirming}
        </p>
      ) : state.kind !== "pending" ? (
        <button type="button" onClick={open} disabled={!ready} className={buttonClasses("primary", "lg", "w-full")}>
          {ready ? <ShieldCheck className="h-5 w-5" aria-hidden /> : <Loader2 className="h-5 w-5 animate-spin" aria-hidden />}
          {ready ? text.pay : text.loading}
        </button>
      ) : null}
    </div>
  );
}
