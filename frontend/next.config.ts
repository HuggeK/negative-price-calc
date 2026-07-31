import type { NextConfig } from "next";

// Static export for GitHub Pages. The whole app runs client-side (analysis + price
// fetching happen in the browser), so no Node server is required at runtime.
//
// For a project page (https://<user>.github.io/<repo>/) the assets live under a
// sub-path, so set NEXT_PUBLIC_BASE_PATH=/<repo> at build time (the Pages workflow
// does this automatically). For a user/org page or custom domain, leave it empty.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
