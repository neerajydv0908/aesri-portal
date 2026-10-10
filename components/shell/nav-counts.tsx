"use client";

/**
 * The menu's counts (the red dot on Fees while cash payments wait for
 * approval), kept fresh. The menu is drawn once, in the shared layout, which
 * Next doesn't draw again when someone moves between pages — so the counts
 * are read again from /api/nav on every move, when the window comes back
 * into view, and every minute. A form that changes them (Approve, Decline)
 * draws the layout again, with the new numbers.
 */
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { NavCounts } from "./nav";

const CountsContext = createContext<NavCounts>({});

export const useNavCounts = () => useContext(CountsContext);

const EVERY_MS = 60_000;

/**
 * `stamp`: changes each time the layout is drawn on the server, so its
 * numbers replace whatever was shown — and an answer from /api/nav asked
 * for before that is ignored.
 */
export function NavCountsProvider({ initial, stamp, live, children }: { initial: NavCounts; stamp: string; live: boolean; children: ReactNode }) {
  const [counts, setCounts] = useState<NavCounts>(initial);
  const pathname = usePathname();
  const lastPath = useRef(pathname);
  /** Bumped by every sync from the layout and every request: an answer only counts if nothing came after its request. */
  const generation = useRef(0);
  const signedOut = useRef(false);

  // The layout was drawn again (after a form, or a full load): its numbers are the newest.
  const fromServer = initial.cashToApprove ?? 0;
  useEffect(() => {
    generation.current++;
    setCounts((c) => ((c.cashToApprove ?? 0) === fromServer ? c : { ...c, cashToApprove: fromServer }));
  }, [stamp, fromServer]);

  useEffect(() => {
    if (!live) return;
    let gone = false;
    const load = async () => {
      if (signedOut.current || document.visibilityState !== "visible") return;
      const mine = ++generation.current;
      try {
        const res = await fetch("/api/nav", { cache: "no-store", headers: { accept: "application/json" } });
        // The session ended: stop asking (the next page asks the person to sign in).
        if (res.status === 401) signedOut.current = true;
        if (!res.ok) return;
        const next = (await res.json()) as NavCounts;
        if (gone || mine !== generation.current || typeof next.cashToApprove !== "number") return;
        setCounts((c) => (c.cashToApprove === next.cashToApprove ? c : { ...c, cashToApprove: next.cashToApprove }));
      } catch {
        // Offline for a moment: keep what is shown.
      }
    };
    // Moved to another page: read again (the page the layout was drawn for came with fresh numbers).
    if (pathname !== lastPath.current) {
      lastPath.current = pathname;
      void load();
    }
    const timer = setInterval(load, EVERY_MS);
    const onVisible = () => void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      gone = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, pathname]);

  return <CountsContext.Provider value={counts}>{children}</CountsContext.Provider>;
}
