// studio/api.mjs
//
// The studio's thin HTTP layer. Every server call goes through `api()`,
// which sniffs for the HTML fallback a stale server can return at 200 and
// turns it into a clear, actionable error rather than a JSON parse crash.
// Pure of UI; depends only on `state` (to cache the pack catalog). Imported
// by app.mjs and the view modules.

import { state } from './state.mjs';

// Session-authenticated mutations must carry this header (CSRF defence
// in identity mode — see server/auth.mjs). Sent on every studio request;
// the server ignores it outside identity mode.
export const CSRF_HEADER = { 'X-Tomograph-CSRF': '1' };

export async function api(path, opts = {}) {
  // Merge headers instead of replacing them, so callers passing their own
  // Content-Type keep Accept + the CSRF header.
  const r = await fetch(path, {
    ...opts,
    headers: { Accept: 'application/json', ...CSRF_HEADER, ...(opts.headers || {}) },
  });
  if (r.status === 401) {
    // Identity mode: the server points at the login page — go there.
    const body = await r.clone().json().catch(() => null);
    if (body?.login) { window.location.assign(body.login); throw new Error('signed out — redirecting to login'); }
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText} on ${path}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  // Some routes might be missing on a stale server, returning an HTML
  // fallback even at 200. Sniff the content-type first.
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const body = await r.text().catch(() => '');
    throw new Error(`${path}: server returned non-JSON (${ct || 'no content-type'}, ${r.status}). Restart \`npm run dev\` if the route is new.${body ? '\n' + body.slice(0, 200) : ''}`);
  }
  return r.json();
}

export async function loadCatalog() {
  const { packs } = await api('/api/packs');
  state.catalog = packs || [];
}

export async function validateUploaded(body, contentType, env) {
  const q = env ? `?env=${encodeURIComponent(env)}` : '';
  const r = await fetch(`/api/validate${q}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, Accept: 'application/json', ...CSRF_HEADER },
    body,
  });
  // /api/validate reports schema failures as JSON with a non-2xx status, so
  // only treat the response as an error when it isn't JSON at all (e.g. the
  // HTML fallback from a stale server, or a proxy error page).
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await r.text().catch(() => '');
    throw new Error(`/api/validate: server returned non-JSON (${ct || 'no content-type'}, ${r.status}). Restart \`npm run dev\` if the route is new.${text ? '\n' + text.slice(0, 200) : ''}`);
  }
  return r.json();
}
