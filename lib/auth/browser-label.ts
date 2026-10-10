/**
 * A short name for a browser from its user-agent text ("Chrome on Windows"),
 * so people can recognise their own trusted browsers in a list. Only for
 * showing: a browser can claim any user-agent, so it never decides anything.
 */
export function browserLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  if (!ua) return "Unknown browser";
  const browser = /\bEdg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(ua)
      ? "Opera"
      : /\bSamsungBrowser\//.test(ua)
        ? "Samsung Internet"
        : /\bFirefox\/|\bFxiOS\//.test(ua)
          ? "Firefox"
          : /\bCriOS\/|\bChrome\/|HeadlessChrome\//.test(ua)
            ? "Chrome"
            : /\bSafari\//.test(ua)
              ? "Safari"
              : "A browser";
  const system = /\biPhone\b|\biPod\b/.test(ua)
    ? "iPhone"
    : /\biPad\b/.test(ua)
      ? "iPad"
      : /\bAndroid\b/.test(ua)
        ? "Android"
        : /\bCrOS\b/.test(ua)
          ? "ChromeOS"
          : /\bWindows\b/.test(ua)
            ? "Windows"
            : /\bMacintosh\b|\bMac OS X\b/.test(ua)
              ? "Mac"
              : /\bLinux\b/.test(ua)
                ? "Linux"
                : null;
  return system ? `${browser} on ${system}` : browser;
}
