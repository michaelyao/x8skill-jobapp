/** @type {import('next').NextConfig} */
const nextConfig = {
  // The console imports types and pure fs/fetch readers from ../src. It must NEVER import
  // anything under src/core or src/agent/drivers — those pull in Playwright, which has no
  // business inside a request handler (see DESIGN.md: the site never drives a browser).
  experimental: { externalDir: true },
  // The shared modules under ../src are ESM TypeScript: they import each other with explicit
  // ".js" specifiers (correct for node16/tsx at runtime). Webpack must map those back to the
  // .ts sources, or every cross-file import from src/ fails to resolve.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
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
