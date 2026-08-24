/** @type {import('next').NextConfig} */
const nextConfig = {
  // The console imports types and pure fs/fetch readers from ../src. It must NEVER import
  // anything under src/core or src/agent/drivers — those pull in Playwright, which has no
  // business inside a request handler (see DESIGN.md: the site never drives a browser).
  experimental: { externalDir: true },
  // The shared modules under ../src are ESM TypeScript: they import each other with explicit
  // ".js" specifiers (correct for node16/tsx at runtime). Webpack must map those back to the
  // .ts sources, or every cross-file import from src/ fails to resolve.
  webpack: (config, { webpack, nextRuntime }) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    // instrumentation.ts is bundled for the EDGE runtime too (middleware.ts puts the edge
    // compiler in play), and it reaches the 8-hour tick, which reaches node:fs and node:path
    // through @core/*. The NEXT_RUNTIME guard and the lazy import are not enough by themselves:
    // webpack still FOLLOWS the import while bundling and the edge build dies with
    // "Reading from node:fs is not handled by plugins". Drop the node-only half from the edge
    // bundle — register() returns before touching it there, so nothing is lost.
    if (nextRuntime === "edge") {
      config.plugins.push(
        new webpack.IgnorePlugin({ resourceRegExp: /^\.\/instrumentation\.node$/ }),
      );
    }
    return config;
  },
  // Behind a reverse proxy terminating TLS for job.studiox8.com.
  poweredByHeader: false,
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
        // This console shows a home address, phone number and EEO self-identification.
        // Keep it out of search engines and out of any embedding page.
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ],
    },
  ],
};

export default nextConfig;
