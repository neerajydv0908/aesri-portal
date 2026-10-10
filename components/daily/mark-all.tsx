"use client";

/**
 * "Mark everyone present" / "Mark all done": ticks one choice for every
 * student in the form. It only changes the form — nothing is saved until the
 * teacher presses Save. Hidden until JavaScript has loaded, because it can't
 * work without it (the form itself still works).
 */
import { useState, useSyncExternalStore } from "react";
import { buttonClasses } from "@/components/ui";

const noSubscribe = () => () => {};

export function MarkAllButton({ group, value, label, announce }: { group: string; value: string; label: string; announce: string }) {
  const ready = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const [said, setSaid] = useState("");
  if (!ready) return null;
  return (
    <>
      <button
        type="button"
        className={buttonClasses("secondary", "md")}
        onClick={(e) => {
          const form = e.currentTarget.form;
          if (!form) return;
          form.querySelectorAll<HTMLInputElement>(`input[type="radio"][data-mark-all="${group}"]`).forEach((r) => {
            if (r.value === value) r.checked = true;
          });
          // Re-announce even if pressed twice.
          setSaid("");
          window.setTimeout(() => setSaid(announce), 50);
        }}
      >
        {label}
      </button>
      <span role="status" className="sr-only">
        {said}
      </span>
    </>
  );
}
