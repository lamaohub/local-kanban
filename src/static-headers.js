
/** A `set(name, value)` for whichever object @fastify/static handed to `setHeaders`. */
export function headerSetter(target) {
  return typeof target.header === 'function'
    ? (name, value) => { target.header(name, value); }
    : (name, value) => { target.setHeader(name, value); };
}

// The page, its scripts and its styles must come from one version of the board. `no-cache` does not
// ensure that: WebKit loads a restored window and back/forward navigation from its cache without asking
// the server, and markup from one version run by code from another fails to start. What is never
// stored cannot be loaded stale, so the app itself is not stored; icons and the manifest are still
// revalidated on every use.
const APP_SHELL = /\.(?:html?|m?js|css)$/i;

/** Cache-Control for a file served from public/. */
export function cacheControlFor(path) {
  return APP_SHELL.test(String(path || '')) ? 'no-store' : 'no-cache';
}

/** `setHeaders` of the public/ mount: caching as above plus the protective headers. */
export function appShellHeaders(csp) {
  return (target, path) => {
    const set = headerSetter(target);
    set('Cache-Control', cacheControlFor(path));
    set('Content-Security-Policy', csp);
    set('X-Content-Type-Options', 'nosniff');
    set('Referrer-Policy', 'no-referrer');
  };
}
