import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typedRoutes: true,
  // The API contract lives in ../server/src/contract, outside this app's root.
  experimental: { externalDir: true },
  // `npm run typecheck` and the repository's `eslint .` already check types and lint; the build does not repeat them.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
