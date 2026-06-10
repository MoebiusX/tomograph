// tools/lib/slug.mjs
//
// The three slug flavours used across the toolchain, in one place. They are
// deliberately different — filenames want '-', PromQL-safe symbols want '_',
// and wire-derived service names need a fallback + length cap — so each is
// exported under a name that says which contract it satisfies.

// Dash slug for filenames and pack ids: lowercase, non [a-z0-9_-] → '-',
// runs collapsed, edges trimmed. May return '' for all-junk input.
export function fileSlug(s, fallback = 'pack') {
  if (typeof s !== 'string') return fallback;
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// fileSlug plus a minimum-length fallback and 50-char cap — for service
// names coming off the wire, where '' or a single junk char isn't a usable id.
export function serviceSlug(s, fallback = 'svc') {
  if (typeof s !== 'string' || !s) return fallback;
  const cleaned = fileSlug(s, fallback);
  if (cleaned.length < 2) return fallback;
  return cleaned.slice(0, 50);
}

// Underscore slug for symbol identifiers (PromQL rule/metric names):
// lowercase, non [a-z0-9-] runs → '_', edges trimmed.
export function symbolSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '_').replace(/^_+|_+$/g, '');
}
