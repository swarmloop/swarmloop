import type { NextConfig } from 'next';

const api = process.env.SWARMLOOP_API_URL ?? 'http://127.0.0.1:3920';

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: '/swarmloop-api/:path*', destination: `${api}/:path*` }];
  },
};

export default nextConfig;
