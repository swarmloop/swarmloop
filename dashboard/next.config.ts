import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typedRoutes: true,
  // The API contract lives in ../server/src/contract, outside this app's root.
  experimental: { externalDir: true },
};

export default nextConfig;
