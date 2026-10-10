/**
 * Where to go after signing in (the login page's ?next=): only a path on
 * this portal, never another site.
 *
 * Browsers drop tabs and newlines from URLs and treat "\" like "/", so
 * "/\t/evil.example" or "/\\evil.example" would leave the portal. Any
 * control character, space or backslash is refused, and what is left must
 * still resolve to this origin with a single leading slash.
 */
export function safeNextPath(s: string): string {
  if (!s.startsWith("/") || s.length > 2000 || /[\u0000- \u007f\\]/.test(s)) return "/home";
  try {
    const u = new URL(s, "https://portal.invalid");
    if (u.origin !== "https://portal.invalid" || u.pathname.startsWith("//")) return "/home";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/home";
  }
}
