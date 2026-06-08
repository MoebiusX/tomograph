// studio/references-view.mjs
//
// The References view (Advanced) — the curated, evidence-cited best-practice
// reference packs, each with a "Benchmark vs …" action that loads it as Pack
// B and opens the drift drill. This is the first orchestration-coupled view
// module: it imports the re-render entrypoint and a couple of shared actions
// from app.mjs. That edge is a deliberate cycle, but a safe one — every
// app.mjs import here is a hoisted function (or a const read only at click
// time), never touched during module evaluation.

import { state } from './state.mjs';
import { escapeHtml } from './util.mjs';
import { renderMainView, runBenchmark, loadAndCacheReferences, LENS_PRODUCTS } from './app.mjs';

export function renderReferencesView(view) {
  const refs = state._referencesCache || [];
  // Cache may not be warm yet (boot race / failed fetch) — kick a load
  // and re-render when it lands.
  if (!refs.length) {
    loadAndCacheReferences().then(list => {
      if (list?.length && state.view === 'references') renderMainView();
    });
  }

  const section = document.createElement('section');
  section.className = 'section refs-view';
  section.dataset.layer = 'REF';

  const slugFor = (id) => (LENS_PRODUCTS.find(lp => lp.refPackId === id) || {}).slug || null;
  const hasPackA = !!state.pack;

  const cards = refs.map(p => {
    const slug = slugFor(p.id);
    const envs = (p.environments || []).join(' · ');
    const ok = p.ok !== false;
    const canBenchmark = ok && hasPackA && !!slug;
    const btn = canBenchmark
      ? `<button type="button" class="refs-bench-btn" data-product="${escapeHtml(slug)}" data-ref-pack="${escapeHtml(p.id)}"
           title="Load ${escapeHtml(p.label)} as Pack B and compare your pack against it.">⛯ Benchmark vs ${escapeHtml(p.label)} →</button>`
      : `<span class="refs-bench-hint">${ok
            ? (hasPackA ? 'No product lens for this pack' : 'Load a pack in Discover to benchmark')
            : 'Reference pack failed to load'}</span>`;
    return `
      <article class="refs-card${ok ? '' : ' is-error'}">
        <div class="refs-card-head">
          <span class="refs-card-name">${escapeHtml(p.label || p.name || p.id)}</span>
          ${p.version ? `<span class="refs-card-ver">v${escapeHtml(p.version)}</span>` : ''}
        </div>
        ${p.description ? `<p class="refs-card-desc">${escapeHtml(p.description)}</p>` : ''}
        <div class="refs-card-meta">
          ${p.criticality ? `<span class="refs-card-tag">${escapeHtml(p.criticality)}</span>` : ''}
          ${envs ? `<span class="refs-card-envs">${escapeHtml(envs)}</span>` : ''}
        </div>
        <div class="refs-card-foot">${btn}</div>
      </article>
    `;
  }).join('');

  section.innerHTML = `
    <div class="refs-head">
      <h2 class="refs-title">Reference Component Analysis</h2>
      <p class="refs-sub">Curated, evidence-cited best-practice packs for well-known
        observability components. Benchmark your pack against one to see how your
        posture compares — the drift drill opens in <strong>Diagnose → Compare</strong>.</p>
      ${hasPackA ? '' : '<p class="refs-note">Load a pack in <strong>Discover</strong> first to enable benchmarking.</p>'}
    </div>
    <div class="refs-grid">
      ${cards || '<div class="refs-empty">Loading reference packs…</div>'}
    </div>
  `;

  section.querySelectorAll('.refs-bench-btn').forEach(b => {
    b.addEventListener('click', () => runBenchmark(b.dataset.product, b.dataset.refPack));
  });

  view.appendChild(section);
}
