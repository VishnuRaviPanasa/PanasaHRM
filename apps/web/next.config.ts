import type { NextConfig } from 'next';

const API = process.env.HRM_API_ORIGIN ?? 'http://localhost:4000';

const config: NextConfig = {
  /*
   * A self-contained server bundle, for the container image.
   *
   * Without this the runtime image has to carry the whole `node_modules` tree - hundreds of
   * megabytes, most of it build-time only. `standalone` emits just the files the server actually
   * reaches, which is what the Dockerfile copies.
   */
  output: 'standalone',
  // Proxy the API through Next so the session cookie is same-origin. This removes CORS and
  // credentialed-fetch handling from the demo's failure surface entirely.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};

export default config;
