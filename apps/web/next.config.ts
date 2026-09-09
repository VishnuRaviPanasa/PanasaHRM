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
  //
  // In the production stack the edge nginx routes /api/ to the API container before Next sees
  // it, so this rewrite is the development path and a fallback, not the hot path.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },

  ...(basePath ? { basePath, assetPrefix: basePath } : {}),

  /*
   * PRODUCTION INCIDENT, 2026-09-09: ERR_TOO_MANY_REDIRECTS on every login.
   *
   * With `basePath` set, Next treats `/panasa-hrm` (no trailing slash) as the canonical root URL
   * and 308-redirects `/panasa-hrm/` to it. The host nginx has the opposite opinion for every app
   * on that shared box, PanasaHRM included (NGINX-DEPLOY-GUIDE.md step 2):
   * `location = /panasa-hrm { return 301 /panasa-hrm/; }`. Two proxies, two answers, same URL:
   *
   *   /panasa-hrm/  --[Next: 308]-->  /panasa-hrm  --[host nginx: 301]-->  /panasa-hrm/  --> ...
   *
   * Confirmed directly against the container, bypassing the host nginx entirely:
   * `curl 127.0.0.1:4788/panasa-hrm/` came back `308 Permanent Redirect` -> `Location: /panasa-hrm`
   * - proving the redirect originates in Next, not in either nginx hop (neither has a `return 30x`
   * anywhere near this path).
   *
   * `skipTrailingSlashRedirect` is Next's documented answer to exactly this: a proxy in front
   * already owns the trailing-slash decision, so Next must not also have one. It does not change
   * the URL any route resolves to (still no trailing slash internally) - it only stops Next from
   * bouncing a request that already arrived with one, which is precisely what the host nginx
   * sends it. Removing it would reopen this loop the next time anyone touches this file.
   */
  skipTrailingSlashRedirect: true,

  // Trace from the REPOSITORY root, not apps/web. This is an npm-workspaces monorepo, so the
  // hoisted node_modules lives two levels up; without this Next roots the trace at apps/web and
  // the standalone bundle silently omits hoisted dependencies.
  outputFileTracingRoot: path.join(__dirname, '../..'),
};

export default config;
