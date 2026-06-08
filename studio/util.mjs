// studio/util.mjs
//
// Small shared helpers used across the studio views: HTML escaping, the
// transient toast, and relative-time formatting. Leaf module — depends only
// on the $ DOM helper from state.mjs.

import { $ } from './state.mjs';

// Escape a value for safe interpolation into an HTML template string.
export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// Transient status message in the bottom toast. kind: '' | 'error' | 'ok' …
export function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (kind ? ' is-' + kind : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 4000);
}

// "5s ago" / "12m ago" / "3h ago" / "2d ago" from an ISO timestamp.
export function fmtRelative(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 90)        return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 90)        return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 36)       return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
