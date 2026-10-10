"use client";

/**
 * A form section that opens when you ask for it ("Edit details"). Put it
 * inside <ActionForm>: it opens by itself when the save comes back with a
 * problem, and closes again after a successful save (the message above it
 * says what happened).
 */
import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import { useFormResult } from "@/components/forms";

export function FormDisclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const state = useFormResult();
  return (
    <details key={state?.ok ? `saved-${state.nonce}` : "form"} open={state?.error ? true : undefined} className="group">
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full bg-cream-50 px-5 text-[0.95rem] font-semibold text-forest-900 ring-1 ring-forest-900/15 hover:ring-forest-900/35 group-open:mb-5 [&::-webkit-details-marker]:hidden">
        <Pencil className="h-4 w-4" aria-hidden />
        {summary}
      </summary>
      <div className="grid gap-5">{children}</div>
    </details>
  );
}
