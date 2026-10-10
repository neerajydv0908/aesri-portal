"use client";

import { useEffect } from "react";

/**
 * After a one-off success message (?done=…) has been shown, take it out of
 * the address, so it doesn't show again after the next save or a reload.
 */
export function ForgetDoneParam() {
  // Runs after every render (not only the first), because the same message
  // box stays mounted when one save follows another on the same page.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("done")) return;
    url.searchParams.delete("done");
    // `null` state: Next.js then copies its own state and updates its router's URL too.
    window.history.replaceState(null, "", url);
  });
  return null;
}
