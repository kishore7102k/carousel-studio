import type { NextConfig } from "next";

// Private, fully dynamic app: no Cache Components. Chromium packages stay out of the bundle,
// and the serverless Chromium binary is shipped with every route that renders.
const chromiumBin = ["./node_modules/@sparticuz/chromium/bin/**", "./node_modules/playwright-core/**"];

const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "8mb" } },
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core"],
  outputFileTracingIncludes: {
    "/api/mcp": chromiumBin,
    // Keys are picomatch globs: "/c/[id]" would be a character class and match nothing.
    "/c/*": chromiumBin,
    "/new": chromiumBin,
  },
};

export default nextConfig;
