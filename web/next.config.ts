import type { NextConfig } from "next";
import createMDX from "@next/mdx";

const nextConfig: NextConfig = {
  pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
  transpilePackages: ["@twain/shared"],
  turbopack: {
    // Optional peer deps of @coinbase/cdp-sdk (via wagmi's baseAccount connector); dynamic-imported, never used here.
    resolveAlias: Object.fromEntries(
      ["@x402/core/client", "@x402/evm", "@x402/evm/exact/client", "@x402/evm/upto/client", "@x402/svm/exact/client"].map((m) => [
        m,
        "./lib/stubs/empty.js",
      ]),
    ),
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "gateway.pinata.cloud" },
      { protocol: "https", hostname: "ipfs.io" },
      { protocol: "https", hostname: "*.mypinata.cloud" },
      { protocol: "http", hostname: "localhost" },
      { protocol: "http", hostname: "127.0.0.1" },
    ],
    // Local IPs are blocked by default since Next 16; allow them in dev, or when the site itself runs on localhost
    // (a local production build, e.g. for a demo recording: token images come from the local upload API).
    dangerouslyAllowLocalIP:
      process.env.NODE_ENV !== "production" || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.NEXT_PUBLIC_SITE_URL ?? ""),
  },
  async headers() {
    // Stock logos (scripts/asset-logos.mjs) only change when the script is re-run: let browsers and the CDN keep them.
    return [
      {
        source: "/logos/assets/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800" }],
      },
    ];
  },
  async redirects() {
    return [{ source: "/launchpad", destination: "/", statusCode: 301 }];
  },
};

const withMDX = createMDX({});

export default withMDX(nextConfig);
