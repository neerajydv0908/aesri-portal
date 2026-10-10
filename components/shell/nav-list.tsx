"use client";

import { createPortal } from "react-dom";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BookOpenCheck,
  Building2,
  CalendarCheck2,
  FileText,
  GraduationCap,
  House,
  IdCard,
  KeyRound,
  Layers,
  Megaphone,
  Menu,
  MessageSquareText,
  NotebookPen,
  ScrollText,
  Settings,
  ShieldCheck,
  Smartphone,
  UserRound,
  Users,
  Wallet,
  X,
  FileSpreadsheet,
  FilePenLine,
  HandHelping,
} from "lucide-react";
import { navBadge, type NavGroup, type NavIcon } from "./nav";
import { useNavCounts } from "./nav-counts";

const icons: Record<NavIcon, typeof House> = {
  home: House,
  attendance: CalendarCheck2,
  results: GraduationCap,
  homework: NotebookPen,
  fees: Wallet,
  notices: Megaphone,
  remarks: MessageSquareText,
  profile: UserRound,
  students: Users,
  staff: IdCard,
  classes: Layers,
  access: KeyRound,
  exams: BookOpenCheck,
  log: ScrollText,
  settings: Settings,
  schools: Building2,
  admins: ShieldCheck,
  import: FileSpreadsheet,
  sms: Smartphone,
  reportRemarks: FilePenLine,
  support: HandHelping,
};

function isActive(pathname: string, href: string) {
  if (href === "/home") return pathname === "/home";
  if (href === "/aesri") return pathname === "/aesri";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavList({ groups, onNavigate, label = "Main" }: { groups: NavGroup[]; onNavigate?: () => void; label?: string }) {
  const pathname = usePathname();
  const counts = useNavCounts();
  return (
    <nav aria-label={label} data-nav="main" className="grid gap-6">
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.label ? <p className="mb-2 px-3 text-[0.7rem] font-bold uppercase tracking-[0.16em] text-sage-300">{g.label}</p> : null}
          <ul className="grid gap-0.5">
            {g.items.map((it) => {
              const Icon = icons[it.icon] ?? FileText;
              const active = isActive(pathname, it.href);
              const waiting = it.count ? navBadge(it.count, counts) : null;
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={clsx(
                      "flex min-h-11 items-center gap-3 rounded-xl px-3 text-[0.95rem] font-semibold transition-colors",
                      active
                        ? "bg-cream-50 text-forest-900"
                        : waiting
                          ? "bg-alert-600/25 text-cream-50 ring-1 ring-inset ring-alert-600 hover:bg-alert-600/35"
                          : "text-cream-100/85 hover:bg-cream-50/10 hover:text-cream-50",
                    )}
                  >
                    <Icon className={clsx("h-[1.15rem] w-[1.15rem] shrink-0", active ? "text-forest-700" : waiting ? "text-cream-50" : "text-sage-300")} aria-hidden />
                    {it.label}
                    {waiting ? (
                      <>
                        <span
                          aria-hidden
                          className="ml-auto inline-grid h-6 min-w-6 place-items-center rounded-full bg-alert-600 px-1.5 text-[0.75rem] font-bold leading-none text-cream-50 ring-2 ring-cream-50"
                        >
                          {waiting.count > 99 ? "99+" : waiting.count}
                        </span>
                        <span className="sr-only">: {waiting.label}</span>
                      </>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * The phone-size menu: a button in the top bar that opens the navigation as a
 * panel. The panel is rendered at the end of <body> (a portal): inside the
 * sticky, blurred top bar a fixed panel would be clipped to the bar's height.
 * Focus stays inside the panel while it is open and returns to the button.
 */
export function MobileMenu({
  groups,
  children,
  label = "Menu",
  closeLabel = "Close menu",
  navLabel,
}: {
  groups: NavGroup[];
  children?: React.ReactNode;
  label?: string;
  closeLabel?: string;
  /** The navigation's name for screen readers ("Main"). */
  navLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // Something in the menu is waiting (a red dot on Fees): show a dot on the menu button too.
  const counts = useNavCounts();
  const waiting = groups.flatMap((g) => g.items.flatMap((i) => (i.count ? [navBadge(i.count, counts)] : []))).filter((b) => b !== null);
  const pathname = usePathname();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) {
      if (wasOpen.current) buttonRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])"));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        className="relative grid h-11 w-11 place-items-center rounded-full text-forest-900 hover:bg-forest-900/[0.06] lg:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden />
        <span className="sr-only">{label}</span>
        {waiting.length ? (
          <>
            <span aria-hidden className="absolute right-1.5 top-1.5 h-3 w-3 rounded-full bg-alert-600 ring-2 ring-cream-100" />
            <span className="sr-only">: {waiting.map((w) => w.label).join("; ")}</span>
          </>
        ) : null}
      </button>
      {open
        ? createPortal(
            <div className="no-print fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={label} id="mobile-nav">
              <button type="button" tabIndex={-1} className="absolute inset-0 h-full w-full cursor-default bg-forest-950/50" aria-label={closeLabel} onClick={() => setOpen(false)} />
              <div ref={panelRef} className="jaali-light absolute inset-y-0 left-0 flex w-[min(20rem,86vw)] flex-col overflow-y-auto bg-forest-900 p-4 text-cream-50 shadow-2xl">
                <div className="mb-5 flex justify-end">
                  <button type="button" onClick={() => setOpen(false)} className="grid h-11 w-11 place-items-center rounded-full hover:bg-cream-50/10" autoFocus>
                    <X className="h-5 w-5" aria-hidden />
                    <span className="sr-only">{closeLabel}</span>
                  </button>
                </div>
                <NavList groups={groups} onNavigate={() => setOpen(false)} label={navLabel} />
                {children ? <div className="mt-auto pt-6">{children}</div> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
