/** @type {import('next').NextConfig} */
const nextConfig = {
  // Puppeteer ships a bundled Chromium that's huge and breaks
  // Turbopack's server bundling — it tries to inline the native
  // binary and the .next dir balloons to hundreds of MB while the
  // dev server thrashes the CPU. Listing puppeteer as a server-
  // external package makes Next.js leave it as a runtime
  // node_modules require — server bundle stays tiny, dev server
  // stays responsive.
  serverExternalPackages: ["puppeteer"],
}

export default nextConfig
