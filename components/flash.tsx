/**
 * A success message chosen by a fixed key in the URL (?done=saved), shown
 * after a Server Action redirects. Unknown keys show nothing, so nothing
 * typed into the URL is ever displayed. The key is removed from the address
 * once shown, so a reload doesn't repeat it.
 */
import type { ReactNode } from "react";
import { Alert } from "@/components/ui";
import { ForgetDoneParam } from "@/components/daily/forget-done";

export function Flash({ code, messages }: { code: string | string[] | undefined; messages: Record<string, ReactNode> }) {
  const key = typeof code === "string" ? code : undefined;
  if (!key || !Object.hasOwn(messages, key)) return null;
  return (
    <Alert tone="green" className="mb-6">
      {messages[key]}
      <ForgetDoneParam />
    </Alert>
  );
}
