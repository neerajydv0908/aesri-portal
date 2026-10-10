import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "@fontsource/tiro-devanagari-hindi/devanagari-400.css";
import "@fontsource-variable/noto-sans-devanagari/wght.css";
import "./globals.css";
import { getLang } from "@/lib/i18n/server";

const fraunces = localFont({
  src: [
    { path: "../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-standard-normal.woff2", style: "normal", weight: "100 900" },
    { path: "../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-standard-italic.woff2", style: "italic", weight: "100 900" },
  ],
  variable: "--font-fraunces",
  display: "swap",
  fallback: ["Georgia", "serif"],
});

const manrope = localFont({
  src: "../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2",
  variable: "--font-manrope",
  weight: "200 800",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

/** The tab title, in the reader's language (families can read the whole portal in Hindi). */
export async function generateMetadata(): Promise<Metadata> {
  const hi = (await getLang()) === "hi";
  return {
    title: hi ? { default: "एईएसआरआई कैंपस पोर्टल", template: "%s · एईएसआरआई पोर्टल" } : { default: "AESRI Campus Portal", template: "%s · AESRI Portal" },
    description: "The Campus Portal of Aryavart Public School and Aadharshila Public School.",
    applicationName: "AESRI Campus Portal",
    robots: { index: false, follow: false },
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  themeColor: "#13271c",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await getLang();
  return (
    <html lang={lang} className={`${fraunces.variable} ${manrope.variable}`}>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="no-print fixed left-3 top-3 z-[100] -translate-y-24 rounded-full bg-forest-900 px-5 py-3 text-sm font-semibold text-cream-50 transition-transform focus:translate-y-0"
        >
          {lang === "hi" ? "मुख्य सामग्री पर जाएँ" : "Skip to content"}
        </a>
        {children}
      </body>
    </html>
  );
}
