import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lets several local test servers run side by side (each with its own build folder).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // Loaded by Node at runtime instead of being bundled (WASM / native streams).
  serverExternalPackages: ["@electric-sql/pglite", "pg", "exceljs"],
  experimental: {
    serverActions: {
      // Excel imports are uploaded through a Server Action.
      bodySizeLimit: "6mb",
    },
    // Don't keep Turbopack's compile cache on disk between `next dev` runs. When the project
    // folder is synced (for example by iCloud's Desktop & Documents), the sync service can put
    // copies such as "CURRENT 2" into that cache and `next dev` then fails to start with
    // "Failed to open database". Builds (`next build`) are not affected by this setting.
    turbopackFileSystemCacheForDev: false,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(self \"https://api.razorpay.com\")" },
        ],
      },
      {
        // Pages show private records: never keep them in shared caches or the back-button cache.
        source: "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
