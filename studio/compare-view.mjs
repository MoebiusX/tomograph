// studio/compare-view.mjs
//
// The Compare / Diagnose machinery — pack-vs-pack diff (loadDiff/refreshDiff),
// the Diagnose sub-views (benchmark, drift drill, posture matrix, diagnostic
// grade, traceability), and the side-by-side Compare view. The largest single
// cluster; its many functions cross-call each other, so they live together.
// Orchestration-coupled: imports the re-render entrypoints, the card opener,
// and a couple of pack helpers back from app.mjs + drawer.mjs.

import { state } from './state.mjs';
import { api } from './api.mjs';
import { escapeHtml, toast } from './util.mjs';
import { LAYER_DEFS, L4_SUBGROUPS } from './constants.mjs';
import { openDrawer } from './drawer.mjs';
import { defaultEnvFor, loadPackB, openDeployModal, renderMainView, renderTabs, refresh } from './app.mjs';
import { cardKey } from './layers-view.mjs';
import { diffEntryLabel } from './artifact-model.mjs';

// ---------- compare view ----------

const COMPARE_LAYERS = [
  { id: 'L1',  name: 'Contract'    },
  { id: 'L2',  name: 'Telemetry'   },
  { id: 'L2X', name: 'Extended'    },
  { id: 'L3',  name: 'Insight'     },
  { id: 'L4',  name: 'Action'      },
  { id: 'L5',  name: 'Validation'  },
  { id: 'GOV', name: 'Governance'  },
];

function defaultCompareB() {
  // First catalog pack that loaded OK and isn't the current A.
  return state.catalog.find(p => p.ok && p.id !== state.selectedPackId)?.id || null;
}

export async function loadDiff() {
  if (!state.selectedPackId || !state.compareBId) { state.diff = null; return; }
  const params = new URLSearchParams({ a: state.selectedPackId, b: state.compareBId });
  if (state.selectedEnv) params.set('aEnv', state.selectedEnv);
  if (state.compareBEnv) params.set('bEnv', state.compareBEnv);
  try {
    const result = await api(`/api/diff?${params}`);
    // Sanity-check the shape so a stale server returning some other JSON
    // doesn't crash later renderers.
    if (!result || !result.summary || !result.layers) {
      throw new Error('server returned an unexpected shape — restart `npm run dev`?');
    }
    state.diff = result;
  } catch (e) {
    state.diff = { error: e.message };
  }
}

export async function refreshDiff() {
  await loadDiff();
  // Don't nullify state.packB here — earlier code paths set it and rely
  // on the diff being decoupled from the pack itself. The previous
  // "invalidate B so the atlas refetches" comment was wrong: the atlas
  // dispatches on state.packB directly, so nulling it here just forced
  // a redundant network round-trip AND silently broke the view nav's
  // "Compare/Atlas appear when B is loaded" rule on every diff refresh.
  renderTabs();
  renderMainView();
}

// ============================================================
// TRACEABILITY VIEW — repo vs live, but actionable
// ============================================================
//
// Compare shows raw deltas per layer. Useful for engineers reading the
// diff first-hand, but it leaves the harder question — "what should I do
// about this?" — to the reader. Traceability answers that by binning
// every artefact across both packs into one of four buckets:
//
//   Aligned             both packs have it AND the shape matches
//   Declared, not verified   only in pack A (the manifest)
//   Verified, not declared   only in pack B (live)
//   Stale declaration   both packs have it but the shapes diverge
//
// Convention: Pack A is treated as the manifest ("declared"), Pack B as
// the live signal ("verified"). The unlock means either pack can be in
// either slot, but most repo-vs-live flows put the repo pack in A and
// the MCP-fetched pack in B (that's where the home screen + the cron
// fetcher both put them).
//
// Severity:
//   - Declared-not-verified on a tier-1 SLI/SLO  → red  (the spec
//     contractually promised an outcome and we can't see it in live)
//   - Stale declaration                           → amber
//   - Everything else                             → neutral
//
// Per-finding actions:
//   - Open      jumps to the layers view + opens the drawer
//   - Suppress  hides the row from this bucket (persisted via tracePrefs)
//   - Resolve   marks the row resolved (persisted via tracePrefs)

const TRACE_LAYERS = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];

// Strip volatile fields before comparing two artefacts for shape equality.
function stripVolatileArt(art) {
  if (!art || typeof art !== 'object') return art;
  // _sub is the L4 sub-group marker we added for flattening.
  // annotations include MCP refresh timestamps and source tags that
  // legitimately differ between repo and live.
  const { _sub, annotations, ...rest } = art;
  return rest;
}

function artefactsShapeEqual(a, b) {
  try { return JSON.stringify(stripVolatileArt(a)) === JSON.stringify(stripVolatileArt(b)); }
  catch (_) { return false; }
}

// Walk both packs and bin every artefact key into a bucket. The key is
// `${layer}::${compareKeyOf(art)}` so the same id in two different
// layers doesn't collide.
function categorizeTrace(packA, packB) {
  const buckets = { aligned: [], declaredNotVerified: [], verifiedNotDeclared: [], stale: [] };
  for (const L of TRACE_LAYERS) {
    const aItems = layerItemsFor(packA, L);
    const bItems = layerItemsFor(packB, L);
    const aMap = new Map();
    const bMap = new Map();
    for (const it of aItems) {
      const k = compareKeyOf(it);
      if (k) aMap.set(k, it);
    }
    for (const it of bItems) {
      const k = compareKeyOf(it);
      if (k) bMap.set(k, it);
    }
    const allKeys = new Set([...aMap.keys(), ...bMap.keys()]);
    for (const k of allKeys) {
      const a = aMap.get(k);
      const b = bMap.get(k);
      const findingKey = `${L}::${k}`;
      const layerTier = packA?.meta?.criticality || packB?.meta?.criticality || 'tier-3';
      if (a && b) {
        if (artefactsShapeEqual(a, b)) buckets.aligned.push({ layer: L, key: k, findingKey, a, b, tier: layerTier });
        else buckets.stale.push({ layer: L, key: k, findingKey, a, b, tier: layerTier });
      } else if (a) {
        buckets.declaredNotVerified.push({ layer: L, key: k, findingKey, a, tier: layerTier });
      } else {
        buckets.verifiedNotDeclared.push({ layer: L, key: k, findingKey, b, tier: layerTier });
      }
    }
  }
  return buckets;
}

// Severity hint for a finding. Tier-1 SLIs/SLOs that are declared but
// not verified are the red flags. Stale is always amber. Everything
// else is neutral.
function traceFindingSeverity(bucket, finding) {
  if (bucket === 'declaredNotVerified') {
    if (finding.tier === 'tier-1' && finding.layer === 'L1') return 'red';
    return 'neutral';
  }
  if (bucket === 'stale') return 'amber';
  return 'neutral';
}

const BUCKET_META = {
  aligned:             { label: 'Aligned',                blurb: 'Declared in repo AND shape matches in live. Nothing to do.' },
  declaredNotVerified: { label: 'Declared, not verified', blurb: 'In the repo manifest but absent from live. Stale spec, or live collection broken.' },
  verifiedNotDeclared: { label: 'Verified, not declared', blurb: 'Live signal exists with no entry in the repo. Drift or out-of-band telemetry.' },
  stale:               { label: 'Stale declaration',      blurb: 'Both sides have it, but the live shape diverges from the declared shape. Reconcile.' },
};

function ensureTracePrefs() {
  if (!state.tracePrefs || typeof state.tracePrefs !== 'object') state.tracePrefs = { suppressed: [], resolved: [] };
  if (!Array.isArray(state.tracePrefs.suppressed)) state.tracePrefs.suppressed = [];
  if (!Array.isArray(state.tracePrefs.resolved))   state.tracePrefs.resolved = [];
}

function isTraceSuppressed(findingKey) {
  ensureTracePrefs();
  return state.tracePrefs.suppressed.includes(findingKey);
}
function isTraceResolved(findingKey) {
  ensureTracePrefs();
  return state.tracePrefs.resolved.includes(findingKey);
}
function toggleTraceSuppressed(findingKey) {
  ensureTracePrefs();
  const i = state.tracePrefs.suppressed.indexOf(findingKey);
  if (i >= 0) state.tracePrefs.suppressed.splice(i, 1);
  else state.tracePrefs.suppressed.push(findingKey);
}
function toggleTraceResolved(findingKey) {
  ensureTracePrefs();
  const i = state.tracePrefs.resolved.indexOf(findingKey);
  if (i >= 0) state.tracePrefs.resolved.splice(i, 1);
  else state.tracePrefs.resolved.push(findingKey);
}

export function renderTraceabilityView(host) {
  ensureTracePrefs();
  const section = document.createElement('section');
  section.className = 'section trace-view';
  section.dataset.layer = 'TRACE';

  if (!state.pack || !state.packB) {
    section.innerHTML = '<div class="placeholder">Load Pack A and Pack B first.</div>';
    host.appendChild(section);
    return;
  }

  const buckets = categorizeTrace(state.pack, state.packB);
  const suppressedSet = new Set(state.tracePrefs.suppressed);
  const resolvedSet   = new Set(state.tracePrefs.resolved);

  // Section head with totals.
  const totalAligned = buckets.aligned.length;
  const totalDnV     = buckets.declaredNotVerified.length;
  const totalVnD     = buckets.verifiedNotDeclared.length;
  const totalStale   = buckets.stale.length;
  const total        = totalAligned + totalDnV + totalVnD + totalStale;
  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <span class="section-num">TRC</span>
    <span class="section-name">Traceability · pack A (declared) vs pack B (verified)</span>
    <span class="section-count">${total} artefact${total === 1 ? '' : 's'}</span>
  `;
  section.appendChild(head);

  const lede = document.createElement('div');
  lede.className = 'trace-lede';
  lede.innerHTML = `
    Pack A is treated as the manifest (<em>declared</em>) and Pack B as the live signal (<em>verified</em>).
    Every artefact lands in one of four buckets; per-row actions persist locally so suppressions and
    resolutions survive a refresh.
  `;
  section.appendChild(lede);

  // Headline cards — one per bucket. Click to scroll to its section.
  const headlineGrid = document.createElement('div');
  headlineGrid.className = 'trace-headline-grid';
  const order = ['aligned', 'declaredNotVerified', 'verifiedNotDeclared', 'stale'];
  for (const key of order) {
    const items = buckets[key];
    const meta  = BUCKET_META[key];
    const count = items.length;
    const open  = state.traceOpen?.[key];
    const card  = document.createElement('button');
    card.type = 'button';
    card.className = 'trace-headline trace-headline-' + key;
    card.dataset.open = String(!!open);
    card.innerHTML = `
      <div class="trace-headline-key">${escapeHtml(meta.label)}</div>
      <div class="trace-headline-count">${count}</div>
      <div class="trace-headline-blurb">${escapeHtml(meta.blurb)}</div>
    `;
    card.onclick = () => {
      if (!state.traceOpen) state.traceOpen = {};
      state.traceOpen[key] = !state.traceOpen[key];
      renderMainView();
    };
    headlineGrid.appendChild(card);
  }
  section.appendChild(headlineGrid);

  // Per-bucket details. Each finding row carries Open / Suppress / Resolve.
  for (const key of order) {
    const items = buckets[key];
    const meta  = BUCKET_META[key];
    const open  = !!state.traceOpen?.[key];
    const block = document.createElement('div');
    block.className = 'trace-block trace-block-' + key;
    block.hidden = !open;

    const blockHead = document.createElement('div');
    blockHead.className = 'trace-block-head';
    blockHead.innerHTML = `
      <span class="trace-block-label">${escapeHtml(meta.label)}</span>
      <span class="trace-block-count">${items.length}</span>
    `;
    block.appendChild(blockHead);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'trace-empty';
      empty.textContent = 'no findings in this bucket';
      block.appendChild(empty);
      section.appendChild(block);
      continue;
    }

    // Hide suppressed rows by default; reveal under a "show suppressed" toggle.
    const visible    = items.filter(f => !suppressedSet.has(f.findingKey));
    const suppressed = items.filter(f =>  suppressedSet.has(f.findingKey));

    const list = document.createElement('div');
    list.className = 'trace-list';
    for (const f of visible) list.appendChild(renderTraceRow(key, f, resolvedSet));
    block.appendChild(list);

    if (suppressed.length) {
      const sup = document.createElement('details');
      sup.className = 'trace-suppressed';
      const sum = document.createElement('summary');
      sum.textContent = `${suppressed.length} suppressed finding${suppressed.length === 1 ? '' : 's'}`;
      sup.appendChild(sum);
      const supList = document.createElement('div');
      supList.className = 'trace-list trace-list-suppressed';
      for (const f of suppressed) supList.appendChild(renderTraceRow(key, f, resolvedSet));
      sup.appendChild(supList);
      block.appendChild(sup);
    }
    section.appendChild(block);
  }

  host.appendChild(section);
}

function renderTraceRow(bucketKey, finding, resolvedSet) {
  const sev = traceFindingSeverity(bucketKey, finding);
  const resolved = resolvedSet.has(finding.findingKey);
  const row = document.createElement('div');
  row.className = 'trace-row';
  row.dataset.sev = sev;
  row.dataset.resolved = String(resolved);

  // Side primary — for declaredNotVerified use A, for verifiedNotDeclared use B,
  // for stale + aligned use A (it's the manifest).
  const primary = (bucketKey === 'verifiedNotDeclared') ? finding.b : finding.a;
  const title = primary?.title || primary?.id || primary?.defines || finding.key;
  const sub   = primary?.desc || primary?.tool || '';

  row.innerHTML = `
    <div class="trace-row-pill">
      <span class="trace-row-layer">${escapeHtml(finding.layer)}</span>
      <span class="trace-row-sev" data-sev="${sev}">${sev === 'red' ? '✕' : sev === 'amber' ? '⚠' : '·'}</span>
    </div>
    <div class="trace-row-body">
      <div class="trace-row-title">${escapeHtml(String(title || finding.key))}</div>
      <div class="trace-row-sub">${escapeHtml(sub)}</div>
      <div class="trace-row-key"><code>${escapeHtml(finding.findingKey)}</code></div>
    </div>
    <div class="trace-row-actions">
      <button type="button" class="trace-action" data-act="open" title="Open the artefact drawer on the Layers view">open</button>
      <button type="button" class="trace-action" data-act="resolve" title="Toggle resolved (persists locally)">${resolved ? '✓ resolved' : 'mark resolved'}</button>
      <button type="button" class="trace-action" data-act="suppress" title="Hide this finding from the bucket (persists locally)">suppress</button>
    </div>
  `;

  row.querySelector('[data-act="open"]').onclick = () => {
    state.view = 'layers';
    state.layerFilter = finding.layer === 'L4' ? 'L4' : finding.layer;
    state.activeLayer = finding.layer;
    state.activeCardKey = finding.key;
    renderTabs();
    renderMainView();
    // Open the drawer for the artefact if we can find it.
    const pack = (bucketKey === 'verifiedNotDeclared') ? state.packB : state.pack;
    const items = layerItemsFor(pack, finding.layer);
    const art = items.find(it => compareKeyOf(it) === finding.key);
    if (art) {
      const layerDef = LAYER_DEFS.find(d => d.id === finding.layer) || { id: finding.layer };
      try { openDrawer(art, layerDef, null); } catch (_) {}
    }
  };
  row.querySelector('[data-act="resolve"]').onclick = () => { toggleTraceResolved(finding.findingKey); renderMainView(); };
  row.querySelector('[data-act="suppress"]').onclick = () => { toggleTraceSuppressed(finding.findingKey); renderMainView(); };
  return row;
}

// ============================================================
// Benchmark view (Phase 4)
//
// A focused destination — answers "how does PACK A's posture for
// <product> compare to PACK B as the reference?" Built on the same
// machinery as Compare (productSurface lens + buildCompareKeySets)
// but framed as a scorecard rather than a free-form side-by-side.
//
//   ┌─────────────────────────────────────────────────────────────┐
//   │  BENCHMARK: krystaline-live  vs  grafana-reference          │
//   │  Lens: [Grafana ▼]                                          │
//   │                                                             │
//   │   Coverage      Per-layer       Verified by MCP             │
//   │     14%         L1 0/16         29 backends                 │
//   │                 L2 1/1          live versions: Grafana 12.4 │
//   │                 L3 6/31                                     │
//   │                 L4 0/17                                     │
//   │                 L5 0/8                                      │
//   ├─────────────────────────────────────────────────────────────┤
//   │  Missing from your live pack (top 10)                       │
//   │   • http_request_success_ratio (SLI)                        │
//   │   • datasource_proxy_success_ratio (SLI)                    │
//   │   • burn-rate alert: http_request_success_99_9 (POL)        │
//   │   • …                                                       │
//   ├─────────────────────────────────────────────────────────────┤
//   │  In your live pack but not in the reference (top 5)         │
//   │   • adz2hpb (custom DASH)                                   │
//   │   • …                                                       │
//   ├─────────────────────────────────────────────────────────────┤
//   │  Side-by-side                                               │
//   │  [the same lens-scoped compare grid as Compare view]        │
//   └─────────────────────────────────────────────────────────────┘
// ============================================================
// DIAGNOSE sub-tab nav. The three MAIN journey tabs (Discover · Diagnose ·
// Remediate) are unchanged; this split lives entirely INSIDE Diagnose:
//   · Diagnostic Grade — the YES/NO verdict + coverage/trust/evidence report
//   · Compare          — the artefact-level A-vs-B side-by-side diff
// Switching is local (state.diagnoseSub) and persisted.
function renderDiagnoseSubnav(active) {
  const nav = document.createElement('div');
  nav.className = 'diag-subnav';
  const tabs = [
    { id: 'grade',   label: 'Diagnostic Grade', sub: 'is it good enough?' },
    { id: 'compare', label: 'Compare',          sub: 'A vs B — what differs?' },
  ];
  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'diag-subtab' + (t.id === active ? ' is-active' : '');
    btn.dataset.sub = t.id;
    btn.innerHTML = `
      <span class="diag-subtab-label">${escapeHtml(t.label)}</span>
      <span class="diag-subtab-sub">${escapeHtml(t.sub)}</span>
    `;
    btn.addEventListener('click', () => {
      if (state.diagnoseSub === t.id) return;
      state.diagnoseSub = t.id;
      renderMainView();
    });
    nav.appendChild(btn);
  }
  return nav;
}

export function renderBenchmarkView(view) {
  // Sub-tabs under DIAGNOSE: Diagnostic Grade (the verdict report) and
  // Compare (the artefact-level A-vs-B side-by-side). The Compare sub-tab
  // restores the dedicated side-by-side VS view; the grade report stays
  // exactly as-is beneath its own sub-tab.
  const sub = state.diagnoseSub === 'compare' ? 'compare' : 'grade';
  view.appendChild(renderDiagnoseSubnav(sub));
  if (sub === 'compare') { renderCompareView(view); return; }

  const scaffold = document.createElement('section');
  scaffold.className = 'section benchmark-view';
  scaffold.dataset.layer = 'BENCHMARK';
  view.appendChild(scaffold);

  // Pack A is guaranteed by the dispatcher. Pack B is OPTIONAL: with A
  // alone we answer the killer question (diagnostic-grade YES/NO) from
  // coverage + drift evidence carried in Pack A itself. Loading a Pack B
  // (via the header picker — we never duplicate it here) unlocks the
  // A-vs-B comparison for drift-vs-deployed or gap-vs-target analysis.
  const haveB = !!state.packB;

  // If the user picked a Pack B but it (or the diff) hasn't loaded yet,
  // fetch them and re-render so the comparison enriches the verdict.
  if (state.compareBId && (!haveB || (!state.diff && !state.diff?.error))) {
    const loading = document.createElement('div');
    loading.className = 'placeholder';
    loading.textContent = 'Loading comparison pack…';
    scaffold.appendChild(loading);
    Promise.all([
      haveB ? Promise.resolve() : loadPackB(),
      (state.diff && !state.diff.error) ? Promise.resolve() : loadDiff(),
    ]).then(() => { renderTabs(); renderMainView(); });
    return;
  }

  // Auto-apply the lens when Pack B is a *-reference catalogue pack.
  // Picking grafana-reference IS choosing the Grafana benchmark; no
  // reason to make the user explicitly set the Lens dropdown afterward.
  if (haveB) {
    const bId = String(state.compareBId || state.packB?.id || '').toLowerCase();
    const refMatch = /^([a-z][a-z0-9_-]*?)-reference$/.exec(bId);
    if (refMatch && (state.compareLens === 'all' || !state.compareLens)) {
      const inferredLens = refMatch[1];
      if (LENS_PRODUCTS.some(lp => lp.slug === inferredLens)) {
        state.compareLens = inferredLens;
      }
    }
  }
  const lens = state.compareLens || 'all';

  // Posture matrix — the coverage substrate (Pack-A-derived). Feeds both
  // the verdict's "comprehensive" criterion and the drill-down below.
  const posture = computePostureMatrix(state.pack, state.packB);

  // THE verdict — diagnostic-grade YES/NO from coverage (2A) + trust /
  // drift (2B), Pack A alone. Always leads the view.
  const diagnostic = computeDiagnosticGrade(state.pack, state.packB, posture, state.compareBId);
  const verdict = renderDiagnosticGradeVerdict(diagnostic, lens, state.packB);
  scaffold.appendChild(verdict);

  // The COMPARE band (A-vs-B drill, or the invite to load a Pack B) sits
  // DIRECTLY under the verdict summary band — before the deep 2A/2B/
  // evidence tables — so the side-by-side comparison is the first thing
  // the user sees, not buried beneath the full compliance report.
  const verdictHead = verdict.querySelector('.diag-report-head');
  const placeCompareBand = (el) => {
    if (!el) return;
    if (verdictHead && verdictHead.nextSibling) verdict.insertBefore(el, verdictHead.nextSibling);
    else if (verdictHead) verdict.appendChild(el);
    else scaffold.appendChild(el);
  };
  if (!haveB) {
    // Pack A only — invite a Pack B; the verdict above is the
    // coverage-only read, the A-vs-B comparison the optional deepening.
    placeCompareBand(renderComparePrompt());
  } else {
    // Pack B present — render the true side-by-side A-vs-B drill (drift
    // cells / gap deltas) as the lead evidence beneath the verdict.
    placeCompareBand(renderDriftDrill(state.diff, state.packB, state.compareBId, lens));
  }

  // Drill-down — per-layer × per-mechanism coverage map. Pack-A-derived,
  // so it's the "why" behind the verdict whether or not a Pack B exists.
  scaffold.appendChild(renderBenchmarkHeadline(posture, lens));
  scaffold.appendChild(renderPostureMatrix(posture));
  scaffold.appendChild(renderPostureNarrative(posture));
  scaffold.appendChild(renderPosturePieRow(posture));
}

// Affordance shown in Diagnose when only Pack A is loaded. Points the
// user at the EXISTING header Pack B picker (no duplicate control) and
// names the two comparison use cases. Selecting nothing here is fine —
// the diagnostic verdict above already stands on Pack A alone.
function renderComparePrompt() {
  const el = document.createElement('div');
  el.className = 'compare-prompt';
  el.innerHTML = `
    <div class="compare-prompt-body">
      <span class="compare-prompt-key">COMPARE</span>
      <span class="compare-prompt-text">
        This verdict reads <strong>Pack A on its own</strong>. Load a
        <strong>Pack B</strong> from the <em>PACK B</em> picker in the header to
        compare side-by-side — detect <strong>drift</strong> (declared vs what's
        deployed) or measure the <strong>gap to a target</strong> posture.
      </span>
    </div>
  `;
  return el;
}

// Detect what KIND of comparison Pack B represents so the drill can
// frame the deltas correctly:
//   'gap'   — B is a target / reference / contract ("what good looks
//             like"). onlyInB = the gap to close; onlyInA = beyond target.
//   'drift' — B is the live / deployed system ("what's actually out
//             there"). onlyInA = declared but unconfirmed (drift risk);
//             onlyInB = observed live but undeclared (shadow signal).
// Ambiguous comparisons default to 'gap' — "what's different / missing"
// is the more common intent when benchmarking against another pack.
function compareModeFor(packB, compareBId) {
  const bId = String(compareBId || packB?.id || '').toLowerCase();
  const src = inferPackSource(packB);
  const isLiveLike = /(^|[-_])(live|deployed|prod|runtime)([-_]|$)/.test(bId) || src === 'Live';
  if (isLiveLike) return 'drift';
  return 'gap';
}

// THE A-vs-B drill — the real side-by-side evidence behind the verdict.
// Consumes state.diff (server-computed set arithmetic on the two packs'
// artefact keys) and projects it through the active product lens, then
// frames the three buckets (inBoth / onlyInA / onlyInB) in either drift
// or gap language. Returns null when no usable diff exists so the caller
// can simply skip the section.
function renderDriftDrill(diff, packB, compareBId, lens) {
  if (!diff || diff.error || !diff.layers) return null;

  const mode = compareModeFor(packB, compareBId);
  const useLens = lens && lens !== 'all';

  // Project a bucket entry's artefact (shape varies: onlyIn* carry
  // `.artefact`, inBoth carries `.a`/`.b`). For lens scoping we test
  // the A-side projection (or B-side for onlyInB) against the surface.
  const passesLens = (entry, side) => {
    if (!useLens) return true;
    const art = side === 'b' ? (entry.artefact || entry.b) : (entry.artefact || entry.a);
    const pack = side === 'b' ? packB : state.pack;
    return productSurface(art, lens, pack);
  };

  // Per-layer filtered buckets + running totals.
  const layerNames = { L1:'Contract', L2:'Telemetry', L2X:'Extended', L3:'Insight', L4:'Action', L5:'Validation', GOV:'Governance' };
  let totAligned = 0, totDrifted = 0, totA = 0, totB = 0, totOOS = 0;
  const rows = [];
  for (const L of LAYERS_FOR_DIFF) {
    const bucket = diff.layers[L] || { onlyInA: [], onlyInB: [], inBoth: [], outOfScope: [] };
    // inBoth = shared identity. Split it: structurally-equal pairs are
    // aligned; same-identity-but-divergent pairs are drifted. Matching is
    // an object comparison, not a name check.
    const matched = bucket.inBoth.filter(e => passesLens(e, 'a'));
    const aligned = matched.filter(e => e.match !== 'drifted');
    const drifted = matched.filter(e => e.match === 'drifted');
    const onlyInA = bucket.onlyInA.filter(e => passesLens(e, 'a'));
    const onlyInB = bucket.onlyInB.filter(e => passesLens(e, 'b'));
    // Live members of a family this pack declares nothing of — the rest of the
    // platform inventory. Shown muted, never counted as drift.
    const outOfScope = (bucket.outOfScope || []).filter(e => passesLens(e, 'b'));
    if (aligned.length === 0 && drifted.length === 0 && onlyInA.length === 0
        && onlyInB.length === 0 && outOfScope.length === 0) continue;
    totAligned += aligned.length;
    totDrifted += drifted.length;
    totA += onlyInA.length;
    totB += onlyInB.length;
    totOOS += outOfScope.length;
    rows.push({ L, name: layerNames[L] || L, aligned, drifted, onlyInA, onlyInB, outOfScope });
  }

  const universe = totAligned + totDrifted + totA + totB;
  if (universe === 0) return null;
  const alignedPct = Math.round((totAligned / universe) * 100);

  // Mode-specific framing for the two delta columns.
  const bName = catalogEntryFor(compareBId)?.label || packB?.meta?.name || packB?.metadata?.name || packB?.id || 'Pack B';
  const frame = mode === 'drift'
    ? {
        eyebrow: 'DRIFT · DECLARED vs LIVE',
        lede: totA > 0
          ? `<strong>${totA}</strong> declared artefact${totA === 1 ? '' : 's'} not confirmed in <strong>${escapeHtml(bName)}</strong> — possible drift.`
          : `Every declared artefact is confirmed live in <strong>${escapeHtml(bName)}</strong>.`,
        aLabel: 'Declared, not live',
        aHint: 'in your pack · not seen in the live system → drift risk',
        aClass: 'is-drift',
        bLabel: 'Live, not declared',
        bHint: 'seen live · missing from your pack → shadow signal',
        bClass: 'is-shadow',
      }
    : {
        eyebrow: 'GAP · CURRENT vs TARGET',
        lede: totB > 0
          ? `<strong>${totB}</strong> artefact${totB === 1 ? '' : 's'} in <strong>${escapeHtml(bName)}</strong> you don't have yet — the gap to close.`
          : `You match or exceed <strong>${escapeHtml(bName)}</strong> on every artefact.`,
        aLabel: 'Beyond target',
        aHint: 'in your pack · not in the target → extra coverage',
        aClass: 'is-extra',
        bLabel: 'Missing vs target',
        bHint: 'in the target · not in your pack → gap to close',
        bClass: 'is-gap',
      };

  const wrap = document.createElement('div');
  wrap.className = `benchmark-block drift-drill-block drift-mode-${mode}`;

  // Sample keys for a bucket, using the human artefact title when the
  // server key is a structural projection like sli:{"id":"..."}.
  const sampleKeys = (entries, max = 4) => {
    const names = entries.slice(0, max).map(e => escapeHtml(diffEntryLabel(e)));
    const more = entries.length > max ? ` +${entries.length - max}` : '';
    return names.length ? names.join(' · ') + more : '—';
  };

  // Sample drifted pairs as `name(field,field)` so the reader sees not just
  // WHICH artefacts drifted but WHICH FIELDS diverged.
  const sampleDeltas = (entries, max = 3) => {
    const names = entries.slice(0, max).map(e => {
      const fields = (e.deltas || []).map(d => d.field).slice(0, 3).join(',');
      return escapeHtml(diffEntryLabel(e)) + (fields ? `<span class="drift-delta-fields">(${escapeHtml(fields)})</span>` : '');
    });
    const more = entries.length > max ? ` +${entries.length - max}` : '';
    return names.length ? names.join(' · ') + more : '—';
  };

  // Drift makeup as two donuts: how much aligns (donut 1), then what the
  // non-aligned remainder is made of (donut 2). A legend carries the counts
  // so labels never crowd the rings. Each segment is a dash on a full
  // circle, accumulating clockwise from 12 o'clock.
  const donut = (segs, centerText) => {
    const r = 40, cx = 52, cy = 52, sw = 18, C = 2 * Math.PI * r;
    const total = segs.reduce((s, x) => s + x.value, 0) || 1;
    let acc = 0;
    const arcs = segs.filter(s => s.value > 0).map(s => {
      const len = (s.value / total) * C;
      const a = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      acc += len;
      return a;
    }).join('');
    const center = centerText ? `<text x="${cx}" y="${cy}" class="drift-donut-pct" text-anchor="middle" dominant-baseline="central">${centerText}</text>` : '';
    return `<svg viewBox="0 0 104 104" class="drift-donut-svg" aria-hidden="true"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"/>${arcs}${center}</svg>`;
  };

  const C_ALIGNED = 'var(--ok, #16a34a)';
  const C_DRIFTED = 'rgb(150, 90, 200)';
  const C_DECL    = 'rgb(200, 70, 40)';
  const C_SHADOW  = 'rgb(180, 120, 0)';
  const notAligned = totDrifted + totA + totB;
  const legendHtml = [
    { n: totAligned, color: C_ALIGNED, label: 'Aligned',    hint: 'shape matches live' },
    { n: totDrifted, color: C_DRIFTED, label: 'Drifted',    hint: 'field values diverge' },
    { n: totA,       color: C_DECL,    label: frame.aLabel, hint: frame.aHint },
    { n: totB,       color: C_SHADOW,  label: frame.bLabel, hint: frame.bHint },
  ].map(l => `<li class="drift-legend-item">
      <span class="drift-legend-sw" style="background:${l.color}"></span>
      <span class="drift-legend-n">${l.n}</span>
      <span class="drift-legend-label">${escapeHtml(l.label)}</span>
      <span class="drift-legend-hint">${escapeHtml(l.hint)}</span>
    </li>`).join('');

  const layerRowsHtml = rows.map(r => `
    <tr class="drift-row">
      <th class="drift-row-layer"><span class="drift-row-num">${r.L}</span> ${escapeHtml(r.name)}</th>
      <td class="drift-cell is-aligned">
        <span class="drift-cell-n">${r.aligned.length}</span>
        <span class="drift-cell-keys">${r.aligned.length ? sampleKeys(r.aligned) : ''}</span>
      </td>
      <td class="drift-cell is-drifted">
        <span class="drift-cell-n">${r.drifted.length}</span>
        <span class="drift-cell-keys">${r.drifted.length ? sampleDeltas(r.drifted) : ''}</span>
      </td>
      <td class="drift-cell ${frame.aClass}">
        <span class="drift-cell-n">${r.onlyInA.length}</span>
        <span class="drift-cell-keys">${r.onlyInA.length ? sampleKeys(r.onlyInA) : ''}</span>
      </td>
      <td class="drift-cell ${frame.bClass}">
        <span class="drift-cell-n">${r.onlyInB.length}</span>
        <span class="drift-cell-keys">${r.onlyInB.length ? sampleKeys(r.onlyInB) : ''}</span>
        ${r.outOfScope.length ? `<span class="drift-cell-oos" title="Live members of families this pack declares nothing of — platform inventory, not drift.">+${r.outOfScope.length} out of scope</span>` : ''}
      </td>
    </tr>`).join('');

  const lensNote = useLens
    ? ` <span class="drift-lens-note">· lens: ${escapeHtml(LENS_PRODUCTS.find(lp => lp.slug === lens)?.label || lens)}</span>`
    : '';

  wrap.innerHTML = `
    <div class="benchmark-block-head">
      <span class="benchmark-block-eyebrow">${frame.eyebrow}</span>
      ${frame.lede}${lensNote}
    </div>
    <div class="drift-charts">
      <figure class="drift-chart">
        ${donut([{ value: totAligned, color: C_ALIGNED }, { value: notAligned, color: 'var(--ink-4)' }], alignedPct + '%')}
        <figcaption>aligned</figcaption>
      </figure>
      <span class="drift-charts-arrow" aria-hidden="true">→</span>
      <figure class="drift-chart">
        ${donut([{ value: totDrifted, color: C_DRIFTED }, { value: totA, color: C_DECL }, { value: totB, color: C_SHADOW }], (100 - alignedPct) + '%')}
        <figcaption>the rest</figcaption>
      </figure>
      <ul class="drift-legend">${legendHtml}</ul>
    </div>
    <table class="drift-table">
      <thead>
        <tr>
          <th class="drift-th-layer">Layer</th>
          <th class="drift-th is-aligned">Aligned</th>
          <th class="drift-th is-drifted">Drifted</th>
          <th class="drift-th ${frame.aClass}">${escapeHtml(frame.aLabel)}</th>
          <th class="drift-th ${frame.bClass}">${escapeHtml(frame.bLabel)}</th>
        </tr>
      </thead>
      <tbody>${layerRowsHtml}</tbody>
    </table>
    ${totOOS ? `<p class="drift-oos-note">${totOOS} live artefact${totOOS === 1 ? '' : 's'} out of declared scope — members of families <strong>${escapeHtml(bName)}</strong> runs but your pack doesn't declare (the rest of the platform inventory). Shown for context, not counted as drift.</p>` : ''}
  `;
  return wrap;
}

// ============================================================
// Posture matrix — outcome-based observability assessment.
//
// The question this answers: "are we monitoring the right things at
// the right levels with the right mechanisms?" Four layers (Infra /
// Platform / Application / UX) × eleven mechanisms (instrumentation,
// metrics, logs, traces, profiles, SLI, SLO, alert, dashboard,
// runbook, chaos, synthetic). Heuristic classifier on artefact ids,
// titles, dashboard folders, alert names — overridable via
// `metadata.annotations.layer.<artefact-id>: infra|platform|app|ux`.
// ============================================================
const POSTURE_LAYERS = [
  { key: 'infra',    label: 'Infrastructure', hint: 'nodes · pods · disk · network' },
  { key: 'platform', label: 'Platform',       hint: 'db · cache · queue · gateway' },
  { key: 'app',      label: 'Application',    hint: 'service · API · job · business logic' },
  { key: 'ux',       label: 'User Experience',hint: 'frontend · journey · business outcome' },
];

// Layer-specific mechanisms — each has a present/absent verdict per
// layer based on artefacts classified to that layer.
const POSTURE_MECHANISMS_PER_LAYER = [
  { key: 'sli',        label: 'SLI defined',       hint: 'what we measure' },
  { key: 'slo',        label: 'SLO declared',      hint: 'target reliability' },
  { key: 'alert',      label: 'Alert wired',       hint: 'fires on threshold or burn-rate' },
  { key: 'dashboard',  label: 'Dashboard',         hint: 'human-readable view' },
  { key: 'metric',     label: 'Metrics flowing',   hint: 'scrape job, recording rule, or evidence' },
  { key: 'log',        label: 'Logs flowing',      hint: 'log scrape / shipper' },
  { key: 'trace',      label: 'Traces flowing',    hint: 'span emission attested' },
  { key: 'runbook',    label: 'Runbook linked',    hint: 'oncall response declared' },
  { key: 'chaos',      label: 'Chaos validated',   hint: 'fault injection tested' },
  { key: 'synthetic',  label: 'Synthetic check',   hint: 'active uptime probe' },
];

// Platform-wide mechanisms — single status, doesn't depend on layer.
const POSTURE_MECHANISMS_GLOBAL = [
  { key: 'instrumentation', label: 'OTel SDK',     hint: 'instrumentation contract' },
  { key: 'baselines',       label: 'Baselines',    hint: 'MTTD/MTTR targets' },
];

// Classifier — returns the layer for an artefact, or null if it's
// not layer-attributable (e.g., OTel SDK config applies platform-wide).
// Falls back through: explicit annotation override → pattern match
// on id/title/folder/refs → unknown (counted but uncategorised).
//
// NB: `\b` word-boundaries do NOT match between two word-chars, and
// `_` is a word-char in JS regex. So `\bavailability\b` would FAIL
// against `kx_wallet_availability_99`. Patterns below avoid `\b` and
// rely on substring presence, since these tokens are distinctive
// enough that false positives are rare.
function classifyArtefactLayer(art, pack) {
  if (!art) return null;
  const ann = pack?.meta?.annotations || pack?.metadata?.annotations || {};
  const id = String(art.id || '').toLowerCase();
  const title = String(art.title || '').toLowerCase();
  const folder = String(art.spec?.folder || art.folder || '').toLowerCase();
  const refsStr = (Array.isArray(art.refs) ? art.refs : []).join(' ').toLowerCase();
  // Source URL (dashboards): grafana:///grafana/d/adz2hpb/k8s-dashboard
  // → adds "k8s-dashboard" to the haystack so dashboards whose title
  // got dropped at adapter time can still classify.
  const source = String(art.spec?.source || art.source || '').toLowerCase();
  const sourceSlug = source.split(/[/\\]/).filter(Boolean).pop() || '';
  // Spec-side hints we sometimes have on dashboards / backends.
  const tags = (Array.isArray(art.spec?.tags) ? art.spec.tags : []).join(' ').toLowerCase();
  const product = String(art.spec?.product || art.product || '').toLowerCase();
  const signal = String(art.spec?.signal || art.signal || '').toLowerCase();

  // Explicit override: annotations.layer.<artefact-id>
  const override = ann[`layer.${art.id}`];
  if (override && ['infra','platform','app','ux'].includes(override)) return override;

  const hay = `${id} ${title} ${folder} ${refsStr} ${sourceSlug} ${tags}`;

  // UX patterns first (most specific, least likely to overlap)
  if (/(rum|page_load|page-load|conversion|journey|frontend|apdex|lcp|fid|cls|business_outcome|web_vitals|user_satisfaction|customer_)/.test(hay)) return 'ux';

  // INFRA patterns
  if (/(host_|node_|disk_|cpu_|memory_|pod_|container_|kube_|k8s|cluster_|kubelet|cadvisor|node-exporter|kube-state|kubernetes|oom_|networkinterface|tcp_|conn_track|cert_expiry|containeroom|diskexhaustion)/.test(hay)) return 'infra';

  // PLATFORM patterns
  if (/(db_|database_|postgres|mysql|mongo|redis|cache_|queue_|kafka|rabbit|consumer_lag|broker_|bucket_|mq_|elasticsearch_|opensearch_|alertmanager|kong|envoy|traefik|gateway_|graylog)/.test(hay)) return 'platform';

  // APPLICATION (intentionally last — broad catch-all for service-level)
  if (/(availability|success_ratio|error_ratio|latency|p95|p99|p99\.9|request_|http_|api_|service_|endpoint_|error_budget|latency_budget|burn_rate|errorbudget|latencybudget|burnrate|finops|krystalinex)/.test(hay)) return 'app';

  // Backends with a telemetry signal but no layer-specific tokens
  // (e.g. dashboards-grafana, traces-jaeger) default to APP, since the
  // OTel SDK they enable primarily instruments application services.
  // The spec models telemetry backends as cross-cutting infrastructure;
  // for the posture matrix we attribute them to App by convention so
  // their mechanism shows up somewhere instead of "unknown".
  if (/^BAK-/.test(art.id || '') && signal) return 'app';
  if (id === 'otel-01' || /^OTEL-/.test(art.id || '')) return 'app';

  // SLI/SLO with a service-name pattern in id (e.g. kx_wallet_availability)
  if (/^sli-|^slo-/.test(id) && /^[a-z][a-z0-9_-]*_/.test(art.title || '')) return 'app';

  return null;  // genuinely uncategorised
}

// Classifier — returns the mechanism for an artefact (only one most-
// likely mechanism per artefact). Returns null when the artefact
// isn't a mechanism-bearing artefact (e.g. OTel SDK config covers
// 'instrumentation' platform-wide).
function classifyArtefactMechanism(art) {
  if (!art) return null;
  const id = String(art.id || '');
  if (/^SLI-/.test(id))    return 'sli';
  if (/^SLO-/.test(id))    return 'slo';
  if (/^DASH-/.test(id))   return 'dashboard';
  if (/^POL-/.test(id))    return 'alert';
  if (/^HEAL-/.test(id))   return 'runbook';
  if (/^CHAOS-/.test(id))  return 'chaos';
  if (/^SYN-/.test(id))    return 'synthetic';
  if (/^QRY-/.test(id) || /^VIEW-/.test(id)) return 'metric';
  // Backends carry a SIGNAL — telemetry mechanism, not layer-mechanism.
  if (/^BAK-/.test(id)) {
    const sig = String(art.spec?.signal || art.signal || '').toLowerCase();
    if (sig === 'metrics') return 'metric';
    if (sig === 'logs')    return 'log';
    if (sig === 'traces')  return 'trace';
  }
  return null;
}

function computePostureMatrix(packA, packB) {
  // Walk every layer (L1..L5 + GOV) and bucket each artefact into
  // (layer × mechanism). Build per-cell artefact lists.
  const cells = {};   // key: `${layer}:${mech}` → [artefacts]
  const platformWide = { instrumentation: false, baselines: false };
  const ann = packA?.meta?.annotations || packA?.metadata?.annotations || {};

  // OTel SDK declared anywhere?
  // Try several heuristics: (a) an OTEL- artefact in L2, (b) a backend
  // with signal=traces (instrumented), (c) explicit annotation.
  const L2 = packA?.layers?.L2 || [];
  if (L2.some(a => /^OTEL-/.test(a.id || '')) ||
      L2.some(a => /^BAK-/.test(a.id || '') && /traces/.test(String(a.spec?.signal||'').toLowerCase()))) {
    platformWide.instrumentation = true;
  }

  // Baselines declared?
  const L5 = packA?.layers?.L5 || [];
  if (L5.some(a => /baseline/i.test(a.id || '') || /baseline/i.test(a.title || ''))) {
    platformWide.baselines = true;
  }

  const allLayers = ['L1','L2','L2X','L3','L4','L5','GOV'];
  for (const L of allLayers) {
    const items = layerItemsFor(packA, L);
    for (const art of items) {
      const mech = classifyArtefactMechanism(art);
      if (!mech) continue;
      const layer = classifyArtefactLayer(art, packA);
      // When layer is null, bucket under 'unknown' so the matrix can
      // still surface the artefact's existence without claiming a
      // layer. UI shows these in a tiny "unclassified" footer.
      const key = `${layer || 'unknown'}:${mech}`;
      if (!cells[key]) cells[key] = [];
      cells[key].push(art);
    }
  }

  // Telemetry mechanism propagation: when the pack declares a backend
  // with signal=metrics/logs/traces/profiles, that telemetry pipeline
  // is enabled platform-wide. It primarily instruments the App layer
  // (services emitting telemetry). Light up App's row for each signal
  // we have a backend for. Other layers stay evidence-driven (scrape
  // jobs, recording rules, firing alerts) so we don't overclaim.
  const signalToMech = { metrics: 'metric', logs: 'log', traces: 'trace', profiles: 'profile' };
  for (const a of L2) {
    if (!/^BAK-/.test(a.id || '')) continue;
    const sig = String(a.spec?.signal || a.signal || '').toLowerCase();
    const mech = signalToMech[sig];
    if (!mech) continue;
    const key = `app:${mech}`;
    if (!cells[key]) cells[key] = [];
    cells[key].push(a);
  }

  // Also consider the firing-alerts evidence — these are layer-bearing
  // even though they aren't artefacts in the layered shape. The fetcher
  // stamps them as annotations; we re-derive layer from alertname.
  const firingNames = (ann['mcp.discovered.alerts_firing.names'] || '').split(',').filter(Boolean);
  for (const n of firingNames) {
    const fakeArt = { id: `ALERT-${n}`, title: n };
    const layer = classifyArtefactLayer(fakeArt, packA);
    const key = `${layer || 'unknown'}:alert`;
    if (!cells[key]) cells[key] = [];
    cells[key].push({ id: `firing/${n}`, title: n, _evidence: true });
  }

  // Recording-rule outputs from the inventory grep are evidence of
  // metric mechanism per layer.
  const recRuleNames = (ann['mcp.discovered.recording_rules_via_inventory.names'] || '').split(',').filter(Boolean);
  for (const n of recRuleNames) {
    const fakeArt = { id: `REC-${n}`, title: n };
    const layer = classifyArtefactLayer(fakeArt, packA);
    const key = `${layer || 'unknown'}:metric`;
    if (!cells[key]) cells[key] = [];
    cells[key].push({ id: `recrule/${n}`, title: n, _evidence: true });
  }

  // Scrape jobs surfaced via annotations — strong evidence of log/metric
  // flow at the inferred layer (node-exporter → infra, postgres → platform, etc.)
  const scrapeJobs = (ann['mcp.discovered.scrape_jobs'] || '').split(',').filter(Boolean);
  for (const job of scrapeJobs) {
    const fakeArt = { id: `JOB-${job}`, title: job };
    const layer = classifyArtefactLayer(fakeArt, packA);
    // Most scrape jobs evidence metrics; some specifically evidence logs
    // (promtail, fluentbit). Default to metric.
    const mech = /promtail|fluent|loki|log/i.test(job) ? 'log' : 'metric';
    const key = `${layer || 'unknown'}:${mech}`;
    if (!cells[key]) cells[key] = [];
    cells[key].push({ id: `scrape/${job}`, title: job, _evidence: true });
  }

  return { cells, platformWide };
}

function renderPostureMatrix(posture) {
  const wrap = document.createElement('div');
  wrap.className = 'benchmark-block posture-matrix-block';
  const cellVal = (layer, mech) => {
    const arr = posture.cells[`${layer}:${mech}`];
    return arr && arr.length ? arr : null;
  };
  const cellHtml = (layer, mech) => {
    const arr = cellVal(layer, mech);
    if (!arr) return `<td class="posture-cell is-absent" title="No ${mech} attested for ${layer}">✗</td>`;
    const evidenceOnly = arr.every(a => a._evidence);
    const cls = evidenceOnly ? 'is-evidence' : 'is-present';
    const sample = arr.slice(0, 3).map(a => escapeHtml(a.title || a.id)).join(' · ');
    const more = arr.length > 3 ? ` · +${arr.length - 3} more` : '';
    return `<td class="posture-cell ${cls}" title="${escapeHtml(sample + more)}">
      <span class="posture-pip">${evidenceOnly ? '○' : '✓'}</span>
      <span class="posture-count">${arr.length}</span>
    </td>`;
  };

  const headRow = `<tr>
    <th class="posture-mech-col">Mechanism</th>
    ${POSTURE_LAYERS.map(l => `<th class="posture-layer-col">
      <div class="posture-layer-label">${escapeHtml(l.label)}</div>
      <div class="posture-layer-hint">${escapeHtml(l.hint)}</div>
    </th>`).join('')}
  </tr>`;
  const bodyRows = POSTURE_MECHANISMS_PER_LAYER.map(m => `<tr>
    <th class="posture-mech-cell">
      <span class="posture-mech-label">${escapeHtml(m.label)}</span>
      <span class="posture-mech-hint">${escapeHtml(m.hint)}</span>
    </th>
    ${POSTURE_LAYERS.map(l => cellHtml(l.key, m.key)).join('')}
  </tr>`).join('');
  const platformRows = POSTURE_MECHANISMS_GLOBAL.map(m => {
    const pass = !!posture.platformWide[m.key];
    return `<tr class="is-platform-wide">
      <th class="posture-mech-cell">
        <span class="posture-mech-label">${escapeHtml(m.label)}</span>
        <span class="posture-mech-hint">${escapeHtml(m.hint)}</span>
      </th>
      <td class="posture-cell-span" colspan="${POSTURE_LAYERS.length}">
        <span class="posture-pip">${pass ? '✓' : '✗'}</span>
        <span class="posture-platform-msg">${pass ? 'declared at the pack level (applies to all layers)' : 'not declared'}</span>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="benchmark-block-head">
      <span class="benchmark-block-eyebrow">POSTURE</span>
      Are we monitoring the right things at the right levels?
    </div>
    <table class="posture-matrix">
      <thead>${headRow}</thead>
      <tbody>${bodyRows}${platformRows}</tbody>
    </table>
    <div class="posture-matrix-legend">
      ✓ artefact declared in the pack · ○ evidence-only (firing alert, scrape job, recording rule output — declaration missing) · ✗ absent
    </div>
  `;
  return wrap;
}

function renderPostureNarrative(posture) {
  // Template-driven (no LLM). For each layer, count how many of the
  // 10 layer-specific mechanisms are present (declared OR evidence),
  // then map to a sentence.
  const wrap = document.createElement('div');
  wrap.className = 'benchmark-block posture-narrative-block';

  const layerScore = (layer) => {
    let present = 0;
    let evidenceOnly = 0;
    let missing = [];
    for (const m of POSTURE_MECHANISMS_PER_LAYER) {
      const arr = posture.cells[`${layer}:${m.key}`];
      if (arr && arr.length) {
        present++;
        if (arr.every(a => a._evidence)) evidenceOnly++;
      } else {
        missing.push(m.label);
      }
    }
    return { present, evidenceOnly, missing, total: POSTURE_MECHANISMS_PER_LAYER.length };
  };

  const sentences = POSTURE_LAYERS.map(l => {
    const s = layerScore(l.key);
    let verdict, body;
    const pct = Math.round((s.present / s.total) * 100);
    if (s.present === 0) {
      verdict = 'is-dark';
      body = `<strong>${escapeHtml(l.label)}</strong> is dark — no coverage detected across any mechanism.`;
    } else if (s.present <= 3) {
      verdict = 'is-thin';
      body = `<strong>${escapeHtml(l.label)}</strong> is thinly covered (${s.present}/${s.total} mechanisms) — missing ${s.missing.slice(0, 4).map(x => `<em>${escapeHtml(x.toLowerCase())}</em>`).join(', ')}${s.missing.length > 4 ? ', and more' : ''}.`;
    } else if (s.present <= 6) {
      verdict = 'is-partial';
      body = `<strong>${escapeHtml(l.label)}</strong> is partially covered (${s.present}/${s.total}, ${pct}%) — gaps in ${s.missing.slice(0, 3).map(x => `<em>${escapeHtml(x.toLowerCase())}</em>`).join(', ')}.`;
    } else if (s.present <= 8) {
      verdict = 'is-strong';
      body = `<strong>${escapeHtml(l.label)}</strong> is well-covered (${s.present}/${s.total}, ${pct}%)${s.missing.length ? ` — still missing ${s.missing.slice(0, 2).map(x => `<em>${escapeHtml(x.toLowerCase())}</em>`).join(', ')}` : ''}.`;
    } else {
      verdict = 'is-complete';
      body = `<strong>${escapeHtml(l.label)}</strong> is comprehensively covered (${s.present}/${s.total}, ${pct}%)${s.missing.length ? `, only missing ${s.missing.map(x => `<em>${escapeHtml(x.toLowerCase())}</em>`).join(', ')}` : ''}.`;
    }
    if (s.evidenceOnly > 0 && s.evidenceOnly === s.present) {
      body += ` <span class="posture-narr-caveat">All evidence is observational, not declared in the pack — consider authoring explicit SLI/SLO/alert/dashboard artefacts.</span>`;
    } else if (s.evidenceOnly > 0) {
      body += ` <span class="posture-narr-caveat">${s.evidenceOnly} of the ${s.present} mechanisms are evidence-only (firing alert, scrape job, recording-rule output) — declaration in the pack is still missing.</span>`;
    }
    return `<li class="${verdict}">${body}</li>`;
  }).join('');

  // Cross-layer findings — runbook coverage, chaos coverage, sli/slo balance.
  const allRunbookCells = POSTURE_LAYERS.map(l => posture.cells[`${l.key}:runbook`]?.length || 0);
  const totalRunbooks = allRunbookCells.reduce((a, b) => a + b, 0);
  const allChaosCells = POSTURE_LAYERS.map(l => posture.cells[`${l.key}:chaos`]?.length || 0);
  const totalChaos = allChaosCells.reduce((a, b) => a + b, 0);
  const sliCount = POSTURE_LAYERS.map(l => posture.cells[`${l.key}:sli`]?.length || 0).reduce((a, b) => a + b, 0);
  const sloCount = POSTURE_LAYERS.map(l => posture.cells[`${l.key}:slo`]?.length || 0).reduce((a, b) => a + b, 0);

  const crossFindings = [];
  if (totalRunbooks === 0) crossFindings.push(`<li>⚠ <strong>Zero runbooks linked</strong> across any layer — your biggest operational risk. When an alert fires, oncall has no scripted response path.</li>`);
  if (totalChaos === 0) crossFindings.push(`<li>⚠ <strong>No chaos experiments declared</strong> — recovery procedures haven't been validated against actual fault injection.</li>`);
  if (sliCount > 0 && sloCount === 0) crossFindings.push(`<li>⚠ ${sliCount} SLI${sliCount === 1 ? '' : 's'} defined but <strong>no matching SLO</strong> — measurement without a target.</li>`);
  if (sliCount > sloCount && sloCount > 0) crossFindings.push(`<li>${sliCount} SLIs vs ${sloCount} SLOs — ${sliCount - sloCount} SLI${sliCount - sloCount === 1 ? '' : 's'} unbound to a target.</li>`);
  if (!posture.platformWide.baselines) crossFindings.push(`<li>No <strong>MTTD/MTTR baselines</strong> declared — without targets, incident response can't be benchmarked.</li>`);

  wrap.innerHTML = `
    <div class="benchmark-block-head">
      <span class="benchmark-block-eyebrow">BRIEFING</span>
      Per-layer narrative — what's covered, what's missing
    </div>
    <ul class="posture-narrative">${sentences}</ul>
    ${crossFindings.length ? `
      <div class="posture-cross">
        <div class="posture-cross-head">Cross-layer findings</div>
        <ul class="posture-cross-list">${crossFindings.join('')}</ul>
      </div>` : ''}
  `;
  return wrap;
}

// ============================================================
// The Benchmark headline — frames the WHOLE view as a question
// the audience can answer. Leads the view; everything beneath
// answers it.
// ============================================================
// ============================================================
// Diagnostic-grade verdict — the CEO question, made answerable.
//
// "Is our observability diagnostic-grade?" answered as eight pass/fail
// criteria split into two equally-weighted halves:
//
//   2A — COVERAGE (vs Observability Contract)
//        "Are we observing the right signals?"
//        Five criteria evaluated on Pack A against Pack B (the
//        contract / "what good looks like"):
//          1. Multi-modal    — metrics + logs + traces flowing
//          2. Correlated     — tracecontext + log_correlation
//          3. Calibrated     — baselines + SLOs w/ numeric objectives
//          4. Comprehensive  — posture matrix ≥ 50% across layers
//          5. Actionable     — remediation runbooks declared
//
//   2B — TRUST (signal integrity)
//        "Can we trust what the signals show?"
//        Three criteria evaluated on Pack A's live evidence:
//          6. Chaos-validated — chaos experiments declared
//          7. Drift-free      — declared artefacts match live state
//                               (MCP probe success / total ratio)
//          8. Fresh           — mcp.refreshedAt within staleness window
//
// Overall score (out of 8) → verdict word:
//   7-8 → Diagnostic-grade
//   5-6 → Almost diagnostic-grade
//   3-4 → Not yet diagnostic-grade
//   0-2 → Far from diagnostic-grade
// ============================================================

// "Observability Contract" mode is on when Pack B is the
// hand-authored aspirational/contract reference. The internal label
// is OLA; the user-facing label is "Observability Contract".
//
// Detection runs three ways (any one suffices):
//   1. The pack itself carries `metadata.annotations.studio.role: contract`
//      (canonical signal — the contract pack declares its role).
//   2. The catalog id (the dropdown slot, not pack.metadata.name) is a
//      known contract slot — covers target-advanced even before the
//      annotation is added, and any future *-contract slot.
//   3. The pack's id or metadata.name carries a `contract` or `ola` token.
const CONTRACT_PACK_IDS = new Set(['target-advanced']);
function isObservabilityContractPack(pack, catalogId) {
  if (!pack) return false;
  const role = pack.meta?.annotations?.['studio.role'] || pack.metadata?.annotations?.['studio.role'];
  if (String(role || '').toLowerCase() === 'contract') return true;
  const slot = String(catalogId || '').toLowerCase();
  if (slot && CONTRACT_PACK_IDS.has(slot)) return true;
  if (slot && /(^|-)contract($|-)/i.test(slot)) return true;
  if (slot && /(^|-)ola($|-)/i.test(slot))      return true;
  const id = String(pack.id || pack.meta?.id || pack.metadata?.name || '').toLowerCase();
  if (CONTRACT_PACK_IDS.has(id)) return true;
  if (/(^|-)contract($|-)/i.test(id)) return true;
  if (/(^|-)ola($|-)/i.test(id))      return true;
  return false;
}
function contractLabelFor(packB, catalogId) {
  if (!packB) return null;
  if (isObservabilityContractPack(packB, catalogId)) return 'Observability Contract';
  return packB?.meta?.name || packB?.metadata?.name || packB?.id || 'reference pack';
}

// Staleness window for the freshness criterion. 24h is the demo
// default — daily refresh is the lowest bar for a "live" pack.
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
// Drift tolerance: how many probes can come back empty/failed and
// still pass. 0.3 = up to 30% of attempted probes can be empty/failed
// without flunking. Empty AND failed both count as drift signal —
// the live system didn't confirm what the pack declares.
const DRIFT_FAIL_TOLERANCE = 0.30;

function computeDiagnosticGrade(packA, packB, posture, catalogBId) {
  // ===== Coverage criteria (2A) =====
  const meta = packA?.meta || {};
  const ann = meta?.annotations || packA?.metadata?.annotations || {};
  const L1 = packA?.layers?.L1 || [];
  const L2 = packA?.layers?.L2 || [];
  const L4 = packA?.layers?.L4 || {};
  const L5 = packA?.layers?.L5 || [];

  // ---- 1. Multi-modal ----
  const signalsPresent = new Set();
  for (const b of L2) {
    const sig = String(b.spec?.signal || b.signal || '').toLowerCase();
    if (['metrics','logs','traces','profiles'].includes(sig)) signalsPresent.add(sig);
  }
  const allSignals = ['metrics','logs','traces','profiles'];
  const signalsCount = signalsPresent.size;
  const multiModal = signalsCount >= 3;

  // ---- 2. Correlated ----
  const otel = L2.find(a => /^OTEL-/.test(a.id || ''));
  const propagators = otel?.spec?.sdk?.propagators || otel?.sdk?.propagators || [];
  const hasTraceContext = (Array.isArray(propagators) ? propagators : [])
    .some(p => /tracecontext/i.test(String(p)));
  const logCorrelationDeclared = !!(otel?.spec?.log_correlation === true || otel?.log_correlation === true);
  const correlated = hasTraceContext && (logCorrelationDeclared || signalsPresent.has('logs'));

  // ---- 3. Calibrated ----
  const hasBaselines = L5.some(a => /baseline/i.test(a.id || '') || /baseline/i.test(a.title || ''));
  const slos = L1.filter(a => /^SLO-/.test(a.id || ''));
  const slosWithObjective = slos.filter(a => {
    const obj = a.spec?.objective ?? a.objective;
    return typeof obj === 'number' && obj > 0 && obj <= 1;
  });
  const calibrated = hasBaselines && slosWithObjective.length > 0;

  // ---- 4. Comprehensive ----
  let totalObserved = 0;
  for (const l of POSTURE_LAYERS) {
    let present = 0, evidence = 0;
    for (const m of POSTURE_MECHANISMS_PER_LAYER) {
      const arr = posture.cells[`${l.key}:${m.key}`];
      if (arr && arr.length) {
        if (arr.every(a => a._evidence)) evidence++;
        else present++;
      }
    }
    totalObserved += (present + evidence) / POSTURE_MECHANISMS_PER_LAYER.length;
  }
  const avgObservedPct = Math.round((totalObserved / POSTURE_LAYERS.length) * 100);
  const comprehensive = avgObservedPct >= 50;

  // ---- 5. Actionable ----
  const healings = (L4.healing || []).concat(
    Array.isArray(L4) ? L4.filter(a => /^HEAL-/.test(a.id || '')) : []
  );
  const actionableCount = healings.length;
  const actionable = actionableCount > 0;

  const coverageCriteria = [
    { key: 'multi-modal',   label: 'Multi-modal',   sub: 'metrics + logs + traces + profiles',
      pass: multiModal,
      detail: `${signalsCount} of ${allSignals.length} signals declared as backends` +
              (signalsCount > 0 ? ' (' + [...signalsPresent].join(', ') + ')' : ''),
    },
    { key: 'correlated',    label: 'Correlated',    sub: 'signals linked at evidence-level',
      pass: correlated,
      detail: hasTraceContext
        ? (logCorrelationDeclared ? 'tracecontext propagator + log_correlation: true' : 'tracecontext propagator declared')
        : 'tracecontext propagator missing — logs/traces can\'t be joined',
    },
    { key: 'calibrated',    label: 'Calibrated',    sub: 'normal defined with numbers',
      pass: calibrated,
      detail: hasBaselines
        ? (slosWithObjective.length
            ? `MTTD/MTTR baselines + ${slosWithObjective.length} SLO${slosWithObjective.length === 1 ? '' : 's'} with explicit objective`
            : 'baselines declared but no SLOs have explicit objectives')
        : 'no MTTD/MTTR baselines declared',
    },
    { key: 'comprehensive', label: 'Comprehensive', sub: 'coverage spans all layers',
      pass: comprehensive,
      detail: `${avgObservedPct}% average observed across infra · platform · app · ux`,
    },
    { key: 'actionable',    label: 'Actionable',    sub: 'alerts lead to a response path',
      pass: actionable,
      detail: actionableCount > 0
        ? `${actionableCount} remediation runbook${actionableCount === 1 ? '' : 's'} declared`
        : 'no runbooks linked — when an alert fires, oncall has no scripted response',
    },
  ];

  // ===== Trust criteria (2B) =====

  // The live/verified evidence (MCP probe outcomes + refreshedAt) is
  // stamped by the fetcher onto whichever pack was drafted from live.
  // In the drift journey Pack A is the declared repo scan (no MCP) and
  // Pack B is the live draft that carries the evidence; in the single-
  // pack refreshed workflow Pack A carries its own evidence. Read the
  // trust signals from whichever pack actually has MCP annotations,
  // favouring the live half (Pack B).
  const annB = packB?.meta?.annotations || packB?.metadata?.annotations || {};
  const hasMcpAnnotations = (a) => !!a && Object.keys(a).some(k => k.startsWith('mcp.'));
  const liveAnn = hasMcpAnnotations(annB) ? annB : ann;

  // ---- 6. Chaos-validated ----
  const chaosCount = L5.filter(a => /^CHAOS-/.test(a.id || '')).length;
  const chaosValidated = chaosCount > 0;

  // ---- 7. Drift-free ----
  // Live signal integrity: did the declarations the pack makes about
  // the world match what the MCP actually observed? Read directly off
  // the probe-outcome annotations stamped by the fetcher.
  const probesAttempted = (liveAnn['mcp.probesAttempted']  || '').split(',').filter(Boolean);
  const probesSucceeded = (liveAnn['mcp.probesSucceeded']  || '').split(',').filter(Boolean);
  const probesEmpty     = (liveAnn['mcp.probesEmpty']      || '').split(',').filter(Boolean);
  const probesFailed    = (liveAnn['mcp.probesFailed']     || '').split(',').filter(Boolean);
  const hasMcpSource = probesAttempted.length > 0 || !!liveAnn['mcp.refreshedAt'];
  let driftFree, driftDetail;
  if (!hasMcpSource) {
    driftFree = false;
    driftDetail = 'declared-only — no live signal to verify against (connect MCP or scan live)';
  } else if (probesAttempted.length === 0) {
    // Pack has refreshedAt but no probe table — can't compute ratio.
    driftFree = true;
    driftDetail = 'live source connected — probe table not recorded';
  } else {
    const driftCount = probesEmpty.length + probesFailed.length;
    const driftRatio = driftCount / probesAttempted.length;
    driftFree = driftRatio <= DRIFT_FAIL_TOLERANCE;
    const pct = Math.round(driftRatio * 100);
    driftDetail = driftFree
      ? `${probesSucceeded.length}/${probesAttempted.length} probes confirmed (${pct}% empty or failed, within ${Math.round(DRIFT_FAIL_TOLERANCE * 100)}% tolerance)`
      : `${driftCount}/${probesAttempted.length} probes empty or failed (${pct}%) — declared surface exceeds what live attests`;
  }

  // ---- 8. Fresh ----
  const refreshedAtStr = liveAnn['mcp.refreshedAt'];
  let fresh, freshDetail;
  if (!refreshedAtStr) {
    fresh = false;
    freshDetail = 'no mcp.refreshedAt annotation — pack has never been verified against live state';
  } else {
    const refreshedAtMs = Date.parse(refreshedAtStr);
    if (!Number.isFinite(refreshedAtMs)) {
      fresh = false;
      freshDetail = `mcp.refreshedAt is unparseable (${refreshedAtStr})`;
    } else {
      const ageMs = Date.now() - refreshedAtMs;
      const ageHrs = Math.round(ageMs / 3600000);
      fresh = ageMs <= FRESH_WINDOW_MS;
      freshDetail = fresh
        ? `last refreshed ${ageHrs}h ago — within 24h staleness window`
        : `last refreshed ${ageHrs}h ago — exceeds 24h staleness window, signals may have drifted`;
    }
  }

  const trustCriteria = [
    { key: 'chaos-validated', label: 'Chaos-validated', sub: 'recovery proven by fault injection',
      pass: chaosValidated,
      detail: chaosCount > 0
        ? `${chaosCount} chaos experiment${chaosCount === 1 ? '' : 's'} declared`
        : 'no chaos experiments — recovery procedures are theoretical',
    },
    { key: 'drift-free',      label: 'Drift-free',      sub: 'declarations match live state',
      pass: driftFree,
      detail: driftDetail,
    },
    { key: 'fresh',           label: 'Fresh',           sub: 'recently verified against live',
      pass: fresh,
      detail: freshDetail,
    },
  ];

  // ===== Overall verdict (equal-weighted) =====
  const coveragePassed = coverageCriteria.filter(c => c.pass).length;
  const trustPassed = trustCriteria.filter(c => c.pass).length;
  const overallPassed = coveragePassed + trustPassed;
  const overallTotal = coverageCriteria.length + trustCriteria.length;   // 5 + 3 = 8
  const verdict =
    overallPassed >= 7 ? { word: 'Diagnostic-grade',          level: 'is-grade' } :
    overallPassed >= 5 ? { word: 'Almost diagnostic-grade',   level: 'is-almost' } :
    overallPassed >= 3 ? { word: 'Not yet diagnostic-grade',  level: 'is-not-yet' } :
                         { word: 'Far from diagnostic-grade', level: 'is-far' };

  return {
    coverage: {
      criteria: coverageCriteria,
      passed:   coveragePassed,
      total:    coverageCriteria.length,
      contractLabel: contractLabelFor(packB, catalogBId),
      contractMode:  isObservabilityContractPack(packB, catalogBId),
    },
    trust: {
      criteria: trustCriteria,
      passed:   trustPassed,
      total:    trustCriteria.length,
      hasMcpSource,
    },
    overall: {
      passed: overallPassed,
      total:  overallTotal,
      verdict,
    },
  };
}

// Diagnose view — rendered as a compliance report, not a pitch deck.
// Density and evidence are the design language; every row encodes
// observed vs expected. No giant typography, no decorative tiles.
// Reads like an audit findings document because that's what it IS.
function renderDiagnosticGradeVerdict(diagnostic, lens, packB) {
  const wrap = document.createElement('div');
  wrap.className = 'diag-report';

  const cov = diagnostic.coverage;
  const trust = diagnostic.trust;
  const overall = diagnostic.overall;

  const pct = (passed, total) => total === 0 ? 0 : Math.round((passed / total) * 100);
  const overallPct = pct(overall.passed, overall.total);
  const covPct   = pct(cov.passed, cov.total);
  const trustPct = pct(trust.passed, trust.total);

  // Single binary verdict in audit terms. No "Almost diagnostic-grade",
  // no "Critical" — just PASS or FAIL with the threshold stated.
  const PASS_THRESHOLD = 7; // 7 of 8 to pass — graded against contract
  const passes = overall.passed >= PASS_THRESHOLD;
  const status = passes ? 'PASS' : 'FAIL';

  // Coverage-only when no Pack B is loaded: the coverage criteria are
  // still graded against the built-in Observability Contract, so the
  // verdict stands on Pack A alone — we just frame the header honestly.
  const coverageOnly = !packB;
  const contractName = packB?.meta?.name || packB?.metadata?.name || packB?.id || '—';
  const contractMode = cov.contractMode;

  // Compact mono row builder for the summary block.
  const summaryRow = (label, value, hint, state) => `
    <tr class="diag-summary-row ${state || ''}">
      <td class="diag-summary-key">${escapeHtml(label)}</td>
      <td class="diag-summary-val">${value}</td>
      <td class="diag-summary-hint">${hint || ''}</td>
    </tr>
  `;

  // Bar chip for percentage fields.
  const bar = (p) => `
    <span class="diag-bar"><span class="diag-bar-fill" style="width:${Math.max(0,Math.min(100,p))}%"></span></span>
  `;

  // ---------- Criterion table (2A or 2B) ----------
  // One row per criterion. Tight. Pip · name · observed · expected.
  const critTable = (criteria) => `
    <table class="diag-crit-table">
      <thead>
        <tr>
          <th class="c-pip"></th>
          <th class="c-name">Criterion</th>
          <th class="c-obs">Observed</th>
          <th class="c-exp">Expected</th>
        </tr>
      </thead>
      <tbody>
        ${criteria.map(c => `
          <tr class="diag-crit ${c.pass ? 'is-pass' : 'is-fail'}" data-key="${escapeHtml(c.key)}">
            <td class="c-pip">${c.pass ? '✓' : '✗'}</td>
            <td class="c-name">${escapeHtml(c.label)}</td>
            <td class="c-obs">${escapeHtml(c.detail)}</td>
            <td class="c-exp">${escapeHtml(c.sub)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  // ---------- Evidence ledger — the "where the data came from" audit trail ----------
  // Every claim above is backed by a specific pack field; this table
  // names the field, what we expected, what we observed, and the verdict.
  // For an audit tool this is the most important section, not the least.
  const evidenceRows = [];
  // Collect from criteria themselves — each criterion encodes an evidence assertion.
  const C = (key, label) => cov.criteria.find(c => c.key === key) || trust.criteria.find(c => c.key === key);
  const rowFor = (field, exp, obs, pass) => ({
    field, exp, obs, pass,
  });
  evidenceRows.push(rowFor(
    'spec.telemetry.backends[].signal',
    'metrics + logs + traces (≥ 3 of 4)',
    C('multi-modal')?.detail || '—',
    C('multi-modal')?.pass));
  evidenceRows.push(rowFor(
    'spec.otel.sdk.propagators',
    'includes tracecontext',
    C('correlated')?.detail || '—',
    C('correlated')?.pass));
  evidenceRows.push(rowFor(
    'spec.slos[].objective + spec.baselines',
    '≥ 1 SLO with numeric objective · MTTD/MTTR baselines declared',
    C('calibrated')?.detail || '—',
    C('calibrated')?.pass));
  evidenceRows.push(rowFor(
    'posture matrix · 4 layers × 10 mechanisms',
    'average ≥ 50% observed',
    C('comprehensive')?.detail || '—',
    C('comprehensive')?.pass));
  evidenceRows.push(rowFor(
    'spec.remediation[]',
    '≥ 1 remediation runbook declared',
    C('actionable')?.detail || '—',
    C('actionable')?.pass));
  evidenceRows.push(rowFor(
    'spec.validation.chaos_experiments[]',
    '≥ 1 chaos experiment declared',
    C('chaos-validated')?.detail || '—',
    C('chaos-validated')?.pass));
  evidenceRows.push(rowFor(
    'metadata.annotations.mcp.probesSucceeded',
    '≥ 70% of attempted probes return data',
    C('drift-free')?.detail || '—',
    C('drift-free')?.pass));
  evidenceRows.push(rowFor(
    'metadata.annotations.mcp.refreshedAt',
    'within last 24h',
    C('fresh')?.detail || '—',
    C('fresh')?.pass));

  const evidenceTable = `
    <table class="diag-evidence-table">
      <thead>
        <tr>
          <th class="e-field">Field</th>
          <th class="e-exp">Expected</th>
          <th class="e-obs">Observed</th>
          <th class="e-status">Status</th>
        </tr>
      </thead>
      <tbody>
        ${evidenceRows.map(r => `
          <tr class="${r.pass ? 'is-pass' : 'is-fail'}">
            <td class="e-field">${escapeHtml(r.field)}</td>
            <td class="e-exp">${escapeHtml(r.exp)}</td>
            <td class="e-obs">${escapeHtml(r.obs)}</td>
            <td class="e-status">${r.pass ? 'PASS' : 'FAIL'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  wrap.innerHTML = `
    <header class="diag-report-head">
      <div class="diag-report-head-line">
        <span class="diag-report-eyebrow">DIAGNOSTIC GRADE</span>
        <span class="diag-report-vs">
          ${coverageOnly
            ? 'vs <strong>Observability Contract</strong> <span class="diag-report-mode">· coverage only</span>'
            : (contractMode
                ? 'vs <strong>Observability Contract</strong>' + (contractName && contractName !== '—' ? ' (' + escapeHtml(contractName) + ')' : '')
                : 'vs <strong>' + escapeHtml(contractName) + '</strong>')}
        </span>
        <span class="diag-report-status diag-${passes ? 'pass' : 'fail'}">${status}</span>
      </div>
      <table class="diag-summary">
        <colgroup><col><col><col></colgroup>
        <tbody>
          ${summaryRow('Score',    `<span class="diag-pct">${overallPct}%</span> <span class="diag-frac">${overall.passed}/${overall.total}</span>`, bar(overallPct))}
          ${summaryRow('Coverage', `<span class="diag-pct">${covPct}%</span> <span class="diag-frac">${cov.passed}/${cov.total}</span>`,       bar(covPct))}
          ${summaryRow('Trust',    `<span class="diag-pct">${trustPct}%</span> <span class="diag-frac">${trust.passed}/${trust.total}</span>`, bar(trustPct))}
          ${summaryRow('Verified', trust.hasMcpSource ? '<span class="diag-yes">YES</span>' : '<span class="diag-no">NO</span>',
                       trust.hasMcpSource ? 'live signal present' : 'connect MCP or scan live to verify',
                       trust.hasMcpSource ? '' : 'is-warn')}
        </tbody>
      </table>
    </header>

    <section class="diag-section">
      <header class="diag-section-head">
        <span class="diag-section-num">2A</span>
        <span class="diag-section-title">Coverage — are we observing the right signals?</span>
        <span class="diag-section-meta">${cov.passed}/${cov.total} met · ${covPct}%</span>
      </header>
      ${critTable(cov.criteria)}
    </section>

    <section class="diag-section">
      <header class="diag-section-head">
        <span class="diag-section-num">2B</span>
        <span class="diag-section-title">Trust — can we trust what the signals show?</span>
        <span class="diag-section-meta">${trust.passed}/${trust.total} met · ${trustPct}%</span>
      </header>
      ${!trust.hasMcpSource ? `
        <div class="diag-banner">
          <span class="diag-banner-key">WARN</span>
          Pack A carries no live signal. Drift &amp; freshness require an MCP-drafted or live-refreshed pack to verify.
        </div>
      ` : ''}
      ${critTable(trust.criteria)}
    </section>

    <section class="diag-section">
      <header class="diag-section-head">
        <span class="diag-section-num">⊜</span>
        <span class="diag-section-title">Evidence — expected vs observed</span>
        <span class="diag-section-meta">${evidenceRows.filter(r => r.pass).length}/${evidenceRows.length} confirmed</span>
      </header>
      ${evidenceTable}
    </section>
  `;
  return wrap;
}

function renderBenchmarkHeadline(posture, lens) {
  const head = document.createElement('div');
  head.className = 'benchmark-head';

  // Drill-down summary — sits BENEATH the main diagnostic-grade
  // verdict. It frames the matrix below as "the why behind the
  // verdict": coverage / observation breakdown that answers, at the
  // mechanism level, where the diagnostic-grade gaps live.
  let present = 0, evidence = 0, absent = 0;
  for (const l of POSTURE_LAYERS) {
    for (const m of POSTURE_MECHANISMS_PER_LAYER) {
      const arr = posture.cells[`${l.key}:${m.key}`];
      if (!arr || arr.length === 0) absent++;
      else if (arr.every(a => a._evidence)) evidence++;
      else present++;
    }
  }
  const total = POSTURE_LAYERS.length * POSTURE_MECHANISMS_PER_LAYER.length;
  const observedPct = Math.round(((present + evidence) / total) * 100);

  const verdictWord = observedPct >= 70 ? 'Strong' : observedPct >= 40 ? 'Partial' : observedPct >= 20 ? 'Thin' : 'Critical gap';
  const verdictClass = observedPct >= 70 ? 'is-strong' : observedPct >= 40 ? 'is-partial' : observedPct >= 20 ? 'is-thin' : 'is-critical';

  // When the user has a product lens selected, the drill becomes
  // about that product specifically. Otherwise it's pack-wide.
  const lensLabel = lens === 'all' ? null : (LENS_PRODUCTS.find(lp => lp.slug === lens)?.label || lens);
  const drillFraming = lensLabel
    ? `<strong>Drill</strong> · ${escapeHtml(lensLabel)} surface — where the diagnostic-grade gaps live in ${escapeHtml(lensLabel)}'s area`
    : `<strong>Drill</strong> · per-layer × per-mechanism — where the diagnostic-grade gaps live`;

  head.innerHTML = `
    <div class="benchmark-headline-eyebrow">${drillFraming}</div>
    <div class="benchmark-headline-meta">
      <div class="benchmark-headline-verdict ${verdictClass}">
        <div class="benchmark-headline-verdict-word">${verdictWord}</div>
        <div class="benchmark-headline-verdict-sub">${present}/${total} declared · ${present + evidence}/${total} observed</div>
      </div>
      <div class="benchmark-headline-tally">
        <div class="benchmark-headline-tally-row"><span class="benchmark-headline-tally-pip is-present">✓</span> ${present} declared</div>
        <div class="benchmark-headline-tally-row"><span class="benchmark-headline-tally-pip is-evidence">○</span> ${evidence} evidence-only</div>
        <div class="benchmark-headline-tally-row"><span class="benchmark-headline-tally-pip is-absent">✗</span> ${absent} absent</div>
      </div>
    </div>
  `;
  return head;
}

// ============================================================
// Pie chart row — one SVG donut per layer, sized by mechanism
// coverage. Three concentric slices: declared / evidence / absent.
// Glanceable summary the audience reads in 2 seconds.
// ============================================================
function renderPosturePieRow(posture) {
  const wrap = document.createElement('div');
  wrap.className = 'benchmark-block posture-pie-row-block';

  const pies = POSTURE_LAYERS.map(layer => {
    let present = 0, evidence = 0, absent = 0;
    const declaredMechs = [];
    const evidenceMechs = [];
    const missingMechs = [];
    for (const m of POSTURE_MECHANISMS_PER_LAYER) {
      const arr = posture.cells[`${layer.key}:${m.key}`];
      if (!arr || arr.length === 0) { absent++; missingMechs.push(m.label); }
      else if (arr.every(a => a._evidence)) { evidence++; evidenceMechs.push(m.label); }
      else { present++; declaredMechs.push(m.label); }
    }
    const total = POSTURE_MECHANISMS_PER_LAYER.length;
    const declaredPct = Math.round((present / total) * 100);
    const obsPct = Math.round(((present + evidence) / total) * 100);
    const verdict = obsPct >= 70 ? 'strong' : obsPct >= 40 ? 'partial' : obsPct >= 20 ? 'thin' : 'dark';

    // Build a stacked donut: each slice's arc-length proportional to count.
    // r=42 inside a 110×110 viewBox; circumference C = 2πr ≈ 263.9.
    const R = 42, C = 2 * Math.PI * R;
    const seg = (count) => (count / total) * C;
    const sPres = seg(present), sEvi = seg(evidence), sAbs = seg(absent);
    // Start at top (-90deg), stroke segments end-to-end.
    return `
      <div class="posture-pie" data-verdict="${verdict}" title="${escapeHtml(`Declared: ${declaredMechs.join(', ') || 'none'}\nEvidence-only: ${evidenceMechs.join(', ') || 'none'}\nMissing: ${missingMechs.join(', ') || 'none'}`)}">
        <svg viewBox="0 0 110 110" class="posture-pie-svg" role="img" aria-label="${escapeHtml(layer.label + ' coverage ' + obsPct + '%')}">
          <circle cx="55" cy="55" r="${R}" fill="none" stroke="rgba(178,34,34,0.2)" stroke-width="14"/>
          ${present > 0 ? `<circle cx="55" cy="55" r="${R}" fill="none" stroke="rgb(46,110,50)"  stroke-width="14"
            stroke-dasharray="${sPres} ${C - sPres}" stroke-dashoffset="${C / 4}" transform="rotate(-90 55 55)"/>` : ''}
          ${evidence > 0 ? `<circle cx="55" cy="55" r="${R}" fill="none" stroke="rgb(217,119,6)" stroke-width="14"
            stroke-dasharray="${sEvi} ${C - sEvi}" stroke-dashoffset="${C / 4 - sPres}" transform="rotate(-90 55 55)"/>` : ''}
          <text x="55" y="58" text-anchor="middle" class="posture-pie-pct">${obsPct}%</text>
          <text x="55" y="74" text-anchor="middle" class="posture-pie-sub">${present + evidence}/${total}</text>
        </svg>
        <div class="posture-pie-label">${escapeHtml(layer.label)}</div>
        <div class="posture-pie-verdict">${verdict}</div>
      </div>
    `;
  }).join('');

  wrap.innerHTML = `
    <div class="benchmark-block-head">
      <span class="benchmark-block-eyebrow">AT A GLANCE</span>
      Coverage per layer — observed (declared + evidence) over total mechanisms
    </div>
    <div class="posture-pie-row">${pies}</div>
    <div class="posture-pie-legend">
      <span class="posture-pie-legend-pip" style="background:rgb(46,110,50)"></span> declared in pack
      <span class="posture-pie-legend-pip" style="background:rgb(217,119,6)"></span> evidence-only
      <span class="posture-pie-legend-pip" style="background:rgba(178,34,34,0.4)"></span> missing
    </div>
  `;
  return wrap;
}

// ============================================================
// Footprint accordion — collapses the artefact-identity scorecard
// that used to lead the view. Default closed. For power users who
// want the raw N/M counts vs the reference's artefact set.
// ============================================================
function renderFootprintAccordion(score) {
  const wrap = document.createElement('details');
  wrap.className = 'benchmark-footprint-accordion';
  const overall = score.overall;
  const pct = overall.bTotal === 0 ? 0 : Math.round((overall.matched / overall.bTotal) * 100);
  const layerRows = score.byLayer.map(L => `
    <div class="benchmark-footprint-row">
      <span class="benchmark-footprint-layer">${escapeHtml(L.layer)}</span>
      <span class="benchmark-footprint-counts">${L.aTotal} / ${L.bTotal}</span>
      <span class="benchmark-footprint-pct">${L.bTotal === 0 ? '—' : Math.round((L.matched / L.bTotal) * 100) + '%'}</span>
    </div>
  `).join('');
  wrap.innerHTML = `
    <summary class="benchmark-footprint-summary">
      <span class="benchmark-footprint-eyebrow">FOOTPRINT</span>
      Raw artefact-identity comparison · ${overall.matched}/${overall.bTotal} reference IDs matched (${pct}%)
      <span class="benchmark-footprint-chevron">▾</span>
    </summary>
    <div class="benchmark-footprint-body">
      <div class="benchmark-footprint-caveat">
        Identity-match comparison: counts artefacts whose IDs appear in BOTH packs. Useful for spotting drift against a curated baseline, NOT for assessing posture (see matrix above).
      </div>
      <div class="benchmark-footprint-layers">${layerRows}</div>
    </div>
  `;
  return wrap;
}

function renderBenchmarkHeader(score, lens) {
  const head = document.createElement('div');
  head.className = 'benchmark-head';
  const lensLabel = lens === 'all' ? 'All artefacts' : (LENS_PRODUCTS.find(lp => lp.slug === lens)?.label || lens);
  head.innerHTML = `
    <div class="benchmark-head-eyebrow">BENCHMARK</div>
    <div class="benchmark-head-title">
      <span class="benchmark-head-pack benchmark-head-pack-a">${escapeHtml(state.pack?.name || state.pack?.id || 'Pack A')}</span>
      <span class="benchmark-head-vs">vs</span>
      <span class="benchmark-head-pack benchmark-head-pack-b">${escapeHtml(state.packB?.name || state.packB?.id || 'Pack B')}</span>
    </div>
    <div class="benchmark-head-meta">
      Lens · <strong>${escapeHtml(lensLabel)}</strong>
      ${lens === 'all'
        ? '<span class="benchmark-head-hint">Tip: pick a product lens for an apples-to-apples scorecard.</span>'
        : `<span class="benchmark-head-hint">Scoring only artefacts in ${escapeHtml(lensLabel)}'s surface.</span>`}
    </div>
  `;
  return head;
}

function renderBenchmarkScorecard(score) {
  const wrap = document.createElement('div');
  wrap.className = 'benchmark-scorecard';
  const overall = score.overall;
  const pct = overall.bTotal === 0 ? 0 : Math.round((overall.matched / overall.bTotal) * 100);
  const pctClass = pct >= 75 ? 'is-good' : pct >= 40 ? 'is-warn' : 'is-poor';

  // Per-layer rows: each shows A/B counts + a tiny coverage bar
  const layerRows = score.byLayer.map(L => {
    const lpct = L.bTotal === 0 ? null : Math.round((L.matched / L.bTotal) * 100);
    const bar = lpct === null ? '<span class="benchmark-layer-bar benchmark-layer-bar-empty"></span>' :
      `<span class="benchmark-layer-bar">
         <span class="benchmark-layer-bar-fill" style="width:${lpct}%"></span>
       </span>`;
    return `
      <div class="benchmark-layer-row">
        <span class="benchmark-layer-num">${escapeHtml(L.layer)}</span>
        <span class="benchmark-layer-counts">
          <span class="benchmark-layer-a">${L.aTotal}</span>
          <span class="benchmark-layer-sep">/</span>
          <span class="benchmark-layer-b">${L.bTotal}</span>
        </span>
        ${bar}
        <span class="benchmark-layer-pct">${lpct === null ? '—' : lpct + '%'}</span>
      </div>
    `;
  }).join('');

  // Live version sidebar — pulled from mcp.versions.* annotations
  // so the demo narrative ("the platform is running Grafana 12.4.0,
  // declared in the live pack") sits right next to the scorecard.
  const ann = state.pack?.meta?.annotations || state.pack?.metadata?.annotations || {};
  const liveVersions = [];
  for (const [k, v] of Object.entries(ann)) {
    const m = /^mcp\.versions\.([a-z0-9_-]+)$/.exec(k);
    if (m) liveVersions.push({ product: m[1], version: v });
  }
  const liveVersionsHtml = liveVersions.length
    ? `<div class="benchmark-meta-sub-head">Live versions</div>` +
      liveVersions.map(lv =>
        `<div class="benchmark-meta-live-row"><strong>${escapeHtml(lv.product)}</strong><span>${escapeHtml(lv.version)}</span></div>`
      ).join('')
    : '<div class="benchmark-meta-empty"><em>No live versions captured</em></div>';

  wrap.innerHTML = `
    <div class="benchmark-scorecard-grid">
      <div class="benchmark-card benchmark-card-overall">
        <div class="benchmark-card-key">Coverage</div>
        <div class="benchmark-card-pct ${pctClass}">${pct}%</div>
        <div class="benchmark-card-sub">${overall.matched} of ${overall.bTotal} reference artefacts present in your live pack</div>
      </div>
      <div class="benchmark-card benchmark-card-layers">
        <div class="benchmark-card-key">Per-layer (live / ref)</div>
        ${layerRows}
      </div>
      <div class="benchmark-card benchmark-card-meta">
        <div class="benchmark-card-key">Evidence</div>
        <div class="benchmark-meta-line"><strong>${score.verifiedCount}</strong> artefacts verified by MCP</div>
        ${liveVersionsHtml}
      </div>
    </div>
  `;
  return wrap;
}

function renderBenchmarkMissing(score) {
  const wrap = document.createElement('div');
  wrap.className = 'benchmark-callout benchmark-callout-missing';
  const top = score.missing.slice(0, 10);
  wrap.innerHTML = `
    <div class="benchmark-callout-head">
      <span class="benchmark-callout-eyebrow">MISSING</span>
      Items the reference recommends, not present in your live pack
      <span class="benchmark-callout-count">${score.missing.length}</span>
    </div>
    ${top.length === 0
      ? '<div class="benchmark-callout-empty">Nothing missing — your live pack covers everything the reference recommends. 🎯</div>'
      : '<ul class="benchmark-callout-list">' + top.map(m => `
          <li>
            <span class="benchmark-callout-layer">${escapeHtml(m.layer)}</span>
            <span class="benchmark-callout-title">${escapeHtml(m.title)}</span>
            ${m.id ? `<span class="benchmark-callout-id">${escapeHtml(m.id)}</span>` : ''}
          </li>
        `).join('') + '</ul>'}
    ${score.missing.length > 10 ? `<div class="benchmark-callout-more">+ ${score.missing.length - 10} more</div>` : ''}
  `;
  return wrap;
}

function renderBenchmarkExtras(score) {
  const wrap = document.createElement('div');
  wrap.className = 'benchmark-callout benchmark-callout-extras';
  const top = score.extras.slice(0, 5);
  wrap.innerHTML = `
    <div class="benchmark-callout-head">
      <span class="benchmark-callout-eyebrow">EXTRAS</span>
      In your live pack, not in the reference
      <span class="benchmark-callout-count">${score.extras.length}</span>
    </div>
    ${top.length === 0
      ? '<div class="benchmark-callout-empty">No extras in scope.</div>'
      : '<ul class="benchmark-callout-list">' + top.map(m => `
          <li>
            <span class="benchmark-callout-layer">${escapeHtml(m.layer)}</span>
            <span class="benchmark-callout-title">${escapeHtml(m.title)}</span>
            ${m.id ? `<span class="benchmark-callout-id">${escapeHtml(m.id)}</span>` : ''}
          </li>
        `).join('') + '</ul>'}
    ${score.extras.length > 5 ? `<div class="benchmark-callout-more">+ ${score.extras.length - 5} more</div>` : ''}
  `;
  return wrap;
}

// Pure: walks both packs under the lens, returns scorecard data.
function computeBenchmarkScorecard(packA, packB, lens) {
  const byLayer = [];
  const missing = [];   // in B, not in A
  const extras  = [];   // in A, not in B
  let overallA = 0, overallB = 0, overallMatched = 0, verifiedCount = 0;
  const sets = buildCompareKeySets();

  // Walk B's annotations to count "verified by MCP" markers (any
  // artefact whose mcp.verified.<sym> stamp is present).
  const annA = packA?.meta?.annotations || packA?.metadata?.annotations || {};
  for (const k of Object.keys(annA)) {
    if (/^mcp\.verified\./.test(k)) verifiedCount++;
  }

  for (const L of LAYERS_FOR_DIFF) {
    const aItems = layerItemsFor(packA, L).filter(a => productSurface(a, lens, packA));
    const bItems = layerItemsFor(packB, L).filter(a => productSurface(a, lens, packB));
    const aKeys = new Set(aItems.map(a => compareKeyOf(a)));
    const bKeys = new Set(bItems.map(a => compareKeyOf(a)));

    let matched = 0;
    for (const b of bItems) {
      const k = compareKeyOf(b);
      if (aKeys.has(k)) matched++;
      else missing.push({ layer: L, key: k, id: b.id || '', title: b.title || k });
    }
    for (const a of aItems) {
      const k = compareKeyOf(a);
      if (!bKeys.has(k)) extras.push({ layer: L, key: k, id: a.id || '', title: a.title || k });
    }

    byLayer.push({ layer: L, aTotal: aItems.length, bTotal: bItems.length, matched });
    overallA += aItems.length;
    overallB += bItems.length;
    overallMatched += matched;
  }

  return {
    overall: { aTotal: overallA, bTotal: overallB, matched: overallMatched },
    byLayer,
    missing,
    extras,
    verifiedCount,
  };
}

function renderCompareView(view) {
  if (!state.compareBId) state.compareBId = defaultCompareB();
  if (!state.compareBEnv) state.compareBEnv = defaultEnvFor(state.compareBId);

  if (!state.compareBId) {
    view.innerHTML = '<div class="placeholder">Need at least two packs in the catalog to compare.</div>';
    return;
  }

  const scaffold = document.createElement('section');
  scaffold.className = 'section compare-view';
  scaffold.dataset.layer = 'COMPARE';
  view.appendChild(scaffold);

  const haveA = !!state.pack;
  const haveB = !!state.packB;
  const haveDiff = !!state.diff && !state.diff.error;
  if (!haveA || !haveB || !haveDiff) {
    if (state.diff?.error) {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = `Diff failed: ${state.diff.error}`;
      scaffold.appendChild(err);
      return;
    }
    const loading = document.createElement('div');
    loading.className = 'placeholder';
    loading.textContent = 'Loading both packs…';
    scaffold.appendChild(loading);
    Promise.all([
      haveB    ? Promise.resolve() : loadPackB(),
      haveDiff ? Promise.resolve() : loadDiff(),
    ]).then(() => { renderTabs(); renderMainView(); });
    return;
  }

  // Tall header band: two pack-summary cards (A on left, B on right)
  // with name + tier + version + env + count. Always visible — answers
  // "what am I comparing" at a glance.
  scaffold.appendChild(renderComparePackHeaders());

  // Set-arithmetic summary + slice filter pills + search.
  scaffold.appendChild(renderCompareSummary());
  scaffold.appendChild(renderCompareFilters());

  // Build per-layer key-set lookups once.
  const sets = buildCompareKeySets();

  // Stack per-layer rows. Each row has the layer header SPANNING both
  // columns, then a left grid (A) + right grid (B) aligned beneath it.
  for (const L of LAYERS_FOR_DIFF) {
    const row = renderCompareLayerRow(L, sets);
    if (row) scaffold.appendChild(row);
  }
}

function buildCompareKeySets() {
  const keysOnlyInA = {}, keysInBoth = {}, keysOnlyInB = {};
  for (const L of LAYERS_FOR_DIFF) {
    const bucket = state.diff.layers[L] || { onlyInA: [], onlyInB: [], inBoth: [] };
    keysOnlyInA[L] = new Set(bucket.onlyInA.map(x => x.key));
    keysOnlyInB[L] = new Set(bucket.onlyInB.map(x => x.key));
    keysInBoth[L]  = new Set(bucket.inBoth.map(x => x.key));
  }
  return { keysOnlyInA, keysInBoth, keysOnlyInB };
}

// New: stacked PACK A + PACK B header band, side-by-side.
function renderComparePackHeaders() {
  const wrap = document.createElement('div');
  wrap.className = 'compare-pack-headers';
  wrap.appendChild(renderComparePackHeader('a', state.pack,  state.diff?.a));

  // Swap button BETWEEN the two cards — visually anchors the
  // "A vs B" relationship and removes the need for a separate
  // picker band. Disabled when there's nothing to swap to.
  const swapWrap = document.createElement('div');
  swapWrap.className = 'compare-swap-wrap';
  swapWrap.innerHTML = `
    <button class="compare-swap-btn" type="button" id="compare-swap-btn" title="Swap PACK A and PACK B (and their envs)" aria-label="Swap packs">
      <span class="csb-arrow">⇄</span>
      <span class="csb-label">swap</span>
    </button>
  `;
  swapWrap.querySelector('#compare-swap-btn').onclick = () => {
    const aId  = state.selectedPackId;
    const aEnv = state.selectedEnv;
    if (!state.compareBId) return;
    state.selectedPackId = state.compareBId;
    state.selectedEnv    = state.compareBEnv;
    state.compareBId  = aId;
    state.compareBEnv = aEnv;
    state.diff = null; state.packB = null;
    refresh();
    refreshDiff();
  };
  wrap.appendChild(swapWrap);

  wrap.appendChild(renderComparePackHeader('b', state.packB, state.diff?.b));
  return wrap;
}

// Return the catalog entry for a pack id — the source of truth for
// the human-readable label, version, criticality, environments. The
// per-pack metadata.name in the YAML may DIFFER from the catalog
// label (e.g. catalog "Target advanced (tier-1 reference)" vs YAML
// metadata.name "platform-edge"); the catalog label is what the
// user picked from the dropdown, so it wins for display.
export function catalogEntryFor(packId) {
  return (state.catalog || []).find(p => p.id === packId) || null;
}

function renderComparePackHeader(side, pack, diffMeta) {
  const card = document.createElement('div');
  card.className = `compare-pack-card compare-pack-card-${side}`;
  const tier = pack?.meta?.criticality || '?';
  const sourcePill = inferPackSource(pack);   // 'Repo' | 'Live' | 'Target' | 'Pack'
  // Artefact count: sum across all layers (L4 has sub-buckets).
  let count = 0;
  for (const L of LAYERS_FOR_DIFF) {
    if (L === 'L4') {
      const L4 = pack?.layers?.L4 || {};
      count += (L4.policy?.length || 0) + (L4.alerting?.length || 0) + (L4.healing?.length || 0);
    } else {
      count += (pack?.layers?.[L] || []).length;
    }
  }
  // Resolve the active id + env per side, plus the catalog entry so we
  // use the catalog label (what the user PICKED) rather than the YAML's
  // metadata.name (which can differ — bug surfaced by user feedback).
  const activeId  = (side === 'a') ? state.selectedPackId : state.compareBId;
  const activeEnv = (side === 'a') ? state.selectedEnv   : state.compareBEnv;
  const catalogEntry = catalogEntryFor(activeId);
  const displayLabel = catalogEntry?.label || pack?.name || activeId || '?';
  const envOptions   = catalogEntry?.environments || [];
  const tierResolved = catalogEntry?.criticality || tier;
  const versionResolved = catalogEntry?.version || pack?.meta?.version || '?';

  // Build the pack + env picker options from the live catalog.
  const packOptionsHtml = (state.catalog || [])
    .filter(p => p.ok)
    .map(p => `<option value="${escapeHtml(p.id)}" ${p.id === activeId ? 'selected' : ''}>${escapeHtml(p.label)}</option>`)
    .join('');
  const envOptionsHtml = (envOptions.length ? envOptions : (activeEnv ? [activeEnv] : []))
    .map(e => `<option value="${escapeHtml(e)}" ${e === activeEnv ? 'selected' : ''}>${escapeHtml(e)}</option>`)
    .join('');

  card.innerHTML = `
    <div class="cpc-eyebrow">PACK ${side.toUpperCase()}</div>
    <div class="cpc-pickers">
      <label class="cpc-pickfield">
        <span class="cpc-pickfield-key">pack</span>
        <select class="cpc-pack-select" data-side="${side}">${packOptionsHtml}</select>
      </label>
      <label class="cpc-pickfield cpc-pickfield-env">
        <span class="cpc-pickfield-key">env</span>
        <select class="cpc-env-select" data-side="${side}" ${envOptions.length ? '' : 'disabled'}>${envOptionsHtml || '<option>—</option>'}</select>
      </label>
    </div>
    <div class="cpc-row">
      <span class="cpc-source-pill" data-source="${escapeHtml(sourcePill)}">${escapeHtml(sourcePill)}</span>
      <span class="cpc-name" title="catalog label">${escapeHtml(displayLabel)}</span>
    </div>
    <div class="cpc-meta">
      <span class="cpc-meta-pill" data-tier="${escapeHtml(tierResolved)}">${escapeHtml(tierResolved)}</span>
      <span class="cpc-meta-pill">v${escapeHtml(versionResolved)}</span>
      <span class="cpc-meta-pill cpc-count">${count} artefact${count === 1 ? '' : 's'}</span>
    </div>
    <div class="cpc-actions">
      <button class="cpc-action-btn" data-action="evaluate" title="Show maturity score: per-tier conformance breakdown">
        <span class="cpc-action-icon">✓</span> evaluate
      </button>
      <button class="cpc-action-btn" data-action="coverage" title="Show coverage breakdown by layer + sub-bucket">
        <span class="cpc-action-icon">∑</span> coverage
      </button>
      <button class="cpc-action-btn cpc-action-deploy" data-action="deploy" title="Open the deploy modal scoped to this pack">
        <span class="cpc-action-icon">↑</span> deploy
      </button>
    </div>
  `;

  // Wire the pickers — changes trigger a reload of the affected side
  // and re-fetch the diff.
  const packSel = card.querySelector('.cpc-pack-select');
  if (packSel) packSel.onchange = () => {
    const newId = packSel.value;
    if (side === 'a') {
      state.selectedPackId = newId;
      state.selectedEnv    = defaultEnvFor(newId);
      state.diff = null;
      refresh();
      refreshDiff();
    } else {
      state.compareBId = newId;
      state.compareBEnv = defaultEnvFor(newId);
      state.diff = null; state.packB = null;
      refreshDiff();
      renderTabs(); renderMainView();
    }
  };
  const envSel = card.querySelector('.cpc-env-select');
  if (envSel) envSel.onchange = () => {
    if (side === 'a') { state.selectedEnv = envSel.value || null; refresh(); }
    else { state.compareBEnv = envSel.value || null; state.packB = null; state.diff = null; refreshDiff(); renderTabs(); renderMainView(); }
  };
  // Wire the action buttons. Evaluate opens the maturity popover;
  // coverage opens a layer-by-layer count breakdown.
  const evalBtn = card.querySelector('[data-action="evaluate"]');
  if (evalBtn) evalBtn.onclick = (e) => { e.stopPropagation(); openMaturityPopover(side, pack, card); };
  const covBtn = card.querySelector('[data-action="coverage"]');
  if (covBtn) covBtn.onclick = (e) => { e.stopPropagation(); openCoveragePopover(side, pack, card); };
  const depBtn = card.querySelector('[data-action="deploy"]');
  if (depBtn) depBtn.onclick = (e) => {
    e.stopPropagation();
    const packId = (side === 'a') ? state.selectedPackId : state.compareBId;
    openDeployModal({ packId });
  };
  return card;
}

// ------------------------------------------------------------
// Maturity score popover — score with per-clause pass/fail
// grouped by tier. Drives off /api/packs/:id/conformance which
// returns the rubric evaluation the studio already uses on the
// SCHEMA tab.
// ------------------------------------------------------------

async function openMaturityPopover(side, pack, anchor) {
  // Resolve which pack id to fetch conformance for.
  const packId = (side === 'a') ? state.selectedPackId : state.compareBId;
  const env    = (side === 'a') ? state.selectedEnv   : state.compareBEnv;
  // Tear down any open popover first.
  document.querySelectorAll('.maturity-popover, .coverage-popover').forEach(n => n.remove());

  const pop = document.createElement('div');
  pop.className = 'maturity-popover';
  pop.dataset.side = side;
  pop.innerHTML = `
    <div class="mp-head">
      <div class="mp-eyebrow">MATURITY SCORE</div>
      <button class="mp-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="mp-body"><div class="placeholder">Evaluating…</div></div>
  `;
  anchor.appendChild(pop);
  pop.querySelector('.mp-close').onclick = () => pop.remove();

  // Outside-click dismiss.
  setTimeout(() => {
    const onDoc = (e) => {
      if (!pop.contains(e.target) && !anchor.querySelector('[data-action="evaluate"]')?.contains(e.target)) {
        pop.remove();
        document.removeEventListener('click', onDoc);
      }
    };
    document.addEventListener('click', onDoc);
  }, 50);

  try {
    const qs = env ? `?env=${encodeURIComponent(env)}` : '';
    const conf = await api(`/api/packs/${encodeURIComponent(packId)}/conformance${qs}`);
    pop.querySelector('.mp-body').innerHTML = renderMaturityPopoverBody(conf, pack?.name);
  } catch (e) {
    pop.querySelector('.mp-body').innerHTML = `<div class="error">Could not evaluate: ${escapeHtml(e.message)}</div>`;
  }
}

function renderMaturityPopoverBody(conf, packName) {
  // Conformance shape:
  //   declaredTier, conformant, scorePercent, mustPercent, must {passed,total}, should{...},
  //   clauses: [{ id, dimension, severity, minTier, description, applies, passed }]
  const score = Math.round(conf.scorePercent || 0);
  const verdict = conf.conformant ? 'conformant' : 'non-conformant';
  const verdictClass = conf.conformant ? 'mp-verdict-ok' : 'mp-verdict-err';
  // Group clauses by minTier. Display order: tier-3 first (the floor), then tier-2, then tier-1.
  // The conformance lib's clause shape is { id, dimension, severity, minTier,
  // description, applies, pass } — `pass` is null when applies=false.
  const tiers = ['tier-3', 'tier-2', 'tier-1'];
  const tierLabels = {
    'tier-3': 'TIER 3 — MINIMUM CONFORMANCE',
    'tier-2': 'TIER 2 — INTERNAL CRITICAL',
    'tier-1': 'TIER 1 — CUSTOMER-FACING',
  };
  const sections = tiers.map(t => {
    const items = (conf.clauses || []).filter(c => c.minTier === t);
    if (!items.length) return '';
    const applicable = items.filter(c => c.applies);
    const passed     = items.filter(c => c.pass === true).length;
    const countLabel = applicable.length === items.length
      ? `${passed}/${items.length}`
      : `${passed}/${applicable.length}<span class="mp-tier-na"> (${items.length - applicable.length} N/A)</span>`;
    return `
      <div class="mp-tier">
        <div class="mp-tier-head">
          <span class="mp-tier-label">${tierLabels[t]}</span>
          <span class="mp-tier-count">${countLabel}</span>
        </div>
        <ul class="mp-clauses">
          ${items.map(c => {
            const cls = !c.applies ? 'is-na' : (c.pass ? 'is-passed' : 'is-failed');
            return `
              <li class="mp-clause ${cls}" title="${escapeHtml(c.description || '')}">
                <span class="mp-clause-num">${escapeHtml(c.id)}</span>
                <span class="mp-clause-desc">${escapeHtml(c.dimension || c.description || c.id)}</span>
                <span class="mp-clause-sev">${escapeHtml(c.severity || '')}</span>
              </li>`;
          }).join('')}
        </ul>
      </div>`;
  }).join('');
  return `
    <div class="mp-score-row">
      <div class="mp-score-big">${score}<span class="mp-score-denom">/100</span></div>
      <div class="mp-score-side">
        <div class="mp-pack-name">${escapeHtml(packName || '')}</div>
        <div class="mp-verdict ${verdictClass}">${escapeHtml(verdict)}</div>
        <div class="mp-score-mini">MUST ${conf.must?.passed || 0}/${conf.must?.total || 0} · SHOULD ${conf.should?.passed || 0}/${conf.should?.total || 0}</div>
      </div>
    </div>
    ${sections}
  `;
}

// ------------------------------------------------------------
// Coverage popover — per-layer breakdown with sub-buckets so the
// SRE can see "26 L3 = 19 dashboards + 7 recording rules", etc.
// ------------------------------------------------------------

function openCoveragePopover(side, pack, anchor) {
  document.querySelectorAll('.maturity-popover, .coverage-popover').forEach(n => n.remove());
  const pop = document.createElement('div');
  pop.className = 'coverage-popover';
  pop.dataset.side = side;
  pop.innerHTML = `
    <div class="mp-head">
      <div class="mp-eyebrow">COVERAGE BREAKDOWN</div>
      <button class="mp-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="mp-body">${renderCoveragePopoverBody(pack)}</div>
  `;
  anchor.appendChild(pop);
  pop.querySelector('.mp-close').onclick = () => pop.remove();
  setTimeout(() => {
    const onDoc = (e) => {
      if (!pop.contains(e.target) && !anchor.querySelector('[data-action="coverage"]')?.contains(e.target)) {
        pop.remove();
        document.removeEventListener('click', onDoc);
      }
    };
    document.addEventListener('click', onDoc);
  }, 50);
}

function renderCoveragePopoverBody(pack) {
  // Sub-bucket each layer the same way the spec breaks them down.
  const breakdown = [];
  let total = 0;
  const layers = pack?.layers || {};

  function countAndAdd(layerLabel, layerKey, items, subBuckets) {
    const n = items.length;
    total += n;
    const subRows = subBuckets ? Object.entries(subBuckets).map(([k, v]) => `
      <tr class="cv-sub">
        <td class="cv-key">${escapeHtml(k)}</td>
        <td class="cv-val">${v}</td>
      </tr>`).join('') : '';
    breakdown.push(`
      <tr class="cv-row" data-layer="${escapeHtml(layerKey)}">
        <td class="cv-key"><span class="cv-pill" data-layer="${escapeHtml(layerKey)}">${escapeHtml(layerKey)}</span> ${escapeHtml(layerLabel)}</td>
        <td class="cv-val">${n}</td>
      </tr>${subRows}`);
  }

  // L1: SLIs + SLOs
  const l1 = layers.L1 || [];
  const l1Sub = {
    'SLIs':  l1.filter(x => /^SLI-/.test(x.id)).length,
    'SLOs':  l1.filter(x => /^SLO-/.test(x.id)).length,
  };
  countAndAdd('SLI/SLO', 'L1', l1, Object.values(l1Sub).reduce((a,b)=>a+b,0) > 0 ? l1Sub : null);

  // L2: Backends + Pipelines + Storage + Otel
  const l2 = layers.L2 || [];
  const l2Sub = {
    'Backends':     l2.filter(x => /^BAK-/.test(x.id)).length,
    'Pipelines':    l2.filter(x => /^PIP-/.test(x.id)).length,
    'Storage':      l2.filter(x => /^STO-/.test(x.id)).length,
    'OTel':         l2.filter(x => /^OTEL-/.test(x.id)).length,
  };
  countAndAdd('Metrics/Logs/Traces', 'L2', l2, l2Sub);

  // L2X: extended
  if ((layers.L2X || []).length) countAndAdd('Extended surfaces', 'L2X', layers.L2X);

  // L3: Queries + Views + Dashboards
  const l3 = layers.L3 || [];
  const l3Sub = {
    'Dashboards':       l3.filter(x => /^DASH-/.test(x.id)).length,
    'Recording rules':  l3.filter(x => /^QRY-/.test(x.id)).length,
    'Derived views':    l3.filter(x => /^VIEW-/.test(x.id)).length,
  };
  countAndAdd('Dashboards/Queries', 'L3', l3, l3Sub);

  // L4: policy + alerting + healing
  const l4 = layers.L4 || {};
  const l4Items = [...(l4.policy || []), ...(l4.alerting || []), ...(l4.healing || [])];
  const l4Sub = {
    'Burn-rate alerts': (l4.policy || []).filter(x => /^POL-/.test(x.id)).length,
    'Forecast alerts':  (l4.policy || []).filter(x => /^FCST-/.test(x.id)).length,
    'Alert routes':     (l4.alerting || []).length,
    'Remediation':      (l4.healing || []).length,
  };
  countAndAdd('Alerts + remediation', 'L4', l4Items, l4Sub);

  // L5: baselines + chaos + synthetic
  const l5 = layers.L5 || [];
  const l5Sub = {
    'Baselines':       l5.filter(x => /^BASE-/.test(x.id)).length,
    'Chaos':           l5.filter(x => /^CHAOS-/.test(x.id)).length,
    'Synthetic':       l5.filter(x => /^SYN-/.test(x.id)).length,
  };
  countAndAdd('Self-check', 'L5', l5, l5Sub);

  // GOV
  if ((layers.GOV || []).length) countAndAdd('Governance', 'GOV', layers.GOV);

  return `
    <table class="cv-table">
      ${breakdown.join('')}
      <tr class="cv-total">
        <td class="cv-key"><strong>Total</strong></td>
        <td class="cv-val"><strong>${total}</strong></td>
      </tr>
    </table>
    <div class="cv-foot">Sub-buckets count by id prefix (SLI-, BAK-, DASH-, etc.). Pack generated from canonical v1.2 manifest.</div>
  `;
}

function inferPackSource(pack) {
  // The studio's source taxonomy is per-artefact, not per-pack. We
  // infer the pack-level label from id + dominant artefact source.
  if (!pack) return 'Pack';
  const id = (pack.id || '').toLowerCase();
  if (id.includes('live'))     return 'Live';
  if (id.includes('target'))   return 'Target';
  if (id.includes('curated'))  return 'Repo';
  if (id.includes('skeleton')) return 'Demo';
  // Fallback: look at the artefact sources
  const first = (pack?.layers?.L1 || [])[0];
  if (first?.source === 'Verified') return 'Live';
  return 'Repo';
}

// Slice filter pills + search input.
function renderCompareFilters() {
  const wrap = document.createElement('div');
  wrap.className = 'compare-filters';
  const slices = [
    { id: 'all',   label: 'All',       hint: 'Every artefact from both packs, side by side.' },
    { id: 'onlyA', label: 'Only in A', hint: 'Artefacts present in pack A but not in pack B. Right column is empty.' },
    { id: 'onlyB', label: 'Only in B', hint: 'Artefacts present in pack B but not in pack A. Left column is empty.' },
    { id: 'both',  label: 'In both',   hint: 'Artefacts present in both packs (matched by `defines` symbol or id).' },
    { id: 'a-b',   label: 'A − B',     hint: 'Set difference: every artefact in A, minus anything also in B.' },
    { id: 'a+b',   label: 'A + B',     hint: 'Union: combined view of both packs without duplication.' },
  ];
  const active = state.compareSlice || 'all';
  for (const s of slices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'compare-slice-pill' + (s.id === active ? ' is-active' : '');
    b.dataset.slice = s.id;
    b.textContent = s.label;
    b.title = s.hint;
    b.onclick = () => { state.compareSlice = s.id; renderMainView(); };
    wrap.appendChild(b);
  }
  // Lens — scopes the comparison to one product's surface. When the user
  // picks "Grafana", both packs are filtered to just their Grafana-surface
  // artefacts (backends, dashboards, refs, source-tool evidence). Lets a
  // multi-backend live pack be benchmarked against a single-product
  // reference without the noise of every other backend.
  const lensWrap = document.createElement('div');
  lensWrap.className = 'compare-lens-wrap';
  const lensLabel = document.createElement('span');
  lensLabel.className = 'compare-lens-label';
  lensLabel.textContent = 'Lens';
  lensWrap.appendChild(lensLabel);
  const lensSel = document.createElement('select');
  lensSel.className = 'compare-lens-select';
  lensSel.title = "Scope to one product's surface — for benchmarking against a reference pack.";
  const optAll = document.createElement('option');
  optAll.value = 'all'; optAll.textContent = 'All artefacts';
  lensSel.appendChild(optAll);
  for (const lp of LENS_PRODUCTS) {
    const o = document.createElement('option');
    o.value = lp.slug;
    o.textContent = lp.label;
    lensSel.appendChild(o);
  }
  lensSel.value = state.compareLens || 'all';
  lensSel.dataset.lens = lensSel.value;
  lensSel.onchange = () => {
    state.compareLens = lensSel.value;
    lensSel.dataset.lens = lensSel.value;
    renderMainView();
  };
  lensWrap.appendChild(lensSel);
  wrap.appendChild(lensWrap);

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'compare-search-input';
  search.placeholder = 'search id or title…';
  search.value = state.compareSearch || '';
  // Use input event for live filter; debounce via requestAnimationFrame.
  let pending = null;
  search.addEventListener('input', () => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      state.compareSearch = search.value;
      renderMainView();
      // After re-render, restore focus + cursor (renderMainView wipes the DOM).
      const fresh = document.querySelector('.compare-search-input');
      if (fresh) { fresh.focus(); fresh.setSelectionRange(search.value.length, search.value.length); }
    });
  });
  wrap.appendChild(search);
  return wrap;
}

// Per-layer ROW: layer head spans both columns, then two aligned grids.
function renderCompareLayerRow(L, sets) {
  const aItems = layerItemsFor(state.pack, L);
  const bItems = layerItemsFor(state.packB, L);
  if (aItems.length === 0 && bItems.length === 0) return null;

  const layerNames = {L1:'Contract',L2:'Telemetry',L2X:'Extended',L3:'Insight',L4:'Action',L5:'Validation',GOV:'Governance'};
  const row = document.createElement('section');
  row.className = 'compare-layer-row';
  row.dataset.layer = L;
  // Counts after slice + search filtering.
  const filteredA = filterCompareItems(aItems, L, 'a', sets);
  const filteredB = filterCompareItems(bItems, L, 'b', sets);
  if (filteredA.length === 0 && filteredB.length === 0) return null;

  const head = document.createElement('div');
  head.className = 'compare-layer-head';
  head.innerHTML = `
    <span class="section-num">${L}</span>
    <span class="section-name">${escapeHtml(layerNames[L] || L)}</span>
    <span class="section-count">
      <span class="cli-pill cli-a">${filteredA.length}</span>
      <span class="cli-vs">vs</span>
      <span class="cli-pill cli-b">${filteredB.length}</span>
    </span>
  `;
  row.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'compare-layer-grid';
  grid.appendChild(renderCompareLayerColumn('a', L, filteredA, sets));
  grid.appendChild(renderCompareLayerColumn('b', L, filteredB, sets));
  row.appendChild(grid);
  return row;
}

export function layerItemsFor(pack, L) {
  if (!pack?.layers) return [];
  if (L === 'L4') {
    const L4 = pack.layers.L4 || {};
    const out = [];
    for (const sg of L4_SUBGROUPS) for (const it of (L4[sg.key] || [])) out.push({ ...it, _sub: sg.key });
    return out;
  }
  return pack.layers[L] || [];
}

// Product-surface lens — answers "does this artefact belong to <product>'s
// surface?" Used by the Compare view's lens dropdown and by the
// Benchmark view to scope a comparison to one product (e.g. just Grafana).
//
// An artefact is in <product>'s surface if ANY of these hold:
//
//   1. STRUCTURAL — the artefact IS a backend whose `product` slug matches,
//      or IS a dashboard whose `provider.kind` matches.
//   2. REFERENTIAL — the artefact `refs` a backend that's in the surface
//      (e.g. an SLI that queries metrics from `dashboards-grafana`).
//   3. SOURCE — the pack carries an `mcp.source.<artefact-id>` annotation
//      whose value starts with `<product>_` (Phase 2 fetcher stamp).
//   4. REFERENCE-PACK SHORTCUT — when the pack's metadata.name matches
//      `<product>-reference`, every artefact in it is in scope by design.
//
// Returns true/false. Falls through to true when the lens is 'all'
// or when no product is specified.
function productSurface(art, product, pack) {
  if (!product || product === 'all') return true;
  if (!art) return false;
  const p = product.toLowerCase();
  const idLower = typeof art.id === 'string' ? art.id.toLowerCase() : '';

  // 0. Cross-cutting infrastructure (OTel SDK, pipelines, storage,
  //    governance imports) is NEVER in a single product's surface unless
  //    it explicitly refs a backend in the surface (handled in rule 4).
  //    These artefacts have ids like OTEL-01, PIP-RCV-01, PIP-PRC-01,
  //    PIP-EXP-MET, STO-MET-01, IMP-01.
  const isInfra = /^(otel|pip|sto|imp)[-_]/i.test(art.id || '');

  if (!isInfra) {
    // 1. Structural — backend with matching product slug
    if (art.spec?.product === p) return true;
    if (art.product === p) return true;

    // 1b. Structural — dashboard whose provider.kind matches
    if (art.spec?.provider?.kind === p) return true;
    if (art.provider?.kind === p) return true;

    // 1c. Backend id pattern — `<signal>-<product>` (e.g. dashboards-grafana,
    //     metrics-victoriametrics). The fetcher mints ids in this shape.
    if (idLower.endsWith(`-${p}`) || idLower === p) return true;

    // 2. Backend artefact for a DIFFERENT product — exclude.
    //    Reference packs declare monitoring backends (e.g. grafana-reference
    //    pulls in metrics-prom + metrics-mimir to monitor Grafana). Those
    //    are instrumentation, not Grafana — the Grafana lens shouldn't
    //    surface them. This rule lives BEFORE the reference-pack shortcut
    //    so the shortcut can't override it.
    const otherBackendProduct = (art.spec?.product || art.product || '').toLowerCase();
    if (otherBackendProduct && otherBackendProduct !== p) return false;
    // Same logic for dashboards: a non-matching provider.kind is excluded.
    const otherDashKind = (art.spec?.provider?.kind || art.provider?.kind || '').toLowerCase();
    if (otherDashKind && otherDashKind !== p) return false;

    // 3. Reference-pack shortcut — when this pack IS the product reference,
    //    the remaining artefacts (SLIs, SLOs, dashboards without a kind,
    //    alerts, chaos, governance imports) are by construction about
    //    that product. The backend exclusion above guards against
    //    instrumentation backends leaking in. Excludes infra artefacts
    //    via the isInfra branch wrapping this block.
    const packName = (pack?.meta?.name || pack?.id || '').toLowerCase();
    if (packName === `${p}-reference` || packName === `${p}`) return true;
  }

  // 4. Referential — refs a backend in the product surface.
  //    Applies to BOTH infra and non-infra artefacts: a STO-MET-01 that
  //    refs `backend: ref:metrics-victoriametrics` IS in the VM surface.
  const refs = Array.isArray(art.refs) ? art.refs : [];
  const surfaceBackendIds = collectSurfaceBackendIds(pack, p);
  for (const r of refs) {
    if (typeof r !== 'string') continue;
    const last = r.split('.').pop().replace(/^ref:/, '').toLowerCase();
    if (surfaceBackendIds.has(last)) return true;
  }

  // 5. Source — annotation says the artefact came from a <product>_* tool.
  const ann = pack?.meta?.annotations || pack?.metadata?.annotations || {};
  const idForAnn = art.id || art.title;
  if (idForAnn) {
    const src = ann[`mcp.source.${idForAnn}`];
    if (typeof src === 'string' && src.toLowerCase().startsWith(`${p}_`)) return true;
  }

  return false;
}

// Build (and cache per-render) the set of backend ids whose `product`
// matches the lens — used by productSurface() to follow `refs` back to
// the originating backend.
const _surfaceCache = new WeakMap();
function collectSurfaceBackendIds(pack, product) {
  if (!pack || !product) return new Set();
  let perPack = _surfaceCache.get(pack);
  if (!perPack) { perPack = new Map(); _surfaceCache.set(pack, perPack); }
  if (perPack.has(product)) return perPack.get(product);
  const ids = new Set();
  const L2 = (pack.layers?.L2 || []);
  for (const b of L2) {
    const bProd = (b.spec?.product || b.product || '').toLowerCase();
    if (bProd === product && typeof b.id === 'string') {
      ids.add(b.id.toLowerCase());
      ids.add(b.id.toLowerCase().split('-').pop());  // last segment (e.g. "grafana")
    }
  }
  perPack.set(product, ids);
  return ids;
}

// Catalogue of products that have a matching reference pack. Drives the
// Lens dropdown, the per-backend "Benchmark vs <product>-reference" CTA,
// and the Advanced → References view. Keep in sync with REFERENCE_PACKS in
// server/index.mjs (each entry maps a product slug to its reference pack).
export const LENS_PRODUCTS = [
  { slug: 'grafana',    label: 'Grafana',    refPackId: 'grafana-reference' },
  { slug: 'prometheus', label: 'Prometheus', refPackId: 'prometheus-reference' },
  { slug: 'kafka',      label: 'Kafka',      refPackId: 'kafka-reference' },
];

// Apply slice + text search + lens to a side's items.
function filterCompareItems(items, L, side, sets) {
  const slice = state.compareSlice || 'all';
  const search = (state.compareSearch || '').trim().toLowerCase();
  const lens = state.compareLens || 'all';
  const sidePack = side === 'a' ? state.pack : state.packB;
  return items.filter(art => {
    if (lens !== 'all' && !productSurface(art, lens, sidePack)) return false;
    const k = compareKeyOf(art);
    const inBoth = sets.keysInBoth[L]?.has(k);
    const onlySide = side === 'a' ? sets.keysOnlyInA[L]?.has(k) : sets.keysOnlyInB[L]?.has(k);
    let sliceOk = true;
    switch (slice) {
      case 'onlyA': sliceOk = side === 'a' && onlySide; break;
      case 'onlyB': sliceOk = side === 'b' && onlySide; break;
      case 'both':  sliceOk = inBoth; break;
      case 'a-b':   sliceOk = side === 'a' && (onlySide || !inBoth); break;   // items in A not in B
      case 'a+b':   sliceOk = true; break;                                     // union
      default:      sliceOk = true;
    }
    if (!sliceOk) return false;
    if (!search) return true;
    const hay = `${art.id || ''} ${art.title || ''}`.toLowerCase();
    return hay.includes(search);
  });
}

function renderCompareLayerColumn(side, L, items, sets) {
  const col = document.createElement('div');
  col.className = `compare-layer-col compare-layer-col-${side}`;
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'compare-layer-empty';
    empty.textContent = '— nothing matches —';
    col.appendChild(empty);
    return col;
  }
  for (const art of items) {
    const def = { id: L, num: L, name: L };
    col.appendChild(renderCompareCard(art, def, art._sub || null, side, sets));
  }
  return col;
}

export const LAYERS_FOR_DIFF = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];

function compareKeyOf(art) {
  return art?.defines || art?.id || '';
}

function renderComparePackSide(side, pack, sets) {
  const col = document.createElement('div');
  col.className = 'compare-side compare-side-' + side;

  const head = document.createElement('div');
  head.className = 'compare-side-head';
  const tier = pack?.meta?.criticality || '?';
  const env  = pack?.meta?.environment || '—';
  head.innerHTML = `
    <div class="compare-side-eyebrow">${side === 'a' ? 'PACK A' : 'PACK B'}</div>
    <div class="compare-side-name">${escapeHtml(pack?.name || '?')}</div>
    <div class="compare-side-meta">
      <span class="meta-pill" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span>
      <span class="meta-pill">env: ${escapeHtml(env)}</span>
      <span class="meta-pill">v${escapeHtml(pack?.meta?.version || '?')}</span>
    </div>
  `;
  col.appendChild(head);

  // Render each layer as a stacked section.
  for (const L of LAYERS_FOR_DIFF) {
    if (L === 'L4') {
      const L4 = pack?.layers?.L4 || { policy: [], alerting: [], healing: [] };
      const total = (L4.policy?.length || 0) + (L4.alerting?.length || 0) + (L4.healing?.length || 0);
      if (total === 0) continue;
      const sec = renderCompareSideLayer({ id: 'L4', num: 'L4', name: 'Action' }, [], side, sets, true);
      col.appendChild(sec);
      // Sub-groups
      const grid = sec.querySelector('.compare-side-grid');
      for (const sg of L4_SUBGROUPS) {
        const items = L4[sg.key] || [];
        if (!items.length) continue;
        const h = document.createElement('div');
        h.className = 'compare-side-subhead';
        h.textContent = `L4.${sg.key} · ${sg.label}`;
        grid.appendChild(h);
        for (const a of items) grid.appendChild(renderCompareCard(a, { id: 'L4' }, sg.key, side, sets));
      }
      continue;
    }
    const items = pack?.layers?.[L] || [];
    if (!items.length) continue;
    const def = { id: L, num: L, name: ({L1:'Contract',L2:'Telemetry',L2X:'Extended',L3:'Insight',L5:'Validation',GOV:'Governance'})[L] || L };
    const sec = renderCompareSideLayer(def, items, side, sets, false);
    col.appendChild(sec);
  }

  return col;
}

function renderCompareSideLayer(def, items, side, sets, isL4) {
  const sec = document.createElement('section');
  sec.className = 'compare-side-layer section';
  sec.dataset.layer = def.id;
  const head = document.createElement('div');
  head.className = 'compare-side-layer-head';
  head.innerHTML = `
    <span class="section-num">${def.num}</span>
    <span class="section-name">${escapeHtml(def.name)}</span>
    <span class="section-count">${isL4 ? '' : items.length}</span>
  `;
  sec.appendChild(head);
  const grid = document.createElement('div');
  grid.className = 'compare-side-grid';
  if (!isL4) for (const a of items) grid.appendChild(renderCompareCard(a, def, null, side, sets));
  sec.appendChild(grid);
  return sec;
}

function renderCompareCard(artefact, def, sublayerKey, side, sets) {
  const k = compareKeyOf(artefact);
  const inBoth   = sets.keysInBoth[def.id]?.has(k);
  const onlyA    = sets.keysOnlyInA?.[def.id]?.has(k);
  const onlyB    = sets.keysOnlyInB?.[def.id]?.has(k);
  const isOnlySide = side === 'a' ? onlyA : onlyB;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card compare-side-card';
  if (inBoth) btn.classList.add('is-both');
  if (isOnlySide) btn.classList.add('is-only', `is-only-${side}`);
  const ckey = cardKey(def.id, sublayerKey, artefact.id);
  btn.dataset.key = ckey;
  if ((side === 'a' && ckey === state.activeCardKeyA) ||
      (side === 'b' && ckey === state.activeCardKeyB)) {
    btn.classList.add('is-active');
  }

  // Comparison status pill — what this card means in the diff.
  let statusPill = '';
  if (inBoth) statusPill = '<span class="diff-chip chip-both">in both</span>';
  else if (onlyA) statusPill = `<span class="diff-chip chip-only-a">only in A</span>`;
  else if (onlyB) statusPill = `<span class="diff-chip chip-only-b">only in B</span>`;

  // Source pill — Declared/Verified/Missing (what the studio's
  // per-artefact taxonomy already says about this card's status in
  // its own pack, independent of the comparison).
  const src = artefact.source || 'Declared';
  const sourcePill = `<span class="source-chip" data-source="${escapeHtml(src)}">${escapeHtml(src)}</span>`;

  // Gating chip for backend cards
  let gatingChip = '';
  if (/^BAK-/.test(artefact.id) && artefact.spec?.version?.gating) {
    const g = artefact.spec.version.gating;
    gatingChip = `<span class="gating-chip" data-gating="${escapeHtml(g)}">${escapeHtml(g)}</span>`;
  }

  btn.innerHTML = `
    <div class="card-head">
      <span class="card-id">${escapeHtml(artefact.id)}</span>
      ${statusPill}
      ${gatingChip}
    </div>
    <div class="card-title">${escapeHtml(artefact.title || artefact.id)}</div>
    ${artefact.desc ? `<div class="card-desc">${escapeHtml(artefact.desc)}</div>` : ''}
    <div class="card-foot card-foot-compare">
      ${sourcePill}
      ${artefact.tool ? `<span class="tool">${escapeHtml(artefact.tool)}</span>` : ''}
    </div>
  `;
  btn.onclick = () => openDrawer(artefact, def, sublayerKey, side);
  return btn;
}

function renderCompareHead() {
  const a = state.diff?.a;
  const b = state.diff?.b;
  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <span class="section-num">CMP</span>
    <span class="section-name">${escapeHtml(a?.name || '?')} <em>vs</em> ${escapeHtml(b?.name || '?')}</span>
    <span class="section-count">${state.diff ? `union ${state.diff.summary.union}` : '—'}</span>
  `;
  return head;
}

export function renderComparePicker() {
  const wrap = document.createElement('div');
  wrap.className = 'compare-picker';
  wrap.innerHTML = `
    <label class="ctrl">
      <span class="ctrl-key">PACK B</span>
      <select id="compare-b-pack"></select>
    </label>
    <label class="ctrl">
      <span class="ctrl-key">ENV B</span>
      <select id="compare-b-env"></select>
    </label>
    <button class="ctrl-btn" id="compare-swap" type="button" title="Swap A and B">⇄ swap</button>
  `;

  const bSel = wrap.querySelector('#compare-b-pack');
  for (const p of state.catalog) {
    if (!p.ok) continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.label} · v${p.version || '?'}`;
    bSel.appendChild(opt);
  }
  bSel.value = state.compareBId;
  bSel.onchange = () => {
    state.compareBId = bSel.value;
    state.compareBEnv = defaultEnvFor(bSel.value);
    state.diff = null;
    refreshDiff();
  };

  const envSel = wrap.querySelector('#compare-b-env');
  const envs = state.catalog.find(p => p.id === state.compareBId)?.environments || [];
  if (!envs.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '— none —'; envSel.appendChild(opt);
    envSel.disabled = true;
  } else {
    for (const e of envs) {
      const opt = document.createElement('option');
      opt.value = e; opt.textContent = e; envSel.appendChild(opt);
    }
    envSel.value = state.compareBEnv || envs[0];
    envSel.onchange = () => { state.compareBEnv = envSel.value || null; state.diff = null; refreshDiff(); };
  }

  wrap.querySelector('#compare-swap').onclick = () => {
    if (!state.compareBId) return;
    const aId = state.selectedPackId;
    const aEnv = state.selectedEnv;
    state.selectedPackId = state.compareBId;
    state.selectedEnv = state.compareBEnv;
    state.compareBId = aId;
    state.compareBEnv = aEnv;
    state.diff = null;
    // Reload everything for the now-A pack.
    refresh();
    refreshDiff();
  };

  return wrap;
}

function renderCompareSummary() {
  const s = state.diff.summary;
  const wrap = document.createElement('div');
  wrap.className = 'compare-summary';
  wrap.innerHTML = `
    <div class="compare-cell c-a"><div class="c-key">only in A</div><div class="c-val">${s.onlyInA}</div></div>
    <div class="compare-cell c-both"><div class="c-key">in both</div><div class="c-val">${s.inBoth}</div></div>
    <div class="compare-cell c-b"><div class="c-key">only in B</div><div class="c-val">${s.onlyInB}</div></div>
    <div class="compare-cell c-union"><div class="c-key">union</div><div class="c-val">${s.union}</div></div>
    <div class="compare-cell c-jacc"><div class="c-key">jaccard</div><div class="c-val">${Math.round(s.jaccard * 100)}%</div></div>
  `;
  return wrap;
}

// (The 3-column "only-in-A / both / only-in-B" layer renderer was
// replaced by the side-by-side renderComparePackSide above. The diff
// summary cells at the top of the view still surface the set arithmetic.)
function renderCompareLayer_DEPRECATED(def, bucket) {
  const section = document.createElement('section');
  section.className = 'compare-layer';
  section.dataset.layer = def.id;
  section.innerHTML = `
    <div class="compare-layer-head">
      <span class="section-num">${def.id}</span>
      <span class="section-name">${def.name}</span>
      <span class="section-count">${bucket.onlyInA.length} / ${bucket.inBoth.length} / ${bucket.onlyInB.length}</span>
    </div>
  `;
  const grid = document.createElement('div');
  grid.className = 'compare-grid';

  grid.appendChild(renderCompareColumn('only in A', 'c-a',    bucket.onlyInA.map(x => x.artefact), def));
  grid.appendChild(renderCompareColumn('in both',   'c-both', bucket.inBoth.map(x => x.a), def, bucket.inBoth));
  grid.appendChild(renderCompareColumn('only in B', 'c-b',    bucket.onlyInB.map(x => x.artefact), def));

  section.appendChild(grid);
  return section;
}

function renderCompareColumn(label, cls, items, def, inBothPairs = null) {
  const col = document.createElement('div');
  col.className = 'compare-col ' + cls;
  col.innerHTML = `<div class="compare-col-head">${label} <span class="muted">${items.length}</span></div>`;
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'compare-empty';
    empty.textContent = '—';
    col.appendChild(empty);
    return col;
  }
  for (let i = 0; i < items.length; i++) {
    const artefact = items[i];
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'compare-row';
    const bPair = inBothPairs ? inBothPairs[i].b : null;
    const annotation = bPair && bPair.source && bPair.source !== artefact.source
      ? ` <span class="compare-tag">${escapeHtml(artefact.source)}/${escapeHtml(bPair.source)}</span>`
      : '';
    row.innerHTML = `
      <span class="compare-row-id">${escapeHtml(artefact.id || '')}</span>
      <span class="compare-row-title">${escapeHtml(artefact.title || '')}</span>${annotation}
    `;
    row.onclick = () => openDrawer(artefact, def, null);
    col.appendChild(row);
  }
  return col;
}
