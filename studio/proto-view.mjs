// studio/proto-view.mjs
//
// Gate for the Diagnose/Remediate redesign prototype. ANY ?proto value
// activates the synthesis (studio/proto-synthesis.mjs); without the
// query param the production tabs render untouched. The maintainer's
// 2026-06-11 call: redesign stays in prototype space until ratified.

import { renderSynthDiagnose, renderSynthRemediate } from './proto-synthesis.mjs';

export function protoActive() {
  try { return !!new URLSearchParams(window.location.search).get('proto'); }
  catch (_) { return false; }
}

export function renderProtoDiagnose(view) {
  mountSwitcher();
  view.classList.add('proto-host');
  renderSynthDiagnose(view);
}

export function renderProtoRemediate(view) {
  mountSwitcher();
  view.classList.add('proto-host');
  renderSynthRemediate(view);
}

// Floating pill, bottom-left (the toast lives bottom-right): names the
// active prototype, one click exits back to production.
function mountSwitcher() {
  if (document.getElementById('proto-switcher')) return;
  const el = document.createElement('nav');
  el.id = 'proto-switcher';
  el.className = 'proto-switcher';
  el.setAttribute('aria-label', 'UX prototype switcher');
  el.innerHTML = `
    <span class="proto-switcher-key">PROTOTYPE</span>
    <span class="proto-switcher-btn is-active">SYNTHESIS</span>
    <a class="proto-switcher-btn is-exit" href="${window.location.pathname}" title="Leave prototype mode — back to the production tabs">×</a>
  `;
  document.body.appendChild(el);
}
