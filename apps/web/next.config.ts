import path from 'node:path';
import type { NextConfig } from 'next';

const API = process.env.HRM_API_ORIGIN ?? 'http://localhost:4000';

/**
 * The public path prefix, applied at BUILD time (see lib/base-path.ts for the full reasoning).
 * Empty = served at the root, which is what local development uses and what every check in
 * `testing/demo` assumes.
 */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

const config: NextConfig = {
  // Proxy the API through Next so the session cookie is same-origin. This removes CORS and
  // credentialed-fetch handling from the demo's failure surface entirely.
  //
  // In the production stack the edge nginx routes /api/ to the API container before Next sees
  // it, so this rewrite is the development path and a fallback, not the hot path.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },

  ...(basePath ? { basePath, assetPrefix: basePath } : {}),

  // A traced, self-contained server for the runtime image - no `npm install` in the final
  // stage, no dev dependencies on the production host.
  output: 'standalone',

  // Trace from the REPOSITORY root, not apps/web. This is an npm-workspaces monorepo, so the
  // hoisted node_modules lives two levels up; without this Next roots the trace at apps/web and
  // the standalone bundle silently omits hoisted dependencies.
  outputFileTracingRoot: path.join(__dirname, '../..'),
};

export default config;
