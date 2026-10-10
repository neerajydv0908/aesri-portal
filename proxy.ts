/**
 * Runs before every page: adds a strict Content-Security-Policy with a
 * fresh nonce, so only the portal's own scripts (and the payment gateway's
 * checkout, when enabled) can run.
 *
 * Links from the public website carry the reader's language (?lang=hi or
 * ?lang=en): it is remembered in the same cookie the EN / हिं switch sets,
 * and the same page opens without the parameter.
 */
import { NextResponse, type NextRequest } from "next/server";
import { LANG_COOKIE, LANG_COOKIE_OPTIONS } from "@/lib/i18n";

export function proxy(request: NextRequest) {
  const https = (process.env.APP_URL ?? "").startsWith("https://");

  const lang = request.nextUrl.searchParams.get("lang");
  if ((lang === "en" || lang === "hi") && (request.method === "GET" || request.method === "HEAD")) {
    const url = request.nextUrl.clone();
    url.searchParams.delete("lang");
    const response = NextResponse.redirect(url);
    response.cookies.set(LANG_COOKIE, lang, LANG_COOKIE_OPTIONS);
    if (https) response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    return response;
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://checkout.razorpay.com${isDev ? " 'unsafe-eval'" : ""}`,
    // The dev server injects CSS inline; production serves it as files.
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.razorpay.com",
    "font-src 'self' data:",
    "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
    "frame-src https://api.razorpay.com https://checkout.razorpay.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  if (https) response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
