// studio/proto-view.mjs
//
// Router for the Diagnose/Remediate UX prototypes (docs/UX_REDESIGN_BRIEF.md).
// Activated ONLY by the ?proto=a|b|c query param — production tabs are
// untouched without it. Each variant supplies its own Diagnose and
// Remediate renderer; a floating switcher pill flips between variants
// (full navigation — persistence restores the loaded packs).
//
//   a — Verdict-first narrative   hero verdict + biggest gap, chaptered evidence
//   b — Mission control           KPI tile band + glanceable panel grid
//   c — Guided flow               stepper diagnose + triage-queue remediate

import { renderProtoDiagnoseA, renderProtoRemediateA } from './proto-a.mjs';
import { renderProtoDiagnoseB, renderProtoRemediateB } from './proto-b.mjs';
import { renderProtoDiagnoseC, renderProtoRemediateC } from './proto-c.mjs';

export function activeProtoVariant() {
  try {
    const p = (new URLSearchParams(window.location.search).get('proto') || '').toLowerCase();
    return ['a', 'b', 'c'].includes(p) ? p : null;
  } catch (_) { return null; }
}

export function protoActive() { return !!activeProtoVariant(); }

const VARIANTS = {
  a: { name: 'A · Verdict-first', diagnose: renderProtoDiagnoseA, remediate: renderProtoRemediateA },
  b: { name: 'B · Mission control', diagnose: renderProtoDiagnoseB, remediate: renderProtoRemediateB },
  c: { name: 'C · Guided flow', diagnose: renderProtoDiagnoseC, remediate: renderProtoRemediateC },
};

export function renderProtoDiagnose(view) {
  const v = VARIANTS[activeProtoVariant()];
  mountSwitcher();
  view.classList.add('proto-host');
  v.diagnose(view);
}

export function renderProtoRemediate(view) {
  const v = VARIANTS[activeProtoVariant()];
  mountSwitcher();
  view.classList.add('proto-host');
  v.remediate(view);
}

// Floating variant switcher — fixed pill, bottom-left (the toast lives
// bottom-right). Navigates with the query param so a variant can be
// linked/screenshotted directly; localStorage persistence restores the
// loaded packs and active tab across the reload.
function mountSwitcher() {
  if (document.getElementById('proto-switcher')) return;
  const cur = activeProtoVariant();
  const el = document.createElement('nav');
  el.id = 'proto-switcher';
  el.className = 'proto-switcher';
  el.setAttribute('aria-label', 'UX prototype switcher');
  const link = (q, label, active) =>
    `<a class="proto-switcher-btn${active ? ' is-active' : ''}" href="?proto=${q}">${label}</a>`;
  el.innerHTML = `
    <span class="proto-switcher-key">PROTOTYPE</span>
    ${link('a', 'A', cur === 'a')}
    ${link('b', 'B', cur === 'b')}
    ${link('c', 'C', cur === 'c')}
    <a class="proto-switcher-btn is-exit" href="${window.location.pathname}" title="Leave prototype mode">×</a>
  `;
  document.body.appendChild(el);
}
