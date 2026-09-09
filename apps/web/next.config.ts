import type { NextConfig } from 'next';

const API = process.env.HRM_API_ORIGIN ?? 'http://localhost:4000';

const config: NextConfig = {
  // Proxy the API through Next so the session cookie is same-origin. This removes CORS and
  // credentialed-fetch handling from the demo's failure surface entirely.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};

export default config;
