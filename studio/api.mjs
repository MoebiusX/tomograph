// studio/api.mjs
//
// The studio's thin HTTP layer. Every server call goes through `api()`,
// which sniffs for the HTML fallback a stale server can return at 200 and
// turns it into a clear, actionable error rather than a JSON parse crash.
// Pure of UI; depends only on `state` (to cache the pack catalog). Imported
// by app.mjs and the view modules.

import { state } from './state.mjs';

export async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { Accept: 'application/json' }, ...opts });
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
    headers: { 'Content-Type': contentType, Accept: 'application/json' },
    body,
  });
  return r.json();
}
