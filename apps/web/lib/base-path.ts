/**
 * The public path prefix the app is served under.
 *
 * WHY THIS EXISTS
 *
 * The production host runs several applications behind one nginx that terminates TLS and
 * path-routes them (`/hr-agent/`, `/chatbot/`, ...). PanasaHRM gets `/panasa-hrm/`, so every
 * URL the app emits has to carry that prefix.
 *
 * Next handles most of it: with `basePath` set, `<Link href>`, `router.push`, the router's own
 * asset URLs and `next/image` are all rewritten. It does NOT rewrite anything the app builds
 * itself out of a root-absolute string - `fetch('/api/...')`, a raw `<img src="/...">`, or an
 * assignment to `window.location.href`. Those are the callers of this module.
 *
 * BUILD TIME, NOT RUNTIME. `NEXT_PUBLIC_*` is inlined by the compiler, and Next resolves
 * `basePath` during the build. Changing the prefix means rebuilding the web image; the compose
 * file passes it as a build arg for exactly that reason.
 *
 * Empty (the default) means the app is served at the root of its port, and every template below
 * produces the same string it always did.
 */

/** '' or '/panasa-hrm' - never with a trailing slash. */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

/**
 * Prefix a root-absolute application path.
 *
 * Use it for anything the app hands to the browser as a literal URL. Do NOT use it on a
 * `<Link href>` or a `router.push` - Next has already applied the prefix there, and applying it
 * twice produces `/panasa-hrm/panasa-hrm/...`.
 */
export const withBasePath = (path: string): string => `${BASE_PATH}${path}`;
