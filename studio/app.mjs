// studio/app.mjs
//
// Studio v0.3 client. Phase 3b adds:
//   - Per-artefact-type drawer panels (SLI/SLO/backend/dashboard/chaos/...).
//   - Version-gating chips on backend cards.
//   - Cross-reference checker (red border + drawer "broken refs" list).
//   - Conformance tab (maturity rubric scoring per dimension).
//   - File-upload + drag-and-drop UI for POST /api/validate.
// Phase 7b adds the Compare tab (pack arithmetic).
// Phase 7c adds the Atlas tab (6 SVG metaphors).

import { render as renderAtlas, VARIANTS as ATLAS_VARIANTS, ATLAS_META } from './atlases.mjs';
import {
  LAYER_DEFS, L4_SUBGROUPS, RESOLUTION_STOPS, DOMAIN_DEFS,
  DISCO_SLAB_ACCENT, discoGradeLetter, discoGradeWord,
} from './constants.mjs';
import { state, $, $$, persistence } from './state.mjs';

// `state`, the `$`/`$$` DOM helpers and the persistence layer now live in
// studio/state.mjs (imported above).

// ---------- API ----------

async function api(path, opts = {}) {
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

async function loadCatalog() {
  const { packs } = await api('/api/packs');
  state.catalog = packs || [];
}

// ---------- focus (A | B) ----------
//
// Conformance / Compile / Schema render a single pack at a time. When
// both A and B are loaded the user can flip focus between them via the
// toggle in the view nav. effectiveFocus() falls back to 'a' if focus is
// 'b' but Pack B isn't loaded — defensive, since the toggle is hidden
// in that state anyway.
function effectiveFocus() {
  return (state.viewFocus === 'b' && state.packB) ? 'b' : 'a';
}
function focusedPackId()   { return effectiveFocus() === 'b' ? state.compareBId  : state.selectedPackId; }
function focusedEnv()      { return effectiveFocus() === 'b' ? state.compareBEnv : state.selectedEnv; }
function focusedPack()     { return effectiveFocus() === 'b' ? state.packB       : state.pack; }

function focusedConformance()     { return effectiveFocus() === 'b' ? state.conformanceB     : state.conformance; }
function setFocusedConformance(v) { if (effectiveFocus() === 'b') state.conformanceB = v; else state.conformance = v; }

function focusedCompileCatalog()     { return effectiveFocus() === 'b' ? state.compileCatalogB     : state.compileCatalog; }
function setFocusedCompileCatalog(v) { if (effectiveFocus() === 'b') state.compileCatalogB = v; else state.compileCatalog = v; }
function focusedCompileContent()     { return effectiveFocus() === 'b' ? state.compileContentB     : state.compileContent; }
function setFocusedCompileContent(v) { if (effectiveFocus() === 'b') state.compileContentB = v; else state.compileContent = v; }
function focusedCompileGroup()       { return effectiveFocus() === 'b' ? state.compileGroupB       : state.compileGroup; }
function setFocusedCompileGroup(v)   { if (effectiveFocus() === 'b') state.compileGroupB = v; else state.compileGroup = v; }
function focusedCompileFlavor()      { return effectiveFocus() === 'b' ? state.compileFlavorB      : state.compileFlavor; }
function setFocusedCompileFlavor(v)  { if (effectiveFocus() === 'b') state.compileFlavorB = v; else state.compileFlavor = v; }
function focusedCompileArtifact()    { return effectiveFocus() === 'b' ? state.compileArtifactB    : state.compileArtifact; }
function setFocusedCompileArtifact(v){ if (effectiveFocus() === 'b') state.compileArtifactB = v; else state.compileArtifact = v; }

function setViewFocus(focus) {
  if (state.viewFocus === focus) return;
  state.viewFocus = focus;
  // Cached content for the newly-focused side may be stale or missing —
  // dropping it forces a lazy-load on the next render.
  if (effectiveFocus() === 'b' && !state.compileCatalogB) state.compileContentB = null;
  renderTabs();
  renderMainView();
}

// Rehydrate state from the persistence key. Called once after the
// catalog + examples are loaded so we can validate pack IDs before
// trying to load them. Returns true if it took the studio out of home
// mode; the caller falls back to goHome() otherwise.
async function rehydrateFromPersistence() {
  const saved = persistence.read();
  if (!saved) return false;
  const allKnown = [...(state.catalog || []), ...(state._examplesCache || [])];
  const aMeta = allKnown.find(p => p.id === saved.selectedPackId);
  if (!aMeta) {
    // Pack A is gone — drop the whole snapshot. Half-restoring a session
    // (view/filter but no pack) would just confuse.
    persistence.clear();
    return false;
  }

  // Restore non-pack UI fields up-front so the first render shows them.
  if (typeof saved.view === 'string')          state.view = saved.view;
  // Migrate persisted state from prior nav layouts to the three-tab
  // model (Layers · Compare · Compile). Anything outside those three
  // routes to either Compare (if it implied a comparison view) or
  // Layers (everything else) so we never strand the user on a tab
  // that no longer has a nav entry.
  // Permitted views: the three workflow tabs + the Advanced deep tools.
  // Anything else (legacy 'benchmark', the removed 'compare-artefacts')
  // routes to the compliance report so we never strand the user.
  const PERMITTED_VIEWS = new Set(['layers', 'compare', 'compile', 'conformance', 'schema', 'otlp', 'traceability', 'atlas', 'references']);
  if (state.view && !PERMITTED_VIEWS.has(state.view)) {
    state.view = 'compare';
  }
  if (typeof saved.layerFilter === 'string')   state.layerFilter = saved.layerFilter;
  if (typeof saved.compareSlice === 'string')  state.compareSlice = saved.compareSlice;
  if (typeof saved.compareSearch === 'string') state.compareSearch = saved.compareSearch;
  if (typeof saved.compareLens === 'string')   state.compareLens = saved.compareLens;
  if (saved.viewFocus === 'a' || saved.viewFocus === 'b') state.viewFocus = saved.viewFocus;
  if (typeof saved.atlasVariant === 'string')  state.atlasVariant = saved.atlasVariant;
  if (typeof saved.arborView === 'string')     state.arborView = saved.arborView;
  if (typeof saved.compileGroup === 'string')  state.compileGroup = saved.compileGroup;
  if (typeof saved.compileFlavor === 'string') state.compileFlavor = saved.compileFlavor;
  if (typeof saved.compileArtifact === 'string') state.compileArtifact = saved.compileArtifact;
  if (typeof saved.compileGroupB === 'string')  state.compileGroupB = saved.compileGroupB;
  if (typeof saved.compileFlavorB === 'string') state.compileFlavorB = saved.compileFlavorB;
  if (typeof saved.compileArtifactB === 'string') state.compileArtifactB = saved.compileArtifactB;
  if (saved.tracePrefs && typeof saved.tracePrefs === 'object') {
    state.tracePrefs = {
      suppressed: Array.isArray(saved.tracePrefs.suppressed) ? saved.tracePrefs.suppressed : [],
      resolved:   Array.isArray(saved.tracePrefs.resolved)   ? saved.tracePrefs.resolved   : [],
    };
  }
  if (typeof saved.expandL2 === 'boolean') state.expandL2 = saved.expandL2;
  if (typeof saved.expandL3 === 'boolean') state.expandL3 = saved.expandL3;
  // Resolution knob — restore it, or derive from the legacy expand flags
  // for sessions saved before the knob existed (back-compat).
  if (typeof saved.resolution === 'number') {
    applyResolution(saved.resolution);
  } else if (typeof saved.expandL2 === 'boolean' || typeof saved.expandL3 === 'boolean') {
    applyResolution(state.expandL2 ? 2 : (state.expandL3 ? 1 : 0));
  }
  if (typeof saved.layersSearch === 'string') state.layersSearch = saved.layersSearch;
  if (typeof saved.layersDomain === 'string') state.layersDomain = saved.layersDomain;

  // Make sure the picker can label an archived example by pushing the
  // catalog-entry shape into state.catalog (same trick renderPackBSelect uses).
  if (!state.catalog.find(p => p.id === aMeta.id)) state.catalog.push(aMeta);
  enterAnalyzeMode(aMeta.id, saved.selectedEnv);

  // Pack B (optional) — only if both the ID still resolves AND we had
  // env-B persisted. We don't pre-fetch B's pack object; loadPackB does that.
  const bMeta = saved.compareBId ? allKnown.find(p => p.id === saved.compareBId) : null;
  if (bMeta) {
    if (!state.catalog.find(p => p.id === bMeta.id)) state.catalog.push(bMeta);
    state.compareBId  = bMeta.id;
    state.compareBEnv = saved.compareBEnv || defaultEnvFor(bMeta.id);
    loadPackB().then(() => {
      refreshDiff();
      applyModeChrome();
      renderPackBSelect();
      renderEnvBSelect();
      renderTabs();
      renderMainView();
    });
  }
  return true;
}

async function loadPack(id, env) {
  const q = env ? `?env=${encodeURIComponent(env)}` : '';
  const [pack, conformance] = await Promise.all([
    api(`/api/packs/${encodeURIComponent(id)}${q}`),
    api(`/api/packs/${encodeURIComponent(id)}/conformance${q}`),
  ]);
  state.pack = pack;
  state.conformance = conformance;
  state.uploadedSource = null;
  state.symbolTable = buildSymbolTable(pack);
}

async function validateUploaded(body, contentType, env) {
  const q = env ? `?env=${encodeURIComponent(env)}` : '';
  const r = await fetch(`/api/validate${q}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, Accept: 'application/json' },
    body,
  });
  return r.json();
}

// ---------- selectors ----------

function renderPackSelect() {
  const sel = $('#pack-select');
  sel.innerHTML = '';
  for (const p of state.catalog) {
    const opt = document.createElement('option');
    opt.value = p.id;
    // Uploaded packs lead with a folder glyph so the user can tell
    // them apart from file-backed catalog entries at a glance. Tier
    // is omitted from the option text — it already renders as a
    // separate badge on the picker chrome.
    const prefix = p.source === 'uploaded' ? '📂 ' : '';
    opt.textContent = p.ok
      ? `${prefix}${p.label} · v${p.version || '?'}`
      : `${p.label} (error)`;
    if (!p.ok) opt.disabled = true;
    sel.appendChild(opt);
  }
  sel.value = state.selectedPackId || (state.catalog.find(p => p.ok)?.id ?? '');
  sel.onchange = () => {
    state.selectedPackId = sel.value;
    state.selectedEnv = defaultEnvFor(state.selectedPackId);
    refresh();
  };
}

// Pack B picker — sits next to Pack A in the header. Empty by default
// (shows "— none —"). Picking a pack here loads Pack B in place; the
// view nav grows to include Compare + Atlas without leaving single mode.
// Sources of pack options: state.catalog (live + crawled + uploaded)
// PLUS the archived /api/examples list (fetched once, cached).
function renderPackBSelect() {
  const sel = $('#pack-b-select');
  if (!sel) return;
  // Merge catalog + cached examples, dedup by id, drop the active Pack A.
  // Catalogue reference packs are intentionally NOT offered here: comparing
  // a single product's reference pack against a whole service's posture is
  // an apples-to-oranges comparison. They live under Advanced → References.
  const cat = state.catalog || [];
  const ex  = state._examplesCache || [];
  const seen = new Set();
  const options = [];
  for (const p of [...cat, ...ex]) {
    if (!p?.id || !p.ok) continue;
    if (p.id === state.selectedPackId) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    options.push(p);
  }
  // Sort by label so the list is stable across re-renders.
  options.sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id));
  sel.innerHTML = '<option value="">— none —</option>'
    + options.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)} · v${escapeHtml(p.version || '?')}</option>`).join('');
  sel.value = state.compareBId || '';
  sel.onchange = () => {
    const newId = sel.value || null;
    if (newId === state.compareBId) return;
    state.compareBId = newId;
    state.compareBEnv = newId ? defaultEnvFor(newId) : null;
    state.packB = null; state.diff = null;
    // Reset B-side state slots (they belong to whatever pack was just removed).
    state.conformanceB = null;
    state.compileCatalogB = null;
    state.compileContentB = null;
    if (!newId) {
      // User cleared Pack B — back to single-pack focus.
      state.viewFocus = 'a';
      // Atlas works in single-pack mode (Strata / Periodic / Skyline /
      // Arbor), so it stays. Compare + Traceability are cross-pack only —
      // fall back to Layers.
      if (state.view === 'compare' || state.view === 'traceability') {
        state.view = 'layers';
      }
      if (state.view === 'atlas' && CROSS_PACK_VARIANTS.has(state.atlasVariant)) {
        state.atlasVariant = 'strata';
      }
      applyModeChrome();
      renderTabs();
      renderMainView();
      return;
    }
    // Push the chosen pack into state.catalog (if not already present)
    // so loadPackB() + the catalog-entry resolver have a label to read.
    if (!state.catalog.find(p => p.id === newId)) {
      const ex = (state._examplesCache || []).find(p => p.id === newId)
              || (state._referencesCache || []).find(p => p.id === newId);
      if (ex) state.catalog.push(ex);
    }
    // Lazy-load B then refresh tabs + view. Auto-switch to Compare —
    // picking Pack B IS the user's intent to compare; making them then
    // click Compare separately was the source of "I changed Pack B and
    // lost the comparison" confusion. Preserve any cross-pack view
    // they had already chosen (Atlas, Traceability) so we don't fight
    // the user when they switched away deliberately.
    const crossPackViews = new Set(['compare', 'atlas', 'traceability']);
    const wantedAutoSwitch = !crossPackViews.has(state.view);
    loadPackB().then(() => {
      refreshDiff();
      if (wantedAutoSwitch) state.view = 'compare';
      // applyModeChrome reads state.view — must run AFTER the
      // potential switch so the header pickers hide/show correctly.
      applyModeChrome();
      renderEnvBSelect();
      renderTabs();
      renderMainView();
    });
  };
  renderEnvBSelect();
}

function renderEnvBSelect() {
  const sel = $('#env-b-select');
  if (!sel) return;
  sel.innerHTML = '';
  const entry = state.catalog.find(p => p.id === state.compareBId);
  const envs = entry?.environments || [];
  if (!envs.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '— none —';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const e of envs) {
    const opt = document.createElement('option');
    opt.value = e; opt.textContent = e;
    sel.appendChild(opt);
  }
  sel.value = state.compareBEnv || envs[0];
  sel.onchange = () => {
    state.compareBEnv = sel.value || null;
    state.packB = null; state.diff = null;
    loadPackB().then(() => { refreshDiff(); renderTabs(); renderMainView(); });
  };
}

function renderEnvSelect() {
  const sel = $('#env-select');
  sel.innerHTML = '';
  const envs = state.pack?.meta?.environments?.length
    ? state.pack.meta.environments
    : (state.catalog.find(p => p.id === state.selectedPackId)?.environments || []);
  if (!envs.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '— none —';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const e of envs) {
    const opt = document.createElement('option');
    opt.value = e; opt.textContent = e;
    sel.appendChild(opt);
  }
  sel.value = state.selectedEnv ?? envs[0];
  sel.onchange = () => { state.selectedEnv = sel.value || null; refresh(); };
}

function defaultEnvFor(packId) {
  const entry = state.catalog.find(p => p.id === packId);
  return entry?.environments?.[0] || null;
}

// ---------- meta strip ----------

function renderMeta() {
  const m = state.pack?.meta || {};
  const setVal = (key, value) => {
    const el = document.querySelector(`[data-meta="${key}"]`);
    if (!el) return;
    el.textContent = value ?? '—';
  };
  setVal('apiVersion', m.apiVersion);
  setVal('kind', m.kind);
  setVal('binding', m.binding);
  setVal('version', m.version);
  setVal('criticality', m.criticality);
  setVal('target', m.target);
  setVal('owners', Array.isArray(m.owners) ? m.owners.join(', ') : '—');
  setVal('environments', Array.isArray(m.environments) ? m.environments.join(', ') : '—');
  const critEl = document.querySelector('[data-meta="criticality"]');
  if (critEl) critEl.dataset.tier = m.criticality || '';
}

// ---------- symbol table + cross-references ----------

function buildSymbolTable(pack) {
  const defined = new Set();
  const refsFrom = new Map();  // cardKey -> string[] of refs

  const walk = (artefact, layerId, sublayerKey) => {
    if (artefact.defines) defined.add(artefact.defines);
    if (Array.isArray(artefact.refs) && artefact.refs.length) {
      const key = cardKey(layerId, sublayerKey, artefact.id);
      refsFrom.set(key, artefact.refs);
    }
  };

  const layers = pack?.layers || {};
  for (const layerId of ['L1', 'L2', 'L2X', 'L3', 'L5', 'GOV']) {
    for (const a of layers[layerId] || []) walk(a, layerId);
  }
  for (const sg of L4_SUBGROUPS) {
    for (const a of layers.L4?.[sg.key] || []) walk(a, 'L4', sg.key);
  }

  // Classify each ref
  const broken = new Map();  // cardKey -> string[] of unresolved refs
  for (const [key, refs] of refsFrom) {
    const unresolved = [];
    for (const ref of refs) {
      if (!ref) continue;
      // External imports (ref:platform/..., ref:something/...) — treat as resolved.
      if (/^ref:[A-Za-z0-9_./-]+/.test(ref) && !defined.has(ref)) {
        // accept any ref:platform/... as external import
        if (/^ref:[A-Za-z0-9_-]+\//.test(ref)) continue;
      }
      // Alert references — there's no first-class alert symbol yet, accept all alert:*
      if (/^alert:[a-z]/.test(ref)) continue;
      // Internal symbol — must resolve
      if (defined.has(ref)) continue;
      // Bare `slos.<id>` / `slis.<id>` style
      if (/^(slis|slos)\.[a-z]/.test(ref) && defined.has(ref)) continue;
      unresolved.push(ref);
    }
    if (unresolved.length) broken.set(key, unresolved);
  }

  return { defined, refsFrom, broken };
}

// ---------- layer tabs ----------

function layerArtefactCount(layerId) {
  const layers = state.pack?.layers;
  if (!layers) return 0;
  if (layerId === 'L4') {
    return (layers.L4?.policy?.length || 0) + (layers.L4?.alerting?.length || 0) + (layers.L4?.healing?.length || 0);
  }
  return (layers[layerId] || []).length;
}

// ============================================================
// Two-level navigation
//
// LEVEL 1 (primary view selector, top nav strip):
//   Layers · Conformance · Compile · Atlas · Schema     (single mode)
//   Layers · Atlas · Schema                              (compare mode)
//
// LEVEL 2 (layer filter chip strip, only visible on Layers view):
//   All · L1 · L2 · L2X · L3 · L4 · L5 · GOV
//
// The previous design crammed everything in one row — layer tabs
// L1..GOV mixed with the primary views CONF / BLD / CMP / ATL — which
// meant filters fought primary navigation for screen space and the
// user couldn't tell which was which. User feedback was unambiguous:
// "filters are displayed mixed with the main Studio functions, that
// you can't even see."
// ============================================================

function renderTabs() {
  // Keep the OBSERVA chrome's active tab in sync on every re-render.
  paintObservaActiveTab();
  const tabs = $('#layer-tabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  // The three H2 journey tabs in the OBSERVA chrome (Discover · Diagnose ·
  // Remediate) are the SOLE primary nav. The old in-content view-nav row
  // (Layers · Compare · Compile) duplicated them and was the "mixing" that
  // broke the journey — it's gone. We keep only the A|B focus toggle (for
  // the single-pack Advanced views) and the layer filter chips.
  tabs.appendChild(renderFocusToggle());
  tabs.appendChild(renderLayerFilterChips());
}

// Focus toggle (A | B). Visible only when both packs are loaded AND the
// active view renders a single pack — conformance, compile, schema. The
// other views (layers/compare/atlas) already show both packs.
function renderFocusToggle() {
  const wrap = document.createElement('div');
  wrap.className = 'focus-toggle';
  const showToggle = !!state.packB && ['conformance', 'compile', 'schema'].includes(state.view);
  if (!showToggle) { wrap.hidden = true; return wrap; }
  const cur = effectiveFocus();

  const label = document.createElement('span');
  label.className = 'focus-toggle-key';
  label.textContent = 'FOCUS';
  wrap.appendChild(label);

  const mkBtn = (side, pack) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.side = side;
    b.className = 'focus-toggle-btn' + (cur === side ? ' is-active' : '');
    b.textContent = side.toUpperCase();
    b.title = `Focus PACK ${side.toUpperCase()} — ${pack?.id || ''}`;
    b.onclick = () => setViewFocus(side);
    return b;
  };
  wrap.appendChild(mkBtn('a', state.pack));
  wrap.appendChild(mkBtn('b', state.packB));
  return wrap;
}

function renderLayerFilterChips() {
  const wrap = document.createElement('div');
  wrap.className = 'layer-chips';
  // Only show layer filter chips on the Layers view.
  if (state.view !== 'layers' && state.view !== undefined && state.view !== null) {
    wrap.hidden = true;
    return wrap;
  }
  // 'All' first, then each layer in order.
  const filterOptions = [{ id: 'all', label: 'All', count: null }];
  for (const def of LAYER_DEFS) {
    const count = state.pack ? layerArtefactCount(def.id) : 0;
    if (def.id === 'L2X' && count === 0 && state.mode === 'single') continue;
    filterOptions.push({ id: def.id, label: def.id, name: def.name, count });
  }
  const active = state.layerFilter || 'all';
  for (const opt of filterOptions) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'layer-chip' + (opt.id === active ? ' is-active' : '');
    c.dataset.layer = opt.id;
    if (opt.name) c.title = `${opt.id} · ${opt.name}${opt.count != null ? ' · ' + opt.count + ' artefact' + (opt.count === 1 ? '' : 's') : ''}`;
    c.innerHTML = `
      ${opt.id === 'all' ? '' : `<span class="lc-num">${opt.id}</span>`}
      <span class="lc-label">${escapeHtml(opt.id === 'all' ? 'All' : (opt.name || opt.id))}</span>
      ${opt.count != null ? `<span class="lc-count">${opt.count}</span>` : ''}
    `;
    c.onclick = () => {
      state.layerFilter = opt.id;
      // Mirror to activeLayer for renderLayerView et al.
      state.activeLayer = opt.id === 'all' ? 'L1' : opt.id;
      state.activeCardKey = null;
      renderTabs();
      renderMainView();
    };
    wrap.appendChild(c);
  }
  return wrap;
}

// ---------- main view ----------

function renderMainView() {
  const view = $('#layer-view');
  view.innerHTML = '';
  // Persistence: every mutation chain ends here, so this is the single
  // hook for the debounced write. Cheap when suspended (boot phase).
  persistence.schedule();
  if (state.mode === 'home') { renderHomeView(); return; }
  if (!state.pack) {
    // In the workspace but no pack yet. Discover ("what do we have?") is
    // where you LOAD or GENERATE a pack — so its empty state IS the three
    // load options, never the marketing hero. Diagnose/Remediate need a
    // pack first, so they point the user back to Discover.
    if (state.view === 'layers') { renderDiscoverEmpty(view); return; }
    // References (Advanced) is a catalogue browser — it renders without a
    // pack loaded; the per-reference benchmark action then needs Pack A.
    if (state.view === 'references') { renderReferencesView(view); return; }
    renderNeedPackPrompt(view); return;
  }

  // Mode-free dispatch. 'compare' IS the Diagnose view — the
  // diagnostic-grade compliance report ("Can We Trust It?"). The old
  // artefact-id side-by-side diff is GONE; any stale 'compare-artefacts'
  // or 'benchmark' state routes to the compliance report.
  switch (state.view) {
    case 'benchmark':                                         // legacy alias
    case 'compare-artefacts':                                 // removed view → report
    case 'compare':            renderBenchmarkView(view); return;
    case 'traceability':       renderTraceabilityView(view); return;
    case 'atlas':              renderAtlasView(view); return;
    case 'conformance':        view.appendChild(renderConformanceView()); return;
    case 'compile':            renderCompileView(view); return;
    case 'schema':             renderSchemaView(view); return;
    case 'otlp':               renderOtlpView(view); return;
    case 'references':         renderReferencesView(view); return;
    case 'layers':
    default:
      // Discover ("What Do We Have?") IS the real layer inventory —
      // the actual artefact cards grouped by canonical layer. The
      // CT-scanner is the LANDING-PAGE hero, not the in-app view.
      renderLayersView(view);
      return;
  }
}

// ============================================================
// DISCOVER — the TOMOGRAM SCAN dashboard.
//
// Three-column mission-control layout:
//   LEFT   — pack overview (manifest identity) + pack catalog
//   CENTER — the scanner centerpiece (hero image, with CSS fallback),
//            scan status, slice readout, layer index, top issues,
//            scan provenance
//   RIGHT  — conformance score, maturity by dimension, reference
//            check, artefact sourcing legend
//
// Every panel is wired to real pack data — meta, conformance,
// symbol table, catalog. No fabricated trends or activity logs.
// (Display vocabulary — DISCO_SLAB_ACCENT, discoGradeLetter/Word — now
// lives in constants.mjs.)
// ============================================================

function renderDiscoverDashboard(view) {
  view.innerHTML = '';
  const pack = state.pack;
  const meta = pack?.meta || {};
  const conf = focusedConformance();
  const sym  = state.symbolTable || buildSymbolTable(pack);

  // ---- reference check (real, from symbol table) ----
  let refTotal = 0, refBroken = 0;
  const brokenLines = [];
  if (sym?.refsFrom) for (const refs of sym.refsFrom.values()) refTotal += refs.length;
  if (sym?.broken) for (const [key, refs] of sym.broken) {
    refBroken += refs.length;
    for (const r of refs) brokenLines.push({ from: key, ref: r });
  }
  const refResolved = Math.max(0, refTotal - refBroken);

  // ---- conformance summary (real) ----
  const scorePct = conf ? conf.scorePercent : 0;
  const grade = discoGradeLetter(scorePct);
  const gradeWord = discoGradeWord(scorePct);
  const mustP  = conf?.must   || { passed: 0, total: 0 };
  const shouldP = conf?.should || { passed: 0, total: 0 };

  // ---- maturity by dimension (real) ----
  // Dimension names come straight from the canonical LAYER_DEFS — the
  // spec layer model, never an invented one.
  const DIM_NAMES = Object.fromEntries(LAYER_DEFS.map(d => [d.id, d.name]));
  const dims = [];
  for (const d of ['L1','L2','L3','L4','L5','GOV']) {
    const s = conf?.byDimension?.[d];
    if (!s) continue;
    const weight = (s.mustTotal || 0) + 0.5 * (s.shouldTotal || 0);
    const got    = (s.mustPassed || 0) + 0.5 * (s.shouldPassed || 0);
    const pct = weight > 0 ? Math.round((got / weight) * 100) : null;
    dims.push({ key: d, name: `${d} ${DIM_NAMES[d] || ''}`.trim(), pct });
  }

  // ---- top issues (real: failing conformance clauses + broken refs) ----
  const issues = [];
  if (conf?.clauses) for (const cl of conf.clauses) {
    if (cl.applies && !cl.pass) {
      issues.push({
        sev: cl.severity === 'MUST' ? 'HIGH' : 'MEDIUM',
        type: cl.severity === 'MUST' ? 'missing' : 'advisory',
        ref: cl.id,
        detail: cl.description,
      });
    }
  }
  for (const b of brokenLines) {
    issues.push({ sev: 'HIGH', type: 'broken_ref', ref: b.from.split('::').pop() || b.from, detail: `${b.ref} not found` });
  }
  const sevRank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  issues.sort((a, b) => (sevRank[a.sev] ?? 9) - (sevRank[b.sev] ?? 9));

  // ---- provenance (real, from annotations) ----
  const ann = meta.annotations || pack?.metadata?.annotations || {};
  const provRows = [];
  const src = pack?.source || (ann['mcp.refreshedAt'] ? 'mcp' : 'file');
  provRows.push(['source', escapeHtml(String(src))]);
  if (ann['mcp.refreshedAt']) provRows.push(['refreshed', escapeHtml(ann['mcp.refreshedAt'])]);
  const pa = (ann['mcp.probesAttempted'] || '').split(',').filter(Boolean).length;
  const ps = (ann['mcp.probesSucceeded'] || '').split(',').filter(Boolean).length;
  if (pa) provRows.push(['probes', `${ps}/${pa} returned data`]);
  const tools = (ann['mcp.toolsCalled'] || '').split(',').filter(Boolean).length;
  if (tools) provRows.push(['mcp tools', `${tools} called`]);
  provRows.push(['validated', conf ? 'schema v1.2 · conformance scored' : 'schema v1.2']);

  // ---- catalog lists (real) ----
  const uploaded = (state.catalog || []).filter(p => p.ok && p.id !== undefined);
  const examples = (state._examplesCache || []).filter(p => p.ok);

  const catRow = (p, withTier) => `
    <button type="button" class="disco-cat-row${p.id === state.selectedPackId ? ' is-active' : ''}" data-pack-id="${escapeHtml(p.id)}" data-is-example="${withTier ? '1' : '0'}">
      <span class="disco-cat-dot" data-ok="${p.ok ? '1' : '0'}"></span>
      <span class="disco-cat-name">${escapeHtml(p.label || p.name || p.id)}</span>
      <span class="disco-cat-tag">${withTier ? escapeHtml(p.criticality || '') : ('v' + escapeHtml(p.version || '?'))}</span>
    </button>
  `;

  // ---- layer index (real artefact counts + ids) ----
  const layerIndex = LAYER_DEFS.map(def => {
    const count = layerArtefactCount(def.id);
    return { id: def.id, name: def.name, count };
  });

  view.innerHTML = `
    <div class="disco">
      <!-- LEFT -->
      <aside class="disco-left">
        <section class="disco-panel">
          <h2 class="disco-panel-title">Pack Overview</h2>
          <dl class="disco-meta">
            <dt>name</dt><dd class="disco-meta-strong">${escapeHtml(meta.name || pack?.id || '—')}</dd>
            <dt>version</dt><dd>${escapeHtml(meta.version || '—')}</dd>
            <dt>apiVersion</dt><dd>${escapeHtml(meta.apiVersion || '—')}</dd>
            <dt>kind</dt><dd>${escapeHtml(meta.kind || '—')}</dd>
            <dt>binding</dt><dd>${escapeHtml(meta.binding || '—')}</dd>
            <dt>target</dt><dd>${escapeHtml(meta.target || '—')}</dd>
            <dt>criticality</dt><dd><span class="disco-tier">${escapeHtml(meta.criticality || '—')}</span></dd>
            <dt>environments</dt><dd>${escapeHtml((meta.environments || []).join(' · ') || '—')}</dd>
            <dt>owners</dt><dd>${escapeHtml((meta.owners || []).join(' · ') || '—')}</dd>
          </dl>
        </section>

        <section class="disco-panel disco-catalog">
          <h2 class="disco-panel-title">Pack Catalog</h2>
          <input type="search" class="disco-cat-search" placeholder="Search packs…" aria-label="Search packs">
          ${uploaded.length ? `<div class="disco-cat-group">Uploaded &amp; drafted</div>${uploaded.map(p => catRow(p, false)).join('')}` : ''}
          ${examples.length ? `<div class="disco-cat-group">Examples (${examples.length})</div>${examples.map(p => catRow(p, true)).join('')}` : ''}
        </section>
      </aside>

      <!-- CENTER -->
      <main class="disco-center">
        <section class="disco-panel disco-scanner-panel">
          <div class="disco-scanner-head">
            <div>
              <div class="disco-scanner-title">TOMOGRAM SCAN</div>
              <div class="disco-scanner-sub">layered observability view</div>
            </div>
            <div class="disco-scan-status">
              <span class="disco-scan-status-key">SCAN</span>
              <span class="disco-scan-status-val">COMPLETE</span>
              <span class="disco-scan-status-slice">${layerIndex.reduce((n,l)=>n+l.count,0)} artefacts · ${layerIndex.filter(l=>l.count>0).length}/${layerIndex.length} layers</span>
            </div>
          </div>

          <div class="disco-scanner-stage">
            <img class="disco-scanner-img" src="/assets/tomogram-hero.png" alt="Observability tomogram scan"
                 onerror="this.classList.add('is-missing')">
            <div class="disco-scanner-fallback">
              ${LAYER_DEFS.filter(d => d.id !== 'L2X' || layerArtefactCount('L2X') > 0).map(d => {
                const cnt = layerArtefactCount(d.id);
                return `
                  <div class="disco-slab" style="--slab:${DISCO_SLAB_ACCENT[d.id] || '#64748b'}">
                    <span class="disco-slab-id">${escapeHtml(d.num)}</span>
                    <span class="disco-slab-label">${escapeHtml(d.name)}</span>
                    <span class="disco-slab-count">${cnt}</span>
                  </div>`;
              }).join('')}
            </div>
          </div>

          <div class="disco-slice">
            <span class="disco-slice-key">RESOLUTION</span>
            <span class="disco-slice-track"><span class="disco-slice-fill" style="width:21%"></span></span>
            <span class="disco-slice-val">deep slice · canonical v1.2</span>
          </div>
        </section>

        <div class="disco-center-row">
          <section class="disco-panel">
            <h2 class="disco-panel-title">Top Issues <span class="disco-panel-badge">${issues.length}</span></h2>
            ${issues.length ? `
              <table class="disco-issues">
                <thead><tr><th>sev</th><th>type</th><th>reference</th><th>detail</th></tr></thead>
                <tbody>
                  ${issues.slice(0, 8).map(i => `
                    <tr data-sev="${i.sev}">
                      <td class="di-sev">${i.sev}</td>
                      <td class="di-type">${escapeHtml(i.type)}</td>
                      <td class="di-ref">${escapeHtml(i.ref)}</td>
                      <td class="di-detail">${escapeHtml(i.detail)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
              ${issues.length > 8 ? `<div class="disco-issues-more">+${issues.length - 8} more — see Diagnose</div>` : ''}
            ` : `<div class="disco-empty">No issues found. Pack is clean against its declared tier.</div>`}
          </section>

          <section class="disco-panel">
            <h2 class="disco-panel-title">Scan Provenance</h2>
            <dl class="disco-meta">
              ${provRows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}
            </dl>
          </section>
        </div>
      </main>

      <!-- RIGHT -->
      <aside class="disco-right">
        <section class="disco-panel">
          <h2 class="disco-panel-title">Conformance Score</h2>
          <div class="disco-score">
            <div class="disco-score-grade" data-grade="${grade[0]}">
              <div class="disco-score-letter">${grade}</div>
              <div class="disco-score-num">${scorePct} / 100</div>
              <div class="disco-score-word">${gradeWord}</div>
            </div>
            <div class="disco-score-breakdown">
              <div class="disco-score-line"><span>MUST</span><strong>${mustP.passed}/${mustP.total}</strong><span class="disco-score-pct">${mustP.total ? Math.round(mustP.passed/mustP.total*100) : 0}%</span></div>
              <div class="disco-score-line"><span>SHOULD</span><strong>${shouldP.passed}/${shouldP.total}</strong><span class="disco-score-pct">${shouldP.total ? Math.round(shouldP.passed/shouldP.total*100) : 0}%</span></div>
            </div>
          </div>
        </section>

        ${dims.length ? `
        <section class="disco-panel">
          <h2 class="disco-panel-title">Maturity by Dimension</h2>
          <div class="disco-dims">
            ${dims.map(d => `
              <div class="disco-dim">
                <span class="disco-dim-name">${escapeHtml(d.name)}</span>
                <span class="disco-dim-bar"><span class="disco-dim-fill" data-band="${d.pct == null ? 'na' : d.pct >= 80 ? 'hi' : d.pct >= 60 ? 'mid' : 'lo'}" style="width:${d.pct == null ? 0 : d.pct}%"></span></span>
                <span class="disco-dim-pct">${d.pct == null ? 'n/a' : d.pct + '%'}</span>
              </div>`).join('')}
          </div>
        </section>` : ''}

        <section class="disco-panel">
          <h2 class="disco-panel-title">Reference Check</h2>
          <div class="disco-ref-stats">
            <div class="disco-ref-stat"><div class="disco-ref-num">${refTotal}</div><div class="disco-ref-key">total</div></div>
            <div class="disco-ref-stat is-ok"><div class="disco-ref-num">${refResolved}</div><div class="disco-ref-key">resolved</div></div>
            <div class="disco-ref-stat is-bad"><div class="disco-ref-num">${refBroken}</div><div class="disco-ref-key">broken</div></div>
          </div>
          ${brokenLines.length ? `
            <div class="disco-ref-broken-head">Broken references</div>
            <ul class="disco-ref-broken">
              ${brokenLines.slice(0, 5).map(b => `<li><span class="disco-ref-from">${escapeHtml((b.from.split('::').pop() || b.from))}</span> → <span class="disco-ref-to">${escapeHtml(b.ref)}</span></li>`).join('')}
            </ul>
            ${brokenLines.length > 5 ? `<div class="disco-issues-more">+${brokenLines.length - 5} more</div>` : ''}
          ` : `<div class="disco-empty">All references resolve.</div>`}
        </section>

        <section class="disco-panel">
          <h2 class="disco-panel-title">Artefact Sourcing</h2>
          <ul class="disco-legend">
            <li><span class="disco-legend-dot" data-src="declared"></span><span class="disco-legend-name">Declared</span><span class="disco-legend-desc">present in manifest</span></li>
            <li><span class="disco-legend-dot" data-src="verified"></span><span class="disco-legend-name">Verified</span><span class="disco-legend-desc">MCP attested</span></li>
            <li><span class="disco-legend-dot" data-src="missing"></span><span class="disco-legend-name">Missing</span><span class="disco-legend-desc">required, not present</span></li>
          </ul>
        </section>
      </aside>
    </div>
  `;

  // ---- wire catalog clicks → load as Pack A ----
  view.querySelectorAll('.disco-cat-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.packId;
      if (!id || id === state.selectedPackId) return;
      // Ensure the pack is in the catalog (examples live only in cache).
      if (!state.catalog.find(p => p.id === id)) {
        const ex = (state._examplesCache || []).find(p => p.id === id);
        if (ex) state.catalog.push(ex);
      }
      state.selectedPackId = id;
      state.selectedEnv = defaultEnvFor(id);
      refresh();
    });
  });

  // ---- catalog search filter ----
  const search = view.querySelector('.disco-cat-search');
  search?.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    view.querySelectorAll('.disco-cat-row').forEach(row => {
      const name = (row.querySelector('.disco-cat-name')?.textContent || '').toLowerCase();
      row.style.display = !q || name.includes(q) ? '' : 'none';
    });
  });
}

// Layers view — stacks every layer when filter='all', narrows to one
// otherwise. Replaces the old per-layer-tab navigation.
function renderLayersView(view) {
  // The Discover layers view is a toolbar (resolution knob + filters) over
  // a body of layer sections. Toolbar and body are separate containers so
  // typing in the search box re-renders only the sections — the input keeps
  // focus and the slider keeps its thumb position.
  const body = document.createElement('div');
  body.className = 'layers-body';
  const rerender = () => { persistence.schedule(); renderLayersBody(body); };
  view.appendChild(renderLayersToolbar(rerender));
  view.appendChild(body);
  renderLayersBody(body);
}

// Apply a resolution stop: set the knob position and derive the per-layer
// expand flags from it. Clamped so out-of-range persisted values are safe.
function applyResolution(idx) {
  const i = Math.max(0, Math.min(RESOLUTION_STOPS.length - 1, idx | 0));
  state.resolution = i;
  state.expandL2 = RESOLUTION_STOPS[i].expandL2;
  state.expandL3 = RESOLUTION_STOPS[i].expandL3;
}

// Domain classifier — maps an artefact (plus the layer it lives on) into one
// of the four DOMAIN_DEFS buckets. Layer is the strongest signal; tags refine
// it. Deterministic, with Application as the catch-all.
function artefactDomain(a, layerId) {
  const tags = (a.tags || []).map(t => String(t).toLowerCase());
  const has = (...t) => t.some(x => tags.includes(x));
  // User Experience — synthetic / canary / blackbox / RUM probes that stand
  // in for a real user. L5 Validation is the home layer for these.
  if (layerId === 'L5' || has('synthetic', 'canary', 'blackbox', 'probe', 'rum', 'e2e')) {
    return 'ux';
  }
  // Infrastructure — the telemetry plumbing & storage that physically carries
  // signal: backends, exporters, receivers, processors, scrape jobs, the
  // discovered metric inventory. L2 / L2X are the home layers.
  if (layerId === 'L2' || layerId === 'L2X' ||
      has('backend', 'exporter', 'receiver', 'processor', 'storage',
          'metric', 'collector', 'scrape')) {
    return 'infrastructure';
  }
  // Platform — cross-cutting operability: alerting, policy, recording rules,
  // pipelines, self-healing, governance. L4 Action & GOV are the home layers.
  if (layerId === 'L4' || layerId === 'GOV' ||
      has('alert', 'burn-rate', 'policy', 'recording', 'pipeline',
          'route', 'governance', 'healing')) {
    return 'platform';
  }
  // Application — the service's own contract & insight: SLIs, SLOs, dashboards,
  // panels. The catch-all (L1 / L3).
  return 'application';
}

// Every artefact across the loaded pack's layers, tagged with its layer id
// (L4 is grouped). Used to populate the DOMAIN filter and apply it.
function layerArtefactsWithLayer() {
  const out = [];
  const layers = state.pack?.layers || {};
  for (const def of LAYER_DEFS) {
    if (def.id === 'L4') {
      const l4 = layers.L4 || {};
      for (const sg of L4_SUBGROUPS) for (const a of (l4[sg.key] || [])) out.push({ a, layerId: 'L4' });
    } else {
      for (const a of (layers[def.id] || [])) out.push({ a, layerId: def.id });
    }
  }
  return out;
}

// Discover content filter predicate — DOMAIN dropdown + search box. layerId
// lets the domain classifier use the artefact's home layer.
function passesLayersFilter(a, layerId) {
  const dom = state.layersDomain || 'all';
  if (dom !== 'all' && artefactDomain(a, layerId) !== dom) return false;
  const q = (state.layersSearch || '').trim().toLowerCase();
  if (q) {
    const hay = [a.id, a.title, a.desc, a.tool, ...(a.tags || [])]
      .filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// Toolbar for the Discover layers view: resolution knob, DOMAIN filter
// (only when 2+ domains exist), and a search box. `rerender` rebuilds just
// the sections body so inputs keep focus.
function renderLayersToolbar(rerender) {
  const wrap = document.createElement('div');
  wrap.className = 'layers-toolbar';

  // --- Layer chips (All · L1 · L2 · … · GOV) ---
  // Primitive but indispensable on a 1500-artefact production pack: one
  // click jumps the whole view to a single layer. Clicking a chip mutates
  // state.layerFilter then re-renders the entire Discover view (renderTabs +
  // renderMainView) so the active chip + sections update together.
  wrap.appendChild(renderLayerFilterChips());

  // --- Controls row: resolution knob · DOMAIN · search ---
  const controls = document.createElement('div');
  controls.className = 'layers-controls';

  // Resolution knob
  const res = state.resolution ?? 0;
  const stop = RESOLUTION_STOPS[res] || RESOLUTION_STOPS[0];
  const knob = document.createElement('div');
  knob.className = 'res-knob';
  knob.innerHTML = `
    <span class="res-knob-key">RESOLUTION</span>
    <input type="range" class="res-knob-range" min="0" max="${RESOLUTION_STOPS.length - 1}"
           step="1" value="${res}" aria-label="Detail resolution">
    <span class="res-knob-cap"><strong class="res-knob-label">${escapeHtml(stop.label)}</strong> <span class="res-knob-hint">${escapeHtml(stop.hint)}</span></span>
  `;
  const range = knob.querySelector('.res-knob-range');
  const capLabel = knob.querySelector('.res-knob-label');
  const capHint = knob.querySelector('.res-knob-hint');
  // Live caption while dragging; commit (re-render sections) on release.
  range.addEventListener('input', () => {
    const s = RESOLUTION_STOPS[+range.value] || RESOLUTION_STOPS[0];
    capLabel.textContent = s.label;
    capHint.textContent = s.hint;
  });
  range.addEventListener('change', () => {
    applyResolution(+range.value);
    rerender();
  });
  controls.appendChild(knob);

  // DOMAIN filter — fixed four-bucket taxonomy. Count artefacts per domain
  // and only offer the dropdown when 2+ domains are actually present.
  const domCounts = new Map();
  for (const { a, layerId } of layerArtefactsWithLayer()) {
    const d = artefactDomain(a, layerId);
    domCounts.set(d, (domCounts.get(d) || 0) + 1);
  }
  const domOptions = DOMAIN_DEFS.filter(d => domCounts.has(d.id));
  if (domOptions.length >= 2) {
    // A previously-selected domain that no longer exists (pack switch) falls
    // back to 'all' so we never filter everything out invisibly.
    if (state.layersDomain !== 'all' && !domCounts.has(state.layersDomain)) {
      state.layersDomain = 'all';
    }
    const cur = state.layersDomain || 'all';
    const dwrap = document.createElement('label');
    dwrap.className = 'layers-domain';
    dwrap.innerHTML = `<span class="layers-filter-key">DOMAIN</span>`;
    const sel = document.createElement('select');
    sel.className = 'layers-domain-select';
    sel.innerHTML = `<option value="all">all</option>`
      + domOptions.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)} (${domCounts.get(d.id)})</option>`).join('');
    sel.value = cur;
    sel.onchange = () => { state.layersDomain = sel.value; rerender(); };
    dwrap.appendChild(sel);
    controls.appendChild(dwrap);
  }

  // Search
  const swrap = document.createElement('div');
  swrap.className = 'layers-search';
  const sin = document.createElement('input');
  sin.type = 'search';
  sin.className = 'layers-search-input';
  sin.placeholder = 'Search artefacts…';
  sin.setAttribute('aria-label', 'Search artefacts');
  sin.value = state.layersSearch || '';
  sin.addEventListener('input', () => { state.layersSearch = sin.value; rerender(); });
  swrap.appendChild(sin);
  controls.appendChild(swrap);

  wrap.appendChild(controls);
  return wrap;
}

function renderLayersBody(body) {
  body.innerHTML = '';
  const filter = state.layerFilter || 'all';
  const layersToShow = (filter === 'all')
    ? LAYER_DEFS
    : LAYER_DEFS.filter(d => d.id === filter);

  let rendered = 0;
  for (const def of layersToShow) {
    // Skip L2X if empty (it's optional per spec v1.2).
    if (def.id === 'L2X' && layerArtefactCount('L2X') === 0) continue;
    if (def.id === 'L4') {
      renderLayer4(body);
    } else {
      const items = state.pack.layers[def.id] || [];
      body.appendChild(renderSection(def, items));
    }
    rendered++;
  }
  if (rendered === 0) {
    body.innerHTML = '<div class="placeholder">No artefacts on this layer.</div>';
  }
}

function renderSection(def, items, opts = {}) {
  const section = document.createElement('section');
  section.className = 'section';
  section.dataset.layer = def.id;

  // Apply the Discover content filters (DOMAIN + search) first so counts
  // and expand logic operate on the filtered set.
  const filtered = items.filter(a => passesLayersFilter(a, def.id));
  const searching = !!(state.layersSearch || '').trim();

  // L2 and L3 carry "expand-level" artefacts (metric inventory, dashboard
  // panels) gated by the global resolution knob (state.expandL2/expandL3).
  // An active search overrides the knob so matches are never hidden.
  const expandableLayer = (def.id === 'L2' || def.id === 'L3');
  const expandKey = def.id === 'L2' ? 'expandL2' : (def.id === 'L3' ? 'expandL3' : null);
  const expandOn = expandKey ? !!state[expandKey] : false;
  const expandItems = filtered.filter(a => a.expand);
  const baseItems   = filtered.filter(a => !a.expand);
  const visible = (expandableLayer && !expandOn && !searching) ? baseItems : filtered;

  const head = document.createElement('div');
  head.className = 'section-head';
  const countLabel = expandableLayer && expandItems.length
    ? `${visible.length} of ${filtered.length} artefact${filtered.length === 1 ? '' : 's'}`
    : `${filtered.length} artefact${filtered.length === 1 ? '' : 's'}`;
  head.innerHTML = `
    <span class="section-num">${def.num}</span>
    <span class="section-name">${escapeHtml(opts.subtitle || def.name)}</span>
    <span class="section-count">${countLabel}</span>
  `;
  section.appendChild(head);

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = (searching || (state.layersDomain && state.layersDomain !== 'all'))
      ? 'no artefacts match the current filter'
      : (expandableLayer && expandItems.length
          ? 'collapsed — raise resolution to reveal'
          : 'no artefacts declared in this section');
    section.appendChild(empty);
    return section;
  }

  const grid = document.createElement('div');
  grid.className = 'section-grid';
  for (const a of visible) grid.appendChild(renderCard(a, def, opts.sublayerKey));
  section.appendChild(grid);
  return section;
}

function renderLayer4(view) {
  const head = document.createElement('div');
  head.className = 'section';
  head.dataset.layer = 'L4';
  // Count L4 after applying the Discover content filters so the header
  // matches the (filtered) subgroups below it.
  const l4Count = L4_SUBGROUPS.reduce(
    (n, sg) => n + (state.pack.layers.L4?.[sg.key] || []).filter(a => passesLayersFilter(a, 'L4')).length, 0);
  head.innerHTML = `
    <div class="section-head">
      <span class="section-num">L4</span>
      <span class="section-name">Action — policy · alerting · self-healing</span>
      <span class="section-count">${l4Count} artefact${l4Count === 1 ? '' : 's'}</span>
    </div>
  `;
  view.appendChild(head);

  for (const sg of L4_SUBGROUPS) {
    const items = (state.pack.layers.L4?.[sg.key] || []).filter(a => passesLayersFilter(a, 'L4'));
    const wrapper = document.createElement('div');
    wrapper.className = 'subgroup';
    const h = document.createElement('h4');
    h.className = 'subgroup-head';
    h.textContent = `L4.${sg.key} · ${sg.label}`;
    wrapper.appendChild(h);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = `no ${sg.label.toLowerCase()} declared`;
      wrapper.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'section-grid section-grid-l4';
      for (const a of items) grid.appendChild(renderCard(a, { id: 'L4' }, sg.key));
      wrapper.appendChild(grid);
    }
    view.appendChild(wrapper);
  }
}

function cardKey(layerId, sublayerKey, id) {
  return sublayerKey ? `${layerId}/${sublayerKey}/${id}` : `${layerId}/${id}`;
}

function renderCard(artefact, def, sublayerKey) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  const key = cardKey(def.id, sublayerKey, artefact.id);
  btn.dataset.key = key;
  if (state.activeCardKey === key) btn.classList.add('is-active');
  if (state.symbolTable?.broken?.has(key)) btn.classList.add('has-broken-refs');

  const tags = (artefact.tags || []).slice(0, 4).map(t =>
    `<span class="tag">${escapeHtml(t)}</span>`).join('');

  // Version-gating chip for backend artefacts.
  let gatingChip = '';
  if (/^BAK-/.test(artefact.id) && artefact.spec?.version?.gating) {
    const g = artefact.spec.version.gating;
    gatingChip = `<span class="gating-chip" data-gating="${escapeHtml(g)}" title="version: ${escapeHtml(artefact.spec.version.declared || '?')} · gating: ${escapeHtml(g)}">${escapeHtml(g)}</span>`;
  }

  const brokenIndicator = state.symbolTable?.broken?.has(key)
    ? `<span class="ref-indicator" title="${state.symbolTable.broken.get(key).length} unresolved reference(s)">⚠</span>`
    : '';

  // Benchmark CTA — when this backend's `product` matches a catalogue
  // reference pack (grafana, prometheus, kafka), surface a small action
  // that loads the reference as Pack B and applies the product lens.
  // This is the discovery affordance for the user journey: from any
  // backend card, one click → "how does my X compare to best practice?"
  let benchmarkCta = '';
  const backendProduct = artefact.spec?.product || artefact.product || null;
  const refMatch = backendProduct
    ? LENS_PRODUCTS.find(lp => lp.slug === backendProduct.toLowerCase())
    : null;
  if (refMatch && /^BAK-/.test(artefact.id)) {
    benchmarkCta = `<button type="button" class="benchmark-cta"
      data-product="${escapeHtml(refMatch.slug)}"
      data-ref-pack="${escapeHtml(refMatch.refPackId)}"
      title="Compare your ${escapeHtml(refMatch.label)} posture against the catalogue reference pack."
    >⛯ Benchmark vs ${escapeHtml(refMatch.label)} →</button>`;
  }

  btn.innerHTML = `
    <div class="card-head">
      <span class="card-id">${escapeHtml(artefact.id)}</span>
      ${brokenIndicator}
      ${gatingChip}
      <span class="card-source" data-source="${escapeHtml(artefact.source || 'Declared')}">${escapeHtml(artefact.source || 'Declared')}</span>
    </div>
    <div class="card-title">${escapeHtml(artefact.title || artefact.id)}</div>
    ${artefact.desc ? `<div class="card-desc">${escapeHtml(artefact.desc)}</div>` : ''}
    <div class="card-foot">
      ${artefact.tool ? `<span class="tool">${escapeHtml(artefact.tool)}</span>` : ''}
      ${tags}
      ${benchmarkCta}
    </div>
  `;
  btn.onclick = (ev) => {
    // The Benchmark CTA lives inside the card button. Intercept clicks
    // on it so the drawer doesn't open.
    const cta = ev.target.closest('.benchmark-cta');
    if (cta) {
      ev.preventDefault();
      ev.stopPropagation();
      runBenchmark(cta.dataset.product, cta.dataset.refPack);
      return;
    }
    openDrawer(artefact, def, sublayerKey);
  };
  return btn;
}

// Drive the benchmark action — load the reference pack as Pack B,
// apply the product lens, switch to Compare. Centralised so the
// Backend CTA and the (future) Benchmark view CTA both use it.
async function runBenchmark(product, refPackId) {
  if (!product || !refPackId) return;
  state.compareLens = product;
  try {
    // The Pack B picker handles fetch + render. We dispatch a change
    // event on it so the existing path (auto-load + render Compare)
    // runs as if the user had picked it.
    const bSel = document.querySelector('#pack-b-select');
    if (bSel) {
      bSel.value = refPackId;
      bSel.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // Fallback: drive state directly if the picker isn't mounted yet.
      state.compareBId = refPackId;
      state.view = 'compare';
      renderTabs(); renderMainView();
    }
    // Belt-and-suspenders: the picker's auto-switch lands on Compare,
    // but a Benchmark CTA should land on the Benchmark view. Override
    // explicitly here a tick later.
    setTimeout(() => {
      state.view = 'compare';
      renderTabs(); renderMainView();
    }, 700);
  } catch (e) {
    console.warn('[benchmark] failed:', e);
  }
}

// ---------- references view (Advanced) ----------
// Reference component analysis. The catalogue reference packs (Kafka,
// Prometheus, Grafana) live here, off the main workflow, under Advanced →
// References. Each card describes a best-practice pack and offers a
// one-click benchmark that loads it as Pack B and jumps to Diagnose →
// Compare. Renders even without Pack A so the catalogue is browsable; the
// benchmark action is gated on a loaded pack.
function renderReferencesView(view) {
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

// ---------- conformance view ----------

function renderConformanceView() {
  const wrap = document.createElement('section');
  wrap.className = 'section conformance-view';
  wrap.dataset.layer = 'CONF';
  wrap.dataset.focus = effectiveFocus();

  const c = focusedConformance();
  const pk = focusedPack();
  if (!c) {
    wrap.innerHTML = '<div class="placeholder">conformance report unavailable</div>';
    return wrap;
  }

  const head = document.createElement('div');
  head.className = 'section-head';
  const focusBadge = state.packB ? ` · pack ${effectiveFocus().toUpperCase()} (${escapeHtml(pk?.id || '')})` : '';
  head.innerHTML = `
    <span class="section-num">CONF</span>
    <span class="section-name">Maturity rubric · ${escapeHtml(c.declaredTier)}${focusBadge}</span>
    <span class="section-count">${c.scorePercent}% overall · ${c.mustPercent}% MUST</span>
  `;
  wrap.appendChild(head);

  const headline = document.createElement('div');
  headline.className = 'conf-headline ' + (c.conformant ? 'is-pass' : 'is-fail');
  headline.innerHTML = `
    <div class="conf-meta">
      <div class="conf-stat">
        <div class="conf-stat-key">Conformant</div>
        <div class="conf-stat-val">${c.conformant ? 'yes' : 'no'}</div>
      </div>
      <div class="conf-stat">
        <div class="conf-stat-key">MUST passed</div>
        <div class="conf-stat-val">${c.must.passed} / ${c.must.total}</div>
      </div>
      <div class="conf-stat">
        <div class="conf-stat-key">SHOULD passed</div>
        <div class="conf-stat-val">${c.should.passed} / ${c.should.total}</div>
      </div>
      <div class="conf-stat">
        <div class="conf-stat-key">Combined score</div>
        <div class="conf-stat-val">${c.scorePercent}%</div>
      </div>
    </div>
    <div class="conf-note">Scored against <a href="https://github.com/MoebiusX/otel-observability-pack/blob/main/docs/maturity-model.md" target="_blank" rel="noopener">maturity rubric</a>; MUST = 1, SHOULD = 0.5.</div>
  `;
  wrap.appendChild(headline);

  const dimGrid = document.createElement('div');
  dimGrid.className = 'conf-dim-grid';
  for (const dim of ['L1', 'L2', 'L3', 'L4', 'L5']) {
    const stats = c.byDimension[dim] || { applicable: 0, mustPassed: 0, mustTotal: 0, shouldPassed: 0, shouldTotal: 0 };
    const ok = stats.mustTotal === 0 || stats.mustPassed === stats.mustTotal;
    dimGrid.innerHTML += `
      <div class="conf-dim" data-layer="${dim}" data-pass="${ok}">
        <div class="conf-dim-key">${dim}</div>
        <div class="conf-dim-must">${stats.mustPassed}/${stats.mustTotal} MUST</div>
        <div class="conf-dim-should">${stats.shouldPassed}/${stats.shouldTotal} SHOULD</div>
      </div>
    `;
  }
  wrap.appendChild(dimGrid);

  const list = document.createElement('div');
  list.className = 'conf-clauses';
  for (const cl of c.clauses) {
    const row = document.createElement('div');
    row.className = 'conf-clause';
    row.dataset.dim = cl.dimension;
    row.dataset.applies = cl.applies;
    row.dataset.pass = cl.pass;
    row.dataset.sev = cl.severity;
    row.innerHTML = `
      <div class="conf-clause-icon">${cl.applies ? (cl.pass ? '✓' : '✗') : '·'}</div>
      <div class="conf-clause-body">
        <div class="conf-clause-id">${escapeHtml(cl.id)} <span class="conf-clause-sev">${escapeHtml(cl.severity)}</span> <span class="conf-clause-tier">applies ${escapeHtml(cl.minTier)}+</span> <span class="conf-clause-ref">${escapeHtml(cl.specRef)}</span></div>
        <div class="conf-clause-desc">${escapeHtml(cl.description)}</div>
      </div>
    `;
    list.appendChild(row);
  }
  wrap.appendChild(list);
  return wrap;
}

// ---------- COMPILE view ----------
//
// Pack -> real, ingestible platform artefacts. The pack is the contract;
// this is the program. Spec §9's reference-implementation table made real.

async function loadCompileTargets() {
  if (state.compileTargets) return state.compileTargets;
  try {
    const r = await api('/api/compile/targets');
    state.compileTargets = r.targets || [];
  } catch (_) {
    state.compileTargets = [];
  }
  return state.compileTargets;
}

async function loadDeployMatrix() {
  if (state.deployMatrix) return state.deployMatrix;
  try { state.deployMatrix = await api('/api/deploy/matrix'); }
  catch (_) { state.deployMatrix = { products: [], versions: {}, scopes: [], targets: {} }; }
  return state.deployMatrix;
}

function isDeployable(target) {
  return !!state.deployMatrix?.targets?.[target]?.deployable;
}
function targetScopable(target) {
  return !!state.deployMatrix?.targets?.[target]?.scopable;
}

async function loadCompileCatalog() {
  const packId = focusedPackId();
  const env = focusedEnv();
  // No pack id available — fall through to the error sentinel so
  // renderCompileView shows a message instead of looping. Uploaded /
  // crawled / drafted packs now register server-side and get a real id;
  // hitting this branch means something else went wrong (e.g. the user
  // is on home with no pack, or an upload failed validation).
  if (!packId) {
    setFocusedCompileCatalog({ error: 'No pack selected.', groups: [] });
    return focusedCompileCatalog();
  }
  const params = new URLSearchParams();
  if (env) params.set('env', env);
  try {
    const r = await fetch(`/api/packs/${encodeURIComponent(packId)}/compile-catalog?${params}`);
    if (!r.ok) {
      // CRITICAL: must NOT leave catalog null on failure. renderCompileView
      // re-fires loadCompileCatalog every time the catalog is null, so a
      // persistent 4xx/5xx (e.g. uploaded packs the server doesn't know
      // about under their __uploaded__ id) would loop a fetch-and-render
      // chain forever — that was the cause of the krystalinex-pack hang.
      // Store an error sentinel so the next render shows an explanation.
      let msg = `HTTP ${r.status}`;
      try {
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const j = await r.json();
          if (j?.error) msg = j.error;
        }
      } catch (_) {}
      setFocusedCompileCatalog({ error: msg, groups: [] });
      return focusedCompileCatalog();
    }
    const cat = await r.json();
    setFocusedCompileCatalog(cat);
    // Reconcile current selection with what's available (the pack may
    // have changed since last view).
    const groups = cat.groups || [];
    const g = groups.find(x => x.id === focusedCompileGroup()) || groups[0];
    if (!g) return cat;
    setFocusedCompileGroup(g.id);
    if (!g.flavors?.some(f => f.id === focusedCompileFlavor())) {
      setFocusedCompileFlavor(g.flavors?.[0]?.id || null);
    }
    if (!g.items?.some(it => it.id === focusedCompileArtifact())) {
      setFocusedCompileArtifact(g.items?.[0]?.id || 'all');
    }
  } catch (e) {
    // Network error / parse error — same loop-prevention as above.
    setFocusedCompileCatalog({ error: e.message || 'network error', groups: [] });
  }
  return focusedCompileCatalog();
}

// Map (group, flavor) → legacy deploy target id used by isDeployable() and the
// deploy panel. Until per-artifact deploy lands, deploys are still
// per-target (whole-file) so we resolve the active selection to the
// closest legacy target name.
function legacyDeployTargetFor(group) {
  if (group === 'rules')        return 'prometheus-rules';
  if (group === 'dashboards')   return 'grafana-dashboard';
  if (group === 'pipelines')    return 'otel-collector';
  if (group === 'alertmanager') return 'alertmanager';
  return null;
}

async function loadCompiled() {
  const packId = focusedPackId();
  const env = focusedEnv();
  if (!packId) { setFocusedCompileContent(null); return; }
  // Reset cached content so a switch between artifacts/flavors re-fetches.
  const params = new URLSearchParams();
  if (env) params.set('env', env);
  params.set('group', focusedCompileGroup());
  if (focusedCompileFlavor())   params.set('flavor', focusedCompileFlavor());
  if (focusedCompileArtifact()) params.set('artifact', focusedCompileArtifact());
  const url = `/api/packs/${encodeURIComponent(packId)}/compile-artifact?${params}`;
  try {
    const r = await fetch(url);
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      if (ct.includes('application/json')) {
        const j = await r.json().catch(() => null);
        if (j?.error) msg = j.error;
      }
      setFocusedCompileContent({ error: msg });
      return;
    }
    const text = await r.text();
    setFocusedCompileContent({
      filename: parseCdFilename(r.headers.get('content-disposition'))
        || `${packId}.${focusedCompileGroup()}.${focusedCompileArtifact()}`,
      contentType: ct.split(';')[0].trim(),
      text,
      source: r.headers.get('x-pack-source'),
      group: r.headers.get('x-compile-group'),
      flavor: r.headers.get('x-compile-flavor'),
      artifact: r.headers.get('x-compile-artifact'),
    });
  } catch (e) {
    setFocusedCompileContent({ error: e.message });
  }
}

function parseCdFilename(cd) {
  if (!cd) return null;
  const m = /filename="([^"]+)"/.exec(cd);
  return m ? m[1] : null;
}

// ============================================================
// Schema view — distinct from Conformance.
//
// Conformance answers "how MATURE is this pack?" against the maturity
// rubric (MUST/SHOULD per tier). The Schema view answers "how does
// this pack STAND UP against the v1.2 canonical schema?" — the
// structural question. Three sections:
//
//   1. Identity block — apiVersion / kind / metadata fields, the
//      canonical "what is this pack" header. Reads the same fields
//      a packlint would key on.
//   2. Validation status — pulled from the catalog (only validating
//      packs land in the catalog) plus a link to the schema source.
//   3. Canonical YAML — the manifest verbatim. Read-only, scrollable,
//      monospaced. The single source of truth for the pack.
//
// Caches the YAML per (pack-id, env) under state._schemaYaml so
// switching tabs back doesn't re-fetch.
// ============================================================
function renderSchemaView(host) {
  const pack    = focusedPack();
  const packId  = focusedPackId();
  const env     = focusedEnv() || pack?.meta?.environment;
  if (!pack) {
    host.innerHTML = '<div class="placeholder">No pack loaded.</div>';
    return;
  }

  const wrap = document.createElement('section');
  wrap.className = 'section schema-view';
  wrap.dataset.layer = 'SCHEMA';
  wrap.dataset.focus = effectiveFocus();
  host.appendChild(wrap);

  // ---------- header ----------
  const focusBadge = state.packB ? ` · pack ${effectiveFocus().toUpperCase()} (${escapeHtml(pack?.id || '')})` : '';
  const sectionHead = document.createElement('div');
  sectionHead.className = 'section-head';
  sectionHead.innerHTML = `
    <span class="section-num">SCHEMA</span>
    <span class="section-name">Canonical manifest · ObservabilityPack v1.2${focusBadge}</span>
    <span class="section-count">${escapeHtml(pack?.meta?.binding || 'unknown binding')}</span>
  `;
  wrap.appendChild(sectionHead);

  // ---------- identity block ----------
  const id = document.createElement('div');
  id.className = 'schema-identity';
  const m = pack.meta || {};
  const rows = [
    ['apiVersion',  m.apiVersion],
    ['kind',        m.kind],
    ['metadata.name', m.name || pack.id || pack.name],
    ['metadata.version', m.version],
    ['binding',      m.binding],
    ['criticality',  m.criticality],
    ['environment',  m.environment],
    ['target',       m.target],
    ['owners',       Array.isArray(m.owners) ? m.owners.join(', ') : m.owners],
  ];
  id.innerHTML = `
    <div class="schema-identity-head">Identity</div>
    <dl class="schema-identity-list">
      ${rows.map(([k, v]) => `
        <div class="schema-identity-row">
          <dt>${escapeHtml(k)}</dt>
          <dd>${v ? `<code>${escapeHtml(String(v))}</code>` : '<em>—</em>'}</dd>
        </div>
      `).join('')}
    </dl>
  `;
  wrap.appendChild(id);

  // ---------- validation block ----------
  // Catalog presence = pack passed canonical validation when it was
  // loaded. We surface that as a green pass; if it ever failed, the
  // pack wouldn't be in the picker. The link points at the schema
  // source so a curious engineer can read the rules themselves.
  const validation = document.createElement('div');
  validation.className = 'schema-validation';
  validation.innerHTML = `
    <div class="schema-validation-head">Validation</div>
    <div class="schema-validation-status is-pass">
      <span class="schema-validation-pip">✓</span>
      <span class="schema-validation-msg">
        Validates against the canonical
        <a href="https://github.com/MoebiusX/otel-observability-pack/blob/main/schema/observability-pack.schema.json" target="_blank" rel="noopener">ObservabilityPack v1.2 JSON Schema</a>.
        Packs that fail validation never appear in the catalog.
      </span>
    </div>
    <div class="schema-validation-meta">
      Schema source: <code>vendor/observability-pack-spec/v1.2/observability-pack.schema.json</code> ·
      <a href="https://github.com/MoebiusX/otel-observability-pack/blob/main/spec/ObservabilityPack-Spec.md" target="_blank" rel="noopener">Spec document</a>
    </div>
  `;
  wrap.appendChild(validation);

  // ---------- canonical YAML pane ----------
  const yamlBox = document.createElement('div');
  yamlBox.className = 'schema-yaml-box';
  yamlBox.innerHTML = `
    <div class="schema-yaml-head">
      <span class="schema-yaml-title">Canonical YAML</span>
      <span class="schema-yaml-meta" id="schema-yaml-meta">loading…</span>
      <button id="schema-yaml-copy" type="button" class="ctrl-btn schema-yaml-copy">copy</button>
      <a id="schema-yaml-download" class="ctrl-btn schema-yaml-download" download>download</a>
    </div>
    <pre class="schema-yaml-body" id="schema-yaml-body" role="region" aria-label="Canonical pack YAML">loading…</pre>
  `;
  wrap.appendChild(yamlBox);

  // Lazy-fetch the YAML.
  const cacheKey = `${packId}::${env || ''}`;
  state._schemaYaml = state._schemaYaml || {};
  const apply = (text) => {
    const body = $('#schema-yaml-body');
    const meta = $('#schema-yaml-meta');
    if (!body || !meta) return;
    body.textContent = text;
    const bytes = new Blob([text]).size;
    const lines = text.split('\n').length;
    meta.textContent = `${lines} lines · ${(bytes / 1024).toFixed(1)} KB`;
    const dl = $('#schema-yaml-download');
    if (dl) {
      const slug = (m.name || pack.id || 'pack').toString().replace(/[^a-z0-9-]+/gi, '-');
      dl.href = `data:application/x-yaml;charset=utf-8,${encodeURIComponent(text)}`;
      dl.setAttribute('download', `${slug}.pack.yaml`);
    }
    const copy = $('#schema-yaml-copy');
    if (copy) {
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(text); copy.textContent = 'copied'; setTimeout(() => copy.textContent = 'copy', 1200); }
        catch (_) { copy.textContent = 'select all'; setTimeout(() => copy.textContent = 'copy', 1200); }
      };
    }
  };

  if (state._schemaYaml[cacheKey]) {
    apply(state._schemaYaml[cacheKey]);
    return;
  }

  const envQ = env ? `?env=${encodeURIComponent(env)}&format=yaml` : '?format=yaml';
  fetch(`/api/packs/${encodeURIComponent(packId)}/canonical${envQ}`, {
    headers: { Accept: 'application/x-yaml' },
  }).then(async r => {
    const text = await r.text();
    if (!r.ok) throw new Error(`server ${r.status}: ${text.slice(0, 200)}`);
    state._schemaYaml[cacheKey] = text;
    apply(text);
  }).catch(e => {
    const body = $('#schema-yaml-body');
    const meta = $('#schema-yaml-meta');
    if (body) body.textContent = `# Failed to load canonical YAML: ${e.message}`;
    if (meta) meta.textContent = 'error';
  });
}

// ============================================================
// OTLP coverage view (spec §3) — answers the question every fintech
// auditor will ask: "what OTLP-shaped wire does this pack run on?"
//
//   ┌────────────────────────────────────────────────────────────┐
//   │ OTLP · WIRE PROTOCOL COVERAGE                              │
//   │ grafana-reference · tier-2 · prod                          │
//   ├────────────────────────────────────────────────────────────┤
//   │ Receiver                                                    │
//   │ ✓ otlp receiver declared (spec MUST)                       │
//   │ Protocols: ● gRPC ● HTTP                                    │
//   │ Endpoint:  0.0.0.0:4317                                     │
//   ├────────────────────────────────────────────────────────────┤
//   │ Per-signal coverage                                         │
//   │   Signal      Receiver (in)         Exporter (out)         │
//   │   traces      ● OTLP                ● OTLP → tempo:4317   │
//   │   metrics     ● OTLP                ○ prometheusremotewrite│
//   │   logs        ● OTLP                ○ loki native          │
//   │   profiles    ○ not configured      — (pyroscope native)   │
//   ├────────────────────────────────────────────────────────────┤
//   │ SDK contract                                                │
//   │ Semconv 1.27.0 · propagators: tracecontext, baggage        │
//   │ Languages: java, node · Sampling: parentbased 0.1          │
//   │ Resource: service.name, service.namespace, service.version │
//   ├────────────────────────────────────────────────────────────┤
//   │ Summary: 3 of 4 signals wired · 1 end-to-end OTLP          │
//   └────────────────────────────────────────────────────────────┘
//
// Reads from the canonical pack (fetched once, cached). The layered
// display shape doesn't carry pipelines/otel under stable paths.
// ============================================================
const OTLP_SIGNALS = ['traces', 'metrics', 'logs', 'profiles'];
const OTLP_EXPORTER_KINDS = new Set(['otlp', 'otlphttp', 'otlp-grpc', 'otlp-http']);

function renderOtlpView(host) {
  const pack    = focusedPack();
  const packId  = focusedPackId();
  const env     = focusedEnv() || pack?.meta?.environment;
  if (!pack) {
    host.innerHTML = '<div class="placeholder">No pack loaded.</div>';
    return;
  }

  const wrap = document.createElement('section');
  wrap.className = 'section otlp-view';
  wrap.dataset.layer = 'OTLP';
  wrap.dataset.focus = effectiveFocus();
  host.appendChild(wrap);

  const focusBadge = state.packB ? ` · pack ${effectiveFocus().toUpperCase()} (${escapeHtml(pack?.id || '')})` : '';
  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <span class="section-num">OTLP</span>
    <span class="section-name">Wire coverage · OpenTelemetry Protocol${focusBadge}</span>
    <span class="section-count">${escapeHtml(pack?.meta?.binding || 'unknown binding')}</span>
  `;
  wrap.appendChild(head);

  // Loading placeholder while the canonical lands.
  const body = document.createElement('div');
  body.className = 'otlp-body';
  body.innerHTML = '<div class="placeholder">loading canonical manifest…</div>';
  wrap.appendChild(body);

  const cacheKey = `${packId}::${env || ''}`;
  state._otlpCanonical = state._otlpCanonical || {};
  const apply = (canonical) => renderOtlpBody(body, canonical, pack);
  if (state._otlpCanonical[cacheKey]) { apply(state._otlpCanonical[cacheKey]); return; }
  const envQ = env ? `?env=${encodeURIComponent(env)}` : '';
  fetch(`/api/packs/${encodeURIComponent(packId)}/canonical${envQ}`, {
    headers: { Accept: 'application/json' },
  }).then(async r => {
    if (!r.ok) throw new Error(`server ${r.status}`);
    const c = await r.json();
    state._otlpCanonical[cacheKey] = c;
    apply(c);
  }).catch(e => {
    body.innerHTML = `<div class="placeholder">Failed to load canonical: ${escapeHtml(e.message)}</div>`;
  });
}

function renderOtlpBody(host, canonical, layered) {
  host.innerHTML = '';
  const spec = canonical?.spec || {};
  const pipelines = spec.pipelines || {};
  const otel = spec.otel || {};
  const sdk = otel.sdk || {};
  const ra  = otel.resource_attributes || {};

  // --- Receiver analysis ---
  const receivers = Array.isArray(pipelines.receivers) ? pipelines.receivers : [];
  const otlpReceiver = receivers.find(r => /^otlp(http)?$/i.test(r?.name || ''));
  const hasOtlpReceiver = !!otlpReceiver;
  const otherReceivers = receivers.filter(r => r !== otlpReceiver).map(r => r?.name).filter(Boolean);
  const protocols = Array.isArray(otlpReceiver?.protocols) ? otlpReceiver.protocols : [];
  const hasGrpc = protocols.some(p => /grpc/i.test(p));
  const hasHttp = protocols.some(p => /http/i.test(p));
  const endpoint = otlpReceiver?.endpoint || '—';

  // --- Per-signal coverage ---
  const exporters = pipelines.exporters || {};
  const signals = OTLP_SIGNALS.map(sig => {
    const exporter = exporters[sig];
    const exporterKind = exporter?.kind || (sig === 'profiles' ? null : null);
    const exporterEndpoint = exporter?.endpoint || null;
    const exporterIsOtlp = exporter ? OTLP_EXPORTER_KINDS.has(String(exporterKind).toLowerCase()) : false;

    // For profiles we look at spec.profiling — the spec doesn't put
    // profiles in pipelines.exporters today.
    let profilingNote = null;
    if (sig === 'profiles' && spec.profiling) {
      profilingNote = `${spec.profiling.product || 'profiling backend'} native`;
    }

    // OTLP receiver in spec carries every signal by default; we mark
    // "in" as ● when the receiver is present, ○ when it isn't.
    return {
      sig,
      receiverIn: hasOtlpReceiver,
      exporter,
      exporterKind: exporterKind || (profilingNote || null),
      exporterEndpoint,
      exporterIsOtlp,
      profilingNote,
    };
  });
  const endToEndOtlpCount = signals.filter(s => s.receiverIn && s.exporterIsOtlp).length;
  const wiredCount = signals.filter(s => s.exporter || s.profilingNote).length;

  // --- Render ---
  const sdLangs = Array.isArray(sdk.languages) ? sdk.languages.join(', ') : '—';
  const sdSampling = sdk.sampling
    ? `${sdk.sampling.policy || ''} ${sdk.sampling.ratio != null ? `(ratio ${sdk.sampling.ratio})` : ''}`.trim()
    : '—';
  const sdProps = Array.isArray(sdk.propagators) ? sdk.propagators.join(', ') : '—';
  const raReq  = Array.isArray(ra.required) ? ra.required.join(', ') : '—';
  const raCustom = Array.isArray(ra.custom) ? ra.custom.join(', ') : null;

  host.innerHTML = `
    <div class="otlp-block otlp-block-receiver">
      <div class="otlp-block-head">Receiver</div>
      <div class="otlp-receiver-status ${hasOtlpReceiver ? 'is-pass' : 'is-fail'}">
        <span class="otlp-pip">${hasOtlpReceiver ? '✓' : '✗'}</span>
        <span class="otlp-receiver-msg">
          ${hasOtlpReceiver
            ? `<strong>otlp</strong> receiver declared <em>(spec MUST)</em>`
            : `<strong>otlp receiver missing</strong> — spec MUST violation`}
        </span>
      </div>
      <div class="otlp-receiver-grid">
        <div class="otlp-receiver-row">
          <span class="otlp-receiver-key">Protocols</span>
          <span class="otlp-receiver-val">
            ${hasGrpc ? '<span class="otlp-proto-chip is-on">● gRPC</span>' : '<span class="otlp-proto-chip">○ gRPC</span>'}
            ${hasHttp ? '<span class="otlp-proto-chip is-on">● HTTP</span>' : '<span class="otlp-proto-chip">○ HTTP</span>'}
          </span>
        </div>
        <div class="otlp-receiver-row">
          <span class="otlp-receiver-key">Endpoint</span>
          <span class="otlp-receiver-val"><code>${escapeHtml(String(endpoint))}</code></span>
        </div>
        ${otherReceivers.length ? `
          <div class="otlp-receiver-row">
            <span class="otlp-receiver-key">Side-channel receivers</span>
            <span class="otlp-receiver-val">${otherReceivers.map(n => `<code>${escapeHtml(n)}</code>`).join(' · ')}</span>
          </div>` : ''}
      </div>
    </div>

    <div class="otlp-block otlp-block-matrix">
      <div class="otlp-block-head">Per-signal coverage</div>
      <table class="otlp-matrix">
        <thead>
          <tr>
            <th>Signal</th>
            <th>Receiver (in)</th>
            <th>Exporter (out)</th>
            <th>End-to-end OTLP</th>
          </tr>
        </thead>
        <tbody>
          ${signals.map(s => `
            <tr data-signal="${escapeHtml(s.sig)}">
              <td class="otlp-sig-name">${escapeHtml(s.sig)}</td>
              <td>${s.receiverIn ? '<span class="otlp-cell is-otlp">● OTLP</span>' : '<span class="otlp-cell is-off">○ not received</span>'}</td>
              <td>
                ${s.exporter
                  ? `<span class="otlp-cell ${s.exporterIsOtlp ? 'is-otlp' : 'is-native'}">${s.exporterIsOtlp ? '●' : '○'} ${escapeHtml(String(s.exporterKind))}</span>${s.exporterEndpoint ? ` <code class="otlp-endpoint">${escapeHtml(s.exporterEndpoint)}</code>` : ''}`
                  : s.profilingNote
                    ? `<span class="otlp-cell is-native">○ ${escapeHtml(s.profilingNote)}</span>`
                    : '<span class="otlp-cell is-off">— not declared</span>'}
              </td>
              <td>${s.receiverIn && s.exporterIsOtlp ? '<span class="otlp-e2e is-pass">✓</span>' : '<span class="otlp-e2e is-warn">○</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="otlp-matrix-legend">
        ● OTLP-shaped wire · ○ non-OTLP native or absent · — not declared in spec
      </div>
    </div>

    <div class="otlp-block otlp-block-sdk">
      <div class="otlp-block-head">SDK contract</div>
      <dl class="otlp-sdk-grid">
        <div><dt>Semantic conventions</dt><dd><code>${escapeHtml(otel.semconv || '—')}</code></dd></div>
        <div><dt>Propagators</dt><dd><code>${escapeHtml(sdProps)}</code></dd></div>
        <div><dt>Languages</dt><dd><code>${escapeHtml(sdLangs)}</code></dd></div>
        <div><dt>Sampling</dt><dd><code>${escapeHtml(sdSampling)}</code></dd></div>
        <div><dt>Log ↔ Trace correlation</dt><dd>${otel.log_correlation === true ? '✓' : otel.log_correlation === false ? '✗' : '—'}</dd></div>
        <div><dt>Resource attrs (required)</dt><dd><code>${escapeHtml(raReq)}</code></dd></div>
        ${raCustom ? `<div><dt>Resource attrs (custom)</dt><dd><code>${escapeHtml(raCustom)}</code></dd></div>` : ''}
      </dl>
    </div>

    <div class="otlp-block otlp-block-summary">
      <div class="otlp-summary-row">
        <div class="otlp-summary-key">Signals wired</div>
        <div class="otlp-summary-val">${wiredCount} of ${OTLP_SIGNALS.length}</div>
      </div>
      <div class="otlp-summary-row">
        <div class="otlp-summary-key">End-to-end OTLP</div>
        <div class="otlp-summary-val">${endToEndOtlpCount} of ${OTLP_SIGNALS.length}</div>
      </div>
      <div class="otlp-summary-row">
        <div class="otlp-summary-key">Receiver MUST</div>
        <div class="otlp-summary-val">${hasOtlpReceiver ? 'pass' : 'fail'}</div>
      </div>
      <div class="otlp-summary-note">
        Spec v1.2 §3 — every pack <strong>MUST</strong> declare an <code>otlp</code> receiver.
        The OTLP-out column is informational: many production stacks intentionally use
        native protocols downstream (Prometheus remote-write, Loki native, Tempo OTLP)
        for backend efficiency.
      </div>
    </div>
  `;
}

// ============================================================
// REMEDIATION PLAN — the set-operation band that leads Remediate.
//
// "Fix the gaps" starts by deciding WHAT to deploy. Four set
// operations over the two packs' artefacts:
//
//   A      — everything in your pack (the default with no Pack B)
//   B      — everything in the reference / target pack
//   A ∪ B  — union: your pack plus anything B adds
//   A − B  — the delta: artefacts in A but not B (the gap to close)
//
// A−B is the default when Pack B is loaded because it answers the
// remediation question directly: "what do I need to push that isn't
// already there?" The resolved set is shown per-layer with each item
// selectable; deployable artefacts (the Grafana surface — rules from
// SLOs, declared recording rules, dashboards) carry a checkbox and a
// "deploy" affordance, while everything else is flagged "author in
// pack" (you fix it by editing the manifest, not by pushing).
// ============================================================

// The active set operation, resolving the null default by Pack-B
// presence. B / ∪ / − require Pack B; without it we clamp to 'A'.
function effectiveRemediateOp() {
  const op = state.remediateOp || (state.packB ? 'A-B' : 'A');
  if (!state.packB && op !== 'A') return 'A';
  return op;
}

// Is this layered artefact part of the deployable Grafana surface, and
// if so what identity does the deploy manifest key it by? Mirrors
// tools/lib/compile.mjs::compileCatalog — only SLOs (recording +
// burn-rate alert rules), author-declared recording rules, and
// dashboards land through the Grafana deploy path. Returns
// { deployable, kind, identity } where identity matches the deploy
// manifest row.id (slo.id / rule name / dashboard id).
function remediationDeployIdentity(art) {
  const id = String(art?.id || '').toUpperCase();
  const defines = String(art?.defines || '');
  if (/^SLO-/.test(id) || defines.startsWith('slos.')) {
    return { deployable: true, kind: 'rules', identity: art.title || defines.replace(/^slos\./, '') };
  }
  if (/^QRY-/.test(id)) {
    return { deployable: true, kind: 'rules', identity: art.title || art.id };
  }
  if (/^DASH-/.test(id) || defines.startsWith('dashboards.')) {
    return { deployable: true, kind: 'dashboard', identity: defines.replace(/^dashboards\./, '') || art.title || art.id };
  }
  return { deployable: false, kind: null, identity: null };
}

// Resolve a set operation to a per-layer artefact list. Uses the
// server-computed diff (state.diff) for B / ∪ / − so the membership
// matches the Diagnose drill exactly; falls back to whole-pack walks
// when the diff isn't present (op 'A', or B-ops before the diff loads).
function resolveRemediationSet(op) {
  const haveB = !!state.packB;
  const diff = (state.diff && !state.diff.error && state.diff.layers) ? state.diff : null;
  const out = { byLayer: {}, total: 0, deployable: 0, author: 0, needsDiff: false };

  for (const L of LAYERS_FOR_DIFF) {
    let entries = [];
    if (op === 'A' || !haveB) {
      entries = layerItemsFor(state.pack, L).map(a => ({ art: a }));
    } else if (op === 'B') {
      entries = layerItemsFor(state.packB, L).map(a => ({ art: a }));
    } else if (op === 'A-B') {
      if (!diff) { out.needsDiff = true; entries = layerItemsFor(state.pack, L).map(a => ({ art: a })); }
      else entries = (diff.layers[L]?.onlyInA || []).map(e => ({ art: e.artefact }));
    } else if (op === 'AUB') {
      const aItems = layerItemsFor(state.pack, L).map(a => ({ art: a }));
      let bExtra;
      if (!diff) { out.needsDiff = true; bExtra = layerItemsFor(state.packB, L).map(a => ({ art: a })); }
      else bExtra = (diff.layers[L]?.onlyInB || []).map(e => ({ art: e.artefact }));
      entries = [...aItems, ...bExtra];
    }
    const enriched = entries
      .filter(e => e.art)
      .map(e => ({ ...e, ...remediationDeployIdentity(e.art) }));
    if (enriched.length) {
      out.byLayer[L] = enriched;
      out.total += enriched.length;
      out.deployable += enriched.filter(e => e.deployable).length;
      out.author += enriched.filter(e => !e.deployable).length;
    }
  }
  return out;
}

// Selected deployable identities = all deployable in the set minus the
// ones the user unchecked. Drives the deploy hand-off.
function remediationSelectedIdentities(resolved) {
  const deselected = state.remediateDeselected || new Set();
  const ids = new Set();
  for (const L of LAYERS_FOR_DIFF) {
    for (const e of (resolved.byLayer[L] || [])) {
      if (e.deployable && e.identity && !deselected.has(e.identity)) ids.add(e.identity);
    }
  }
  return ids;
}

const REMEDIATE_OPS = [
  { id: 'A',   label: 'A', sub: 'your pack',        needsB: false },
  { id: 'B',   label: 'B', sub: 'reference',        needsB: true  },
  { id: 'AUB', label: 'A ∪ B', sub: 'union',        needsB: true  },
  { id: 'A-B', label: 'A − B', sub: 'gap to close', needsB: true  },
];

const REMEDIATE_LAYER_NAMES = { L1:'Contract', L2:'Telemetry', L2X:'Extended', L3:'Insight', L4:'Action', L5:'Validation', GOV:'Governance' };

// The remediation plan band — leads the Remediate view. Appends to host.
function renderRemediationPlan(host) {
  const op = effectiveRemediateOp();
  const haveB = !!state.packB;

  const wrap = document.createElement('div');
  wrap.className = 'remediate-plan';

  // ---- Set-operation selector ----
  const bName = haveB
    ? (catalogEntryFor(state.compareBId)?.label || state.packB?.meta?.name || state.packB?.id || 'Pack B')
    : null;
  const opsHtml = REMEDIATE_OPS.map(o => {
    const disabled = o.needsB && !haveB;
    return `<button type="button" class="remediate-op${o.id === op ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}"
      data-op="${o.id}" ${disabled ? 'disabled title="Load a Pack B from the header to enable"' : ''}>
      <span class="remediate-op-label">${escapeHtml(o.label)}</span>
      <span class="remediate-op-sub">${escapeHtml(o.sub)}</span>
    </button>`;
  }).join('');

  wrap.innerHTML = `
    <div class="remediate-plan-head">
      <span class="remediate-plan-eyebrow">PLAN</span>
      What do we deploy?
      ${haveB ? `<span class="remediate-plan-vs">A = your pack · B = <strong>${escapeHtml(bName)}</strong></span>`
              : `<span class="remediate-plan-vs">Load a <strong>Pack B</strong> from the header to unlock B · A∪B · A−B</span>`}
    </div>
    <div class="remediate-ops">${opsHtml}</div>
  `;

  // Wire op buttons.
  wrap.querySelectorAll('.remediate-op:not(.is-disabled)').forEach(btn => {
    btn.onclick = () => {
      state.remediateOp = btn.dataset.op;
      state.remediateDeselected = new Set();   // reset curation on op change
      renderMainView();
    };
  });

  // ---- Resolve the set ----
  const resolved = resolveRemediationSet(op);

  // B-ops need the diff; load it lazily, then re-render.
  if (resolved.needsDiff && haveB && state.compareBId) {
    const loading = document.createElement('div');
    loading.className = 'remediate-loading';
    loading.textContent = 'Computing the set…';
    wrap.appendChild(loading);
    host.appendChild(wrap);
    loadDiff().then(() => renderMainView());
    return;
  }

  const selectedIds = remediationSelectedIdentities(resolved);

  // ---- Summary tiles ----
  const summary = document.createElement('div');
  summary.className = 'remediate-summary';
  const opMeaning = {
    'A':   'Every artefact in your pack.',
    'B':   `Every artefact in ${escapeHtml(bName || 'Pack B')}.`,
    'AUB': `Your pack combined with everything ${escapeHtml(bName || 'Pack B')} adds.`,
    'A-B': `Artefacts in your pack but not in ${escapeHtml(bName || 'Pack B')} — the delta to push.`,
  };
  summary.innerHTML = `
    <div class="remediate-summary-lede">${opMeaning[op] || ''}</div>
    <div class="remediate-tiles">
      <div class="remediate-tile is-total"><div class="remediate-tile-n">${resolved.total}</div><div class="remediate-tile-l">in set</div></div>
      <div class="remediate-tile is-deployable"><div class="remediate-tile-n">${selectedIds.size}</div><div class="remediate-tile-l">selected to deploy</div></div>
      <div class="remediate-tile is-author"><div class="remediate-tile-n">${resolved.author}</div><div class="remediate-tile-l">to author in pack</div></div>
    </div>
  `;
  wrap.appendChild(summary);

  if (resolved.total === 0) {
    const empty = document.createElement('div');
    empty.className = 'remediate-empty';
    empty.textContent = op === 'A-B'
      ? 'Nothing to close — your pack has no artefacts beyond Pack B.'
      : 'This set is empty.';
    wrap.appendChild(empty);
    host.appendChild(wrap);
    return;
  }

  // ---- Per-layer, per-item checklist ----
  const list = document.createElement('div');
  list.className = 'remediate-list';
  const deselected = state.remediateDeselected || (state.remediateDeselected = new Set());
  for (const L of LAYERS_FOR_DIFF) {
    const entries = resolved.byLayer[L];
    if (!entries || !entries.length) continue;
    const layerEl = document.createElement('div');
    layerEl.className = 'remediate-layer';
    const depCount = entries.filter(e => e.deployable).length;
    layerEl.innerHTML = `
      <div class="remediate-layer-head">
        <span class="remediate-layer-num">${L}</span>
        <span class="remediate-layer-name">${escapeHtml(REMEDIATE_LAYER_NAMES[L] || L)}</span>
        <span class="remediate-layer-count">${entries.length}${depCount ? ` · ${depCount} deployable` : ''}</span>
      </div>
    `;
    const ul = document.createElement('ul');
    ul.className = 'remediate-items';
    for (const e of entries) {
      const li = document.createElement('li');
      const checked = e.deployable && e.identity && !deselected.has(e.identity);
      li.className = 'remediate-item' + (e.deployable ? '' : ' is-author');
      const labelText = e.art.title || e.art.id || e.identity || '—';
      if (e.deployable) {
        li.innerHTML = `
          <label class="remediate-item-row">
            <input type="checkbox" ${checked ? 'checked' : ''}>
            <span class="remediate-item-name">${escapeHtml(labelText)}</span>
            <span class="remediate-item-tag is-deploy">${e.kind === 'dashboard' ? 'dashboard' : 'rules'}</span>
          </label>
        `;
        const cb = li.querySelector('input');
        cb.onchange = () => {
          if (cb.checked) deselected.delete(e.identity);
          else deselected.add(e.identity);
          renderMainView();
        };
      } else {
        li.innerHTML = `
          <div class="remediate-item-row">
            <span class="remediate-item-name">${escapeHtml(labelText)}</span>
            <span class="remediate-item-tag is-author">author in pack</span>
          </div>
        `;
      }
      ul.appendChild(li);
    }
    layerEl.appendChild(ul);
    list.appendChild(layerEl);
  }
  wrap.appendChild(list);

  // ---- Deploy action ----
  const action = document.createElement('div');
  action.className = 'remediate-action';
  const n = selectedIds.size;
  const deployPackId = (op === 'B') ? state.compareBId : state.selectedPackId;
  action.innerHTML = `
    <button type="button" class="remediate-deploy-btn" ${n === 0 ? 'disabled' : ''}>
      Deploy ${n} selected →
    </button>
    <span class="remediate-action-hint">${n === 0
      ? 'Select at least one deployable artefact, or author the rest in the pack.'
      : 'Opens the deploy form pre-selected to your choices. Non-deployable artefacts are fixed by editing the pack.'}</span>
  `;
  const btn = action.querySelector('.remediate-deploy-btn');
  if (btn && n > 0) {
    btn.onclick = () => openDeployModal({ packId: deployPackId, presetIdentities: selectedIds });
  }
  wrap.appendChild(action);

  host.appendChild(wrap);
}

function renderCompileView(host) {
  // The remediation PLAN leads the view — set-operation (A | B | A∪B |
  // A−B) → resolved set → per-item select → deploy. The per-artefact
  // compiler below is the drill-down: inspect/emit one artefact at a time.
  renderRemediationPlan(host);

  const section = document.createElement('section');
  section.className = 'section compile-view';
  section.dataset.layer = 'COMPILE';
  section.dataset.focus = effectiveFocus();

  const focusedPk = focusedPack();
  const head = document.createElement('div');
  head.className = 'section-head';
  const focusBadge = state.packB ? ` · pack ${effectiveFocus().toUpperCase()}` : '';
  head.innerHTML = `
    <span class="section-num">BLD</span>
    <span class="section-name">Compile — inspect &amp; emit one artefact${focusBadge}</span>
    <span class="section-count">${escapeHtml(focusedPk?.id || '')}</span>
  `;
  section.appendChild(head);

  const lede = document.createElement('div');
  lede.className = 'compile-lede';
  lede.innerHTML = `
    Drill into a single artifact and choose its target flavor. Each leaf compiles individually — one SLO's rules,
    one dashboard, or the full file. Every output declares its platform explicitly so you know whether you're
    holding a <em>Prometheus / Mimir</em> rules file or a <em>Grafana-managed</em> provisioning YAML.
  `;
  section.appendChild(lede);

  // ---- Grid: left nav (artifact tree) + right stage ----
  const grid = document.createElement('div');
  grid.className = 'compile-grid';
  section.appendChild(grid);
  host.appendChild(section);

  const nav = document.createElement('aside');
  nav.className = 'compile-nav';
  grid.appendChild(nav);
  const stage = document.createElement('div');
  stage.className = 'compile-stage';
  grid.appendChild(stage);

  // Fetch catalog if missing for the focused pack.
  if (!focusedCompileCatalog()) {
    nav.innerHTML = '<div class="compile-loading">Loading artifacts…</div>';
    stage.innerHTML = '<div class="placeholder">Loading the artifact catalog…</div>';
    loadCompileCatalog().then(() => { setFocusedCompileContent(null); renderMainView(); });
    return;
  }

  const catalog = focusedCompileCatalog();
  // Catalog-load error — show it, do NOT re-trigger the fetch. Without
  // this guard the renderCompileView → loadCompileCatalog → renderMainView
  // chain loops on persistent 4xx (e.g. uploaded packs the server has no
  // id for) and hangs the tab via fetch + localStorage thrash.
  if (catalog.error) {
    nav.innerHTML = '<div class="placeholder">No catalog available.</div>';
    stage.innerHTML = `<div class="error">Compile catalog failed: ${escapeHtml(catalog.error)}</div>`;
    return;
  }
  const groups = catalog.groups || [];
  if (!groups.length) {
    nav.innerHTML = '<div class="placeholder">This pack has nothing compilable yet — add SLOs, dashboards, or pipelines to the source.</div>';
    return;
  }

  // ---- Left nav: artifact tree ----
  for (const g of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'compile-group' + (g.id === focusedCompileGroup() ? ' is-active-group' : '');
    groupEl.innerHTML = `
      <div class="compile-group-head">
        <span class="compile-group-label">${escapeHtml(g.label)}</span>
        <span class="compile-group-count">${(g.items || []).length}</span>
      </div>
    `;
    const list = document.createElement('ul');
    list.className = 'compile-item-list';
    for (const it of (g.items || [])) {
      const li = document.createElement('li');
      const selected = (g.id === focusedCompileGroup()) && (it.id === focusedCompileArtifact());
      li.className = 'compile-item' + (selected ? ' is-active' : '');
      li.innerHTML = `
        <button type="button" class="compile-item-btn" title="${escapeHtml(it.subtitle || '')}">
          <span class="compile-item-bullet" aria-hidden="true">${selected ? '●' : '○'}</span>
          <span class="compile-item-body">
            <span class="compile-item-label">${escapeHtml(it.label)}</span>
            ${it.subtitle ? `<span class="compile-item-sub">${escapeHtml(it.subtitle)}</span>` : ''}
          </span>
        </button>
      `;
      li.querySelector('button').onclick = () => {
        setFocusedCompileGroup(g.id);
        setFocusedCompileArtifact(it.id);
        // Reconcile flavor with the chosen group.
        if (!g.flavors?.some(f => f.id === focusedCompileFlavor())) {
          setFocusedCompileFlavor(g.flavors?.[0]?.id || null);
        }
        setFocusedCompileContent(null);
        renderMainView();
      };
      list.appendChild(li);
    }
    groupEl.appendChild(list);
    nav.appendChild(groupEl);
  }

  // ---- Right stage: flavor pills + platform badge + compiled output ----
  const activeGroup = groups.find(g => g.id === focusedCompileGroup()) || groups[0];
  const activeFlavor = activeGroup?.flavors?.find(f => f.id === focusedCompileFlavor()) || activeGroup?.flavors?.[0];
  const activeItem = (activeGroup?.items || []).find(it => it.id === focusedCompileArtifact());

  // Platform callout — the explicit answer to "where does this land?"
  const callout = document.createElement('div');
  callout.className = 'compile-callout';
  callout.innerHTML = `
    <div class="compile-callout-head">
      <span class="compile-callout-label">TARGET PLATFORM</span>
      <span class="compile-callout-platform">${escapeHtml(activeFlavor?.platform || '—')}</span>
    </div>
    <div class="compile-callout-body">${escapeHtml(activeFlavor?.description || '')}</div>
  `;
  stage.appendChild(callout);

  // Flavor pills (if multiple)
  if ((activeGroup?.flavors || []).length > 1) {
    const flavorBar = document.createElement('div');
    flavorBar.className = 'compile-flavor-bar';
    flavorBar.innerHTML = `<span class="compile-flavor-key">FLAVOR</span>`;
    for (const f of activeGroup.flavors) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'compile-flavor-pill' + (f.id === focusedCompileFlavor() ? ' is-active' : '');
      b.innerHTML = `${escapeHtml(f.label)}`;
      b.title = `${f.platform} · ${f.description}`;
      b.onclick = () => {
        if (focusedCompileFlavor() === f.id) return;
        setFocusedCompileFlavor(f.id);
        setFocusedCompileContent(null);
        renderMainView();
      };
      flavorBar.appendChild(b);
    }
    stage.appendChild(flavorBar);
  }

  // Active artifact heading
  if (activeItem) {
    const head2 = document.createElement('div');
    head2.className = 'compile-artifact-head';
    head2.innerHTML = `
      <span class="compile-artifact-label">${escapeHtml(activeItem.label)}</span>
      ${activeItem.subtitle ? `<span class="compile-artifact-sub">${escapeHtml(activeItem.subtitle)}</span>` : ''}
    `;
    stage.appendChild(head2);
  }

  // Content
  if (!focusedCompileContent()) {
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.textContent = 'Compiling…';
    stage.appendChild(ph);
    loadCompiled().then(() => renderMainView());
    return;
  }
  if (focusedCompileContent().error) {
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = `Compile failed: ${focusedCompileContent().error}`;
    stage.appendChild(err);
    return;
  }
  const c = focusedCompileContent();
  // Map current selection to the legacy target name the deploy path expects.
  state.compileTarget = legacyDeployTargetFor(focusedCompileGroup()) || state.compileTarget;

  const envLabel = focusedEnv() || 'none';
  const actions = document.createElement('div');
  actions.className = 'compile-actions';
  actions.innerHTML = `
    <div class="compile-meta">
      <code>${escapeHtml(c.filename)}</code>
      <span class="muted">${escapeHtml(c.contentType)}</span>
      <span class="muted">${c.text.length.toLocaleString()} bytes</span>
      ${c.source ? `<span class="muted">from <code>${escapeHtml(c.source)}</code></span>` : ''}
    </div>
    <div class="compile-buttons">
      <button class="ctrl-btn" id="copy-compiled" type="button">copy</button>
      <a class="ctrl-btn ctrl-link" id="download-compiled" download="${escapeHtml(c.filename)}">download</a>
      ${isDeployable(state.compileTarget) ? `
        <button class="ctrl-btn ctrl-deploy" id="deploy-compiled" type="button" title="Push this artefact to the live platform via MCP write tools">
          deploy → <em>${escapeHtml(envLabel)}</em>
        </button>` : `
        <span class="ctrl-btn ctrl-deploy-disabled" title="${escapeHtml(state.deployMatrix?.targets?.[state.compileTarget]?.reason || 'No deploy path configured for this target')}">
          deploy ✕
        </span>`}
    </div>
  `;
  stage.appendChild(actions);

  // Inline deploy panel — collapsed by default; expands when the
  // user clicks deploy. Reuses the MCP URL the refresh panel already
  // persisted in localStorage so the engineer doesn't have to retype.
  const deployPanel = document.createElement('div');
  deployPanel.className = 'deploy-panel';
  deployPanel.hidden = true;
  if (isDeployable(state.compileTarget)) {
    deployPanel.innerHTML = renderDeployPanelMarkup(state.compileTarget);
  }
  stage.appendChild(deployPanel);

  const codeWrap = document.createElement('div');
  codeWrap.className = 'compile-code-wrap';
  const code = document.createElement('pre');
  code.className = 'compile-code ' + (c.contentType === 'application/json' ? 'lang-json' : 'lang-yaml');
  code.textContent = c.text;
  codeWrap.appendChild(code);
  stage.appendChild(codeWrap);

  actions.querySelector('#copy-compiled').onclick = async () => {
    try { await navigator.clipboard.writeText(c.text); toast('Copied to clipboard'); }
    catch (e) { toast('Copy failed: ' + e.message, 'error'); }
  };
  const dl = actions.querySelector('#download-compiled');
  const blob = new Blob([c.text], { type: c.contentType });
  dl.href = URL.createObjectURL(blob);

  const deployBtn = actions.querySelector('#deploy-compiled');
  if (deployBtn) deployBtn.onclick = () => openDeployModal({ packId: focusedPackId() });

  // Live re-derive the default tool name as the user changes product /
  // version / scope. We DON'T overwrite a user-typed override — only when
  // the input still matches the previous default do we refresh it.
  function rewireDefaults() {
    const toolInput = deployPanel.querySelector('#deploy-mcp-tool');
    if (!toolInput) return;
    const newDefault = computeDeployTool(state.compileTarget);
    if (toolInput.value === toolInput.dataset.lastDefault || !toolInput.value) {
      toolInput.value = newDefault;
    }
    toolInput.dataset.lastDefault = newDefault;
  }
  const prodSel = deployPanel.querySelector('#deploy-product');
  if (prodSel) prodSel.addEventListener('change', () => { state.deployProduct = prodSel.value; rewireDefaults(); });
  const verSel = deployPanel.querySelector('#deploy-version');
  if (verSel) verSel.addEventListener('change', () => { state.deployVersion = verSel.value; rewireDefaults(); });
  const scopeSel = deployPanel.querySelector('#deploy-scope');
  if (scopeSel) scopeSel.addEventListener('change', () => { state.deployScope = scopeSel.value; rewireDefaults(); });

  const goBtn2 = deployPanel.querySelector('#deploy-go-btn');
  if (goBtn2) goBtn2.onclick = () => doDeploy(deployPanel);
  const cancelBtn = deployPanel.querySelector('#deploy-cancel-btn');
  if (cancelBtn) cancelBtn.onclick = () => { deployPanel.hidden = true; };
}

// Mirror the server's defaultDeployTool function. Kept in sync with
// server/index.mjs::defaultDeployTool.
function computeDeployTool(target) {
  const product = state.deployProduct;
  const scope   = state.deployScope;
  if (product === 'grafana') {
    if (target === 'prometheus-rules') {
      if (scope === 'recording') return 'apply_grafana_recording_rules';
      if (scope === 'alerting')  return 'apply_grafana_alerting_rules';
      return 'apply_grafana_rules';
    }
    if (target === 'grafana-dashboard') return 'apply_grafana_dashboard';
  }
  return `apply_${String(target || '').replace(/-/g, '_')}`;
}

function renderDeployPanelMarkup(target) {
  const matrix = state.deployMatrix || { products: ['grafana'], versions: { grafana: ['12', '13'] }, scopes: ['both', 'recording', 'alerting'] };
  const products = matrix.products.length ? matrix.products : ['grafana'];
  const versions = matrix.versions[state.deployProduct] || matrix.versions[products[0]] || ['12', '13'];
  const scopes = matrix.scopes || ['both', 'recording', 'alerting'];
  const scopable = targetScopable(target);

  const scopeLabels = {
    both:      'both — recording + alerting rules',
    recording: 'recording rules only',
    alerting:  'alerting rules only',
  };

  return `
    <div class="deploy-panel-head">
      <div class="deploy-panel-title">Deploy via MCP write tool</div>
      <div class="deploy-panel-sub">Target a specific product + version. The pack stays the source of truth — re-deploy any time by re-emitting from the pack.</div>
    </div>
    <div class="deploy-panel-body">
      <div class="deploy-trio">
        <label class="mcp-field deploy-field">
          <span class="mcp-field-key">Target product</span>
          <select id="deploy-product">
            ${products.map(p => `<option value="${escapeHtml(p)}" ${p === state.deployProduct ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
          </select>
        </label>
        <label class="mcp-field deploy-field">
          <span class="mcp-field-key">Target version</span>
          <select id="deploy-version">
            ${versions.map(v => `<option value="${escapeHtml(v)}" ${v === state.deployVersion ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
          </select>
        </label>
        ${scopable ? `
          <label class="mcp-field deploy-field">
            <span class="mcp-field-key">Rules scope</span>
            <select id="deploy-scope">
              ${scopes.map(s => `<option value="${escapeHtml(s)}" ${s === state.deployScope ? 'selected' : ''}>${escapeHtml(scopeLabels[s] || s)}</option>`).join('')}
            </select>
          </label>` : ''}
      </div>
      <label class="mcp-field">
        <span class="mcp-field-key">MCP URL</span>
        <input id="deploy-mcp-url" type="url" placeholder="https://your-mcp.example.com/observability" autocomplete="off">
      </label>
      <label class="mcp-field">
        <span class="mcp-field-key">Tool name <em>(default per product · version · scope)</em></span>
        <input id="deploy-mcp-tool" type="text" placeholder="apply_*" autocomplete="off">
      </label>
      <label class="mcp-field">
        <span class="mcp-field-key">Auth token <em>(optional, not persisted)</em></span>
        <input id="deploy-mcp-auth" type="password" placeholder="bearer token" autocomplete="off">
      </label>
      <div class="deploy-panel-actions">
        <button id="deploy-go-btn" class="mcp-refresh-btn" type="button">deploy</button>
        <button id="deploy-cancel-btn" class="ctrl-btn" type="button">cancel</button>
        <span id="deploy-status" class="mcp-refresh-status"></span>
      </div>
      <div id="deploy-result" class="deploy-result" hidden></div>
    </div>
  `;
}

async function doDeploy(panel) {
  const url  = panel.querySelector('#deploy-mcp-url').value.trim();
  const tool = panel.querySelector('#deploy-mcp-tool').value.trim() || computeDeployTool(state.compileTarget);
  const auth = panel.querySelector('#deploy-mcp-auth').value;
  const product = panel.querySelector('#deploy-product')?.value || state.deployProduct;
  const version = panel.querySelector('#deploy-version')?.value || state.deployVersion;
  const scope   = panel.querySelector('#deploy-scope')?.value   || (targetScopable(state.compileTarget) ? state.deployScope : undefined);
  const statusEl = panel.querySelector('#deploy-status');
  const resultEl = panel.querySelector('#deploy-result');
  const setStatus = (msg, kind) => {
    statusEl.textContent = msg;
    statusEl.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
  };
  if (!url) { setStatus('mcp url required', 'error'); return; }
  try { localStorage.setItem('mcpUrl', url); } catch (_) {}

  const goBtn = panel.querySelector('#deploy-go-btn');
  goBtn.disabled = true;
  setStatus(`deploying to ${product} ${version}${scope && scope !== 'both' ? ' · ' + scope : ''}…`);
  resultEl.hidden = true;

  const qs = new URLSearchParams();
  const deployEnv = focusedEnv();
  if (deployEnv) qs.set('env', deployEnv);
  if (state.compileDashId) qs.set('dashboardId', state.compileDashId);
  const target = state.compileTarget;
  const path = `/api/packs/${encodeURIComponent(focusedPackId())}/deploy/${encodeURIComponent(target)}?${qs}`;

  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcpUrl: url,
        mcpAuth: auth || undefined,
        mcpTool: tool,
        targetProduct: product,
        targetVersion: version,
        scope,
      }),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    let body;
    if (!ct.includes('application/json')) {
      setStatus(`error: server returned ${r.status} ${ct || 'no content-type'}`, 'error');
      console.error('[deploy] non-JSON response:', raw.slice(0, 400));
      return;
    }
    try { body = JSON.parse(raw); }
    catch (e) { setStatus(`error: malformed JSON (${e.message})`, 'error'); return; }

    if (!body.ok) {
      setStatus(`error: ${body.error || 'unknown'}`, 'error');
      resultEl.textContent = JSON.stringify(body, null, 2);
      resultEl.hidden = false;
      return;
    }
    setStatus(`deployed in ${body.tookMs}ms via ${escapeHtml(body.tool)}`, 'ok');
    resultEl.textContent = JSON.stringify(body.result, null, 2);
    resultEl.hidden = false;
    toast(`Deployed ${body.filename} to ${body.env || 'mcp'}`);
  } catch (e) {
    setStatus(`error: ${e.message}`, 'error');
  } finally {
    goBtn.disabled = false;
  }
}

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

async function loadDiff() {
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

async function refreshDiff() {
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

function renderTraceabilityView(host) {
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

function renderBenchmarkView(view) {
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

  // Sample keys for a bucket, prettified (strip the family prefix).
  const sampleKeys = (entries, max = 4) => {
    const names = entries.slice(0, max).map(e => {
      const k = e.key || '';
      const short = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k;
      return escapeHtml(short || k);
    });
    const more = entries.length > max ? ` +${entries.length - max}` : '';
    return names.length ? names.join(' · ') + more : '—';
  };

  // Sample drifted pairs as `name(field,field)` so the reader sees not just
  // WHICH artefacts drifted but WHICH FIELDS diverged.
  const sampleDeltas = (entries, max = 3) => {
    const names = entries.slice(0, max).map(e => {
      const k = e.key || '';
      const short = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k;
      const fields = (e.deltas || []).map(d => d.field).slice(0, 3).join(',');
      return escapeHtml(short || k) + (fields ? `<span class="drift-delta-fields">(${escapeHtml(fields)})</span>` : '');
    });
    const more = entries.length > max ? ` +${entries.length - max}` : '';
    return names.length ? names.join(' · ') + more : '—';
  };

  const tile = (n, label, hint, cls) => `
    <div class="drift-tile ${cls}">
      <div class="drift-tile-n">${n}</div>
      <div class="drift-tile-label">${escapeHtml(label)}</div>
      <div class="drift-tile-hint">${escapeHtml(hint)}</div>
    </div>`;

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
    <div class="drift-tiles">
      ${tile(alignedPct + '%', 'Aligned', `${totAligned} matched · object shapes agree`, 'is-aligned')}
      ${tile(totDrifted, 'Drifted', 'same artefact · field values diverge', 'is-drifted')}
      ${tile(totA, frame.aLabel, frame.aHint, frame.aClass)}
      ${tile(totB, frame.bLabel, frame.bHint, frame.bClass)}
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
function catalogEntryFor(packId) {
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

function layerItemsFor(pack, L) {
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
const LENS_PRODUCTS = [
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

const LAYERS_FOR_DIFF = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];

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

function renderComparePicker() {
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

// ---------- atlas view ----------

async function loadPackB() {
  if (!state.compareBId) {
    state.packB = null;
    state.conformanceB = null;
    state.compileCatalogB = null;
    state.compileContentB = null;
    return;
  }
  const q = state.compareBEnv ? `?env=${encodeURIComponent(state.compareBEnv)}` : '';
  // Fetch pack + conformance in parallel so flipping focus to B is
  // instant (no extra network round-trip).
  const [pack, conformance] = await Promise.all([
    api(`/api/packs/${encodeURIComponent(state.compareBId)}${q}`),
    api(`/api/packs/${encodeURIComponent(state.compareBId)}/conformance${q}`).catch(() => null),
  ]);
  state.packB = pack;
  state.conformanceB = conformance;
  // Reset cached compile state for B so first-visit re-fetches.
  state.compileCatalogB = null;
  state.compileContentB = null;
}

// Variants that need both packs (animate / interchange between them).
// Everything else works on a single pack — Arbor especially is a
// dependency-discovery tool you don't need to compare to use.
const CROSS_PACK_VARIANTS = new Set(['constellation', 'transit']);

function renderAtlasView(view) {
  const hasB = !!state.packB;
  // If the user is on a cross-pack variant but Pack B isn't loaded,
  // fall back to a single-pack variant so the view stays usable.
  if (!hasB && CROSS_PACK_VARIANTS.has(state.atlasVariant)) {
    state.atlasVariant = 'strata';
  }

  const section = document.createElement('section');
  section.className = 'section atlas-view';
  section.dataset.layer = 'ATLAS';

  const meta = ATLAS_META[state.atlasVariant] || { title: state.atlasVariant, lede: '' };
  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <span class="section-num">ATL</span>
    <span class="section-name">${escapeHtml(meta.title)}${hasB ? '' : ' · single pack'}</span>
    <span class="section-count">${escapeHtml(state.atlasVariant)}</span>
  `;
  section.appendChild(head);

  const sub = document.createElement('div');
  sub.className = 'atlas-lede';
  sub.textContent = meta.lede;
  section.appendChild(sub);

  // Variant selector pills. Cross-pack variants are filtered out when
  // Pack B isn't loaded — the picker only shows what'll actually work.
  const pills = document.createElement('div');
  pills.className = 'atlas-variants';
  const availableVariants = hasB
    ? ATLAS_VARIANTS
    : ATLAS_VARIANTS.filter(v => !CROSS_PACK_VARIANTS.has(v));
  for (const v of availableVariants) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'atlas-variant' + (v === state.atlasVariant ? ' is-active' : '');
    b.textContent = v;
    b.onclick = () => {
      state.atlasVariant = v;
      renderTabs();
      renderMainView();
    };
    pills.appendChild(b);
  }
  section.appendChild(pills);

  // Pack-B + env-B + swap. Only useful in compare mode — skip in single.
  if (hasB) section.appendChild(renderComparePicker());

  // Stage for SVG
  const stage = document.createElement('div');
  stage.className = 'atlas-stage';
  section.appendChild(stage);

  // Constellation gets a morph slider
  if (state.atlasVariant === 'constellation') {
    const tools = document.createElement('div');
    tools.className = 'atlas-tools';
    tools.innerHTML = `
      <label class="atlas-morph">
        <span class="ctrl-key">A → B</span>
        <input type="range" min="0" max="100" value="${Math.round(state.atlasMorph * 100)}" id="atlas-morph">
      </label>
    `;
    section.appendChild(tools);
    setTimeout(() => {
      const r = section.querySelector('#atlas-morph');
      if (!r) return;
      r.oninput = () => {
        state.atlasMorph = Number(r.value) / 100;
        renderAtlas(state.atlasVariant, stage, datasetFor(), { morph: state.atlasMorph });
      };
    }, 0);
  }

  view.appendChild(section);

  // Render — fetch packB lazily if missing
  const atlasOpts = {
    morph: state.atlasMorph,
    arborView: state.arborView || 'A',
    onArborViewChange: (v) => { state.arborView = v; renderMainView(); },
    onArtefactClick: (artefact, layerId) => openDrawer(artefact, { id: layerId }, null),
  };
  const dataset = datasetFor();
  if (!dataset.b) {
    stage.innerHTML = '<div class="placeholder">Loading pack B…</div>';
    Promise.all([
      state.packB ? Promise.resolve() : loadPackB(),
      state.diff  ? Promise.resolve() : loadDiff(),
    ]).then(() => {
      renderAtlas(state.atlasVariant, stage, datasetFor(), atlasOpts);
    });
  } else {
    renderAtlas(state.atlasVariant, stage, dataset, atlasOpts);
  }
}

function datasetFor() {
  return { a: state.pack, b: state.packB, diff: state.diff };
}

// ---------- drawer ----------

// Map: side → element ids. drawerB (right) is the legacy drawer used
// everywhere outside the compare view. drawerA (left) is only used in
// the compare view to surface Pack A's artefact alongside Pack B's.
const DRAWER_ELS = {
  a: { drawer: '#drawer-a', eyebrow: '#drawer-a-eyebrow', title: '#drawer-a-title',
       meta: '#drawer-a-meta', panels: '#drawer-a-panels', close: '#drawer-a-close' },
  b: { drawer: '#drawer',   eyebrow: '#drawer-eyebrow',   title: '#drawer-title',
       meta: '#drawer-meta', panels: '#drawer-panels',   close: '#drawer-close' },
};

function openDrawer(artefact, def, sublayerKey, side = 'b') {
  const els = DRAWER_ELS[side];
  if (!els) return;
  const drawer = $(els.drawer);
  drawer.setAttribute('aria-hidden', 'false');
  drawer.dataset.layer = def.id;
  // Don't lock body scroll in compare view — both sides can scroll while
  // the user reads from both drawers. We only no-scroll for single-side
  // detail panels.
  if (state.activeLayer !== 'COMPARE') document.body.classList.add('no-scroll');

  const ckey = cardKey(def.id, sublayerKey, artefact.id);
  if (side === 'a') state.activeCardKeyA = ckey;
  else if (side === 'b' && state.activeLayer === 'COMPARE') state.activeCardKeyB = ckey;
  else state.activeCardKey = ckey;
  $$('.card').forEach(c => {
    const k = c.dataset.key;
    c.classList.toggle('is-active',
      k === state.activeCardKey || k === state.activeCardKeyA || k === state.activeCardKeyB);
  });

  $(els.eyebrow).textContent = `${def.num}${sublayerKey ? `.${sublayerKey}` : ''} · ${artefact.id}`;
  $(els.title).textContent   = artefact.title || artefact.id;

  // Meta strip (always shown)
  const meta = $(els.meta);
  meta.innerHTML = '';
  const rows = [];
  if (artefact.tool)         rows.push(['tool', artefact.tool]);
  if (artefact.tags?.length) rows.push(['tags', artefact.tags.join(', ')]);
  if (artefact.source)       rows.push(['source', artefact.source]);
  if (artefact.defines)      rows.push(['defines', artefact.defines]);
  if (artefact.refs?.length) rows.push(['refs', renderRefList(artefact.refs)]);
  if (artefact.desc)         rows.push(['summary', artefact.desc]);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    if (typeof v === 'string') dd.textContent = v;
    else dd.appendChild(v);
    meta.appendChild(dt); meta.appendChild(dd);
  }

  // Broken refs warning (if any) — only meaningful for the right (B)
  // drawer in single-pack views; in compare we check both packs.
  const panels = $(els.panels);
  panels.innerHTML = '';
  const broken = state.symbolTable?.broken?.get(ckey);
  if (broken && broken.length) {
    const sec = panel('Broken references', 'broken-refs');
    sec.innerHTML += '<div class="broken-list">' +
      broken.map(r => `<code>${escapeHtml(r)}</code>`).join('') +
      '</div>';
    panels.appendChild(sec);
  }

  // Per-artefact-type structured panels.
  const typed = renderTypedPanels(artefact, def);
  if (typed) panels.appendChild(typed);

  // Always-show canonical source
  const src = panel('Canonical source', 'canonical-source');
  const pre = document.createElement('pre');
  pre.className = 'json';
  pre.textContent = JSON.stringify(artefact.spec ?? artefact, null, 2);
  src.appendChild(pre);
  panels.appendChild(src);
}

function panel(title, className = '') {
  const sec = document.createElement('section');
  sec.className = 'drawer-section ' + className;
  sec.innerHTML = `<h3>${escapeHtml(title)}</h3>`;
  return sec;
}

function renderRefList(refs) {
  const span = document.createElement('span');
  refs.forEach((r, i) => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'ref-link';
    a.textContent = r;
    a.dataset.ref = r;
    if (state.symbolTable && !isRefResolved(r)) a.classList.add('is-broken');
    a.onclick = (e) => { e.preventDefault(); jumpToRef(r); };
    span.appendChild(a);
    if (i < refs.length - 1) span.appendChild(document.createTextNode(', '));
  });
  return span;
}

function isRefResolved(ref) {
  if (!ref) return true;
  if (/^alert:/.test(ref)) return true;             // alerts are external
  if (/^ref:[A-Za-z0-9_-]+\//.test(ref) && !state.symbolTable.defined.has(ref)) return true;  // external import
  return state.symbolTable.defined.has(ref);
}

function jumpToRef(symbol) {
  // Find any artefact whose `defines` matches `symbol`, switch to its layer, open its drawer.
  if (!state.pack) return;
  const layers = state.pack.layers;
  const findIn = (items, layerId, sublayerKey) => {
    for (const a of items || []) {
      if (a.defines === symbol) return { a, layerId, sublayerKey };
    }
    return null;
  };
  let hit = null;
  for (const layerId of ['L1', 'L2', 'L2X', 'L3', 'L5', 'GOV']) {
    hit = findIn(layers[layerId], layerId);
    if (hit) break;
  }
  if (!hit) {
    for (const sg of L4_SUBGROUPS) {
      hit = findIn(layers.L4?.[sg.key], 'L4', sg.key);
      if (hit) break;
    }
  }
  if (!hit) { toast(`no artefact defines ${symbol}`, 'error'); return; }
  state.activeLayer = hit.layerId;
  renderTabs();
  renderMainView();
  openDrawer(hit.a, { id: hit.layerId }, hit.sublayerKey);
  // Scroll the now-active card into view if visible
  requestAnimationFrame(() => {
    const card = document.querySelector(`.card.is-active`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

// ---------- per-artefact-type drawer panels ----------

function renderTypedPanels(artefact, def) {
  const id = artefact.id || '';
  const s = artefact.spec || {};
  if (id.startsWith('SLI-'))     return panelSLI(s);
  if (id.startsWith('SLO-'))     return panelSLO(s);
  if (id.startsWith('OTEL-'))    return panelOtel(s);
  if (id.startsWith('BAK-'))     return panelBackend(s);
  if (id.startsWith('STO-'))     return panelStorage(s);
  if (id.startsWith('PIP-'))     return panelPipeline(id, s);
  if (id.startsWith('DASH-'))    return panelDashboard(s);
  if (id.startsWith('QRY-'))     return panelRecordingRule(s);
  if (id.startsWith('VIEW-'))    return panelDerivedView(s);
  if (id.startsWith('POL-'))     return panelBurnRate(s);
  if (id.startsWith('FCST-'))    return panelForecast(s);
  if (id.startsWith('ALR-'))     return panelAlertRoute(s);
  if (id.startsWith('HEAL-'))    return panelRemediation(s);
  if (id.startsWith('BASE-'))    return panelBaselines(s);
  if (id.startsWith('CHAOS-'))   return panelChaos(s);
  if (id.startsWith('SYN-'))     return panelSynthetic(s);
  if (id.startsWith('PROF-') || id.startsWith('NET-') || id.startsWith('POE-') ||
      id.startsWith('MESH-') || id.startsWith('COL-')) return panelExtended(id, s);
  if (id.startsWith('IMP-'))     return panelImport(s);
  return null;
}

function dl(rows) {
  const dl = document.createElement('dl');
  dl.className = 'panel-dl';
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') dd.textContent = String(v);
    else dd.appendChild(v);
    dl.appendChild(dt); dl.appendChild(dd);
  }
  return dl;
}

function code(text) {
  const pre = document.createElement('pre');
  pre.className = 'json';
  pre.style.maxHeight = '12rem';
  pre.textContent = String(text);
  return pre;
}

function table(rows, headers) {
  const t = document.createElement('table');
  t.className = 'panel-table';
  if (headers) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const h of headers) { const th = document.createElement('th'); th.textContent = h; tr.appendChild(th); }
    thead.appendChild(tr);
    t.appendChild(thead);
  }
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      if (typeof cell === 'string' || typeof cell === 'number') td.textContent = cell;
      else if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = cell == null ? '—' : JSON.stringify(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  return t;
}

function panelSLI(s) {
  const p = panel('SLI', 'p-sli');
  p.appendChild(dl([
    ['type', s.type],
    ['semconv metric', s.semconv_metric],
    ['unit', s.unit],
    ['threshold', s.threshold],
    ['percentile', s.percentile],
    ['owner', s.owner],
  ]));
  if (s.good) { const sec = subpanel('good (PromQL)'); sec.appendChild(code(s.good)); p.appendChild(sec); }
  if (s.total) { const sec = subpanel('total (PromQL)'); sec.appendChild(code(s.total)); p.appendChild(sec); }
  if (s.query) { const sec = subpanel('query (PromQL)'); sec.appendChild(code(s.query)); p.appendChild(sec); }
  if (s.expression) { const sec = subpanel('expression'); sec.appendChild(code(s.expression)); p.appendChild(sec); }
  return p;
}

function panelSLO(s) {
  const p = panel('SLO', 'p-slo');
  const sliRefSpan = document.createElement('span');
  if (s.sli) {
    const link = document.createElement('a');
    link.href = '#'; link.className = 'ref-link'; link.textContent = s.sli;
    link.onclick = (e) => { e.preventDefault(); jumpToRef(s.sli.startsWith('slis.') ? s.sli : `slis.${s.sli}`); };
    sliRefSpan.appendChild(link);
  }
  p.appendChild(dl([
    ['sli', sliRefSpan],
    ['objective', s.objective != null ? `${(s.objective * 100).toFixed(2).replace(/\.?0+$/, '')}%` : null],
    ['window', s.window],
    ['error budget policy', s.error_budget_policy],
  ]));
  return p;
}

function panelOtel(s) {
  const p = panel('OTel contract', 'p-otel');
  p.appendChild(dl([
    ['semconv', s.semconv],
    ['languages', s.sdk?.languages?.join(', ')],
    ['propagators', s.sdk?.propagators?.join(', ')],
    ['sampling', s.sdk?.sampling ? `${s.sdk.sampling.policy}${s.sdk.sampling.ratio != null ? ` @ ${s.sdk.sampling.ratio}` : ''}` : null],
    ['log correlation', s.sdk?.log_correlation == null ? null : String(s.sdk.log_correlation)],
    ['required attributes', s.resource_attributes?.required?.join(', ')],
    ['custom attributes', s.resource_attributes?.custom?.join(', ')],
  ]));
  return p;
}

function panelBackend(s) {
  const p = panel('Telemetry backend', 'p-backend');
  p.appendChild(dl([
    ['id', s.id],
    ['signal', s.signal],
    ['product', s.product],
    ['default', s.default == null ? null : String(s.default)],
    ['tenant', s.tenant],
  ]));
  if (s.version) {
    const sec = subpanel('version policy');
    sec.appendChild(dl([
      ['declared', s.version.declared],
      ['min', s.version.min],
      ['max', s.version.max],
      ['gating', s.version.gating],
      ['capabilities', s.version.capabilities?.join(', ')],
    ]));
    p.appendChild(sec);
  }
  if (s.endpoints?.length) {
    const sec = subpanel('endpoints');
    const ul = document.createElement('ul'); ul.className = 'endpoint-list';
    for (const e of s.endpoints) { const li = document.createElement('li'); li.textContent = e; ul.appendChild(li); }
    sec.appendChild(ul);
    p.appendChild(sec);
  }
  if (s.auth) {
    const sec = subpanel('auth');
    sec.appendChild(dl([
      ['kind', s.auth.kind],
      ['secretRef', s.auth.secretRef],
      ['tenant', s.auth.tenant],
      ['orgId', s.auth.orgId],
    ]));
    p.appendChild(sec);
  }
  return p;
}

function panelStorage(s) {
  const p = panel('Storage', 'p-storage');
  p.appendChild(dl([
    ['backend', s.backend],
    ['version', s.version],
    ['min version', s.min_version],
    ['gating', s.gating],
    ['backend ref', s.backend_ref],
    ['retention', s.retention],
    ['data stream', s.data_stream],
    ['ilm policy', s.ilm_policy],
    ['sampling', s.sampling],
  ]));
  if (s.remote_write?.length) {
    const sec = subpanel('remote write');
    sec.appendChild(table(s.remote_write.map(r => [r.url, r.tenant || '—']), ['url', 'tenant']));
    p.appendChild(sec);
  }
  if (s.downsample?.length) {
    const sec = subpanel('downsample');
    sec.appendChild(table(s.downsample.map(d => [d.resolution, d.retain_for]), ['resolution', 'retain for']));
    p.appendChild(sec);
  }
  return p;
}

function panelPipeline(id, s) {
  let kind = 'pipeline';
  if (id.startsWith('PIP-RCV-')) kind = 'receiver';
  else if (id.startsWith('PIP-PRC-')) kind = 'processor';
  else if (id.startsWith('PIP-EXP-')) kind = 'exporter';
  const p = panel(`OTel Collector ${kind}`, 'p-pipeline');
  p.appendChild(dl([['name', s.name], ['kind', s.kind]]));
  return p;
}

function panelDashboard(s) {
  const p = panel('Dashboard', 'p-dashboard');
  p.appendChild(dl([
    ['id', s.id],
    ['provider', s.provider?.kind],
    ['provider version', s.provider?.version],
    ['schemaVersion', s.provider?.schemaVersion],
    ['folder', s.folder],
    ['source', s.source],
    ['template', s.template],
  ]));
  if (s.datasources) {
    const sec = subpanel('datasources');
    sec.appendChild(dl(Object.entries(s.datasources).map(([k, v]) => [k, v])));
    p.appendChild(sec);
  }
  if (s.panel_bindings?.length) {
    const sec = subpanel('panel bindings');
    const rows = s.panel_bindings.map(b => {
      const a = document.createElement('a');
      a.href = '#'; a.className = 'ref-link'; a.textContent = b.binds_to;
      a.onclick = (e) => { e.preventDefault(); jumpToRef(b.binds_to); };
      return [b.panel, a];
    });
    sec.appendChild(table(rows, ['panel', 'binds to']));
    p.appendChild(sec);
  }
  return p;
}

function panelRecordingRule(s) {
  const p = panel('Recording rule', 'p-rule');
  p.appendChild(dl([['name', s.name], ['interval', s.interval]]));
  if (s.expr) { const sec = subpanel('expr (PromQL)'); sec.appendChild(code(s.expr)); p.appendChild(sec); }
  if (s.labels) { const sec = subpanel('labels'); sec.appendChild(dl(Object.entries(s.labels))); p.appendChild(sec); }
  return p;
}

function panelDerivedView(s) {
  const p = panel('Derived view', 'p-view');
  p.appendChild(dl([['id', s.id], ['bind', s.bind]]));
  if (s.params) { const sec = subpanel('params'); sec.appendChild(code(JSON.stringify(s.params, null, 2))); p.appendChild(sec); }
  return p;
}

function panelBurnRate(s) {
  const p = panel('Burn-rate alert', 'p-burn');
  const sloSpan = document.createElement('span');
  if (s.slo) {
    const a = document.createElement('a');
    a.href = '#'; a.className = 'ref-link'; a.textContent = s.slo;
    a.onclick = (e) => { e.preventDefault(); jumpToRef(s.slo.startsWith('slos.') ? s.slo : `slos.${s.slo}`); };
    sloSpan.appendChild(a);
  }
  p.appendChild(dl([['slo', sloSpan]]));
  if (s.windows?.length) {
    const sec = subpanel('windows');
    sec.appendChild(table(
      s.windows.map(w => [w.short, w.long, w.factor + 'x', w.severity]),
      ['short', 'long', 'factor', 'severity'],
    ));
    p.appendChild(sec);
  }
  return p;
}

function panelForecast(s) {
  const p = panel('Forecast', 'p-forecast');
  const sloSpan = document.createElement('span');
  if (s.slo) {
    const a = document.createElement('a');
    a.href = '#'; a.className = 'ref-link'; a.textContent = s.slo;
    a.onclick = (e) => { e.preventDefault(); jumpToRef(s.slo.startsWith('slos.') ? s.slo : `slos.${s.slo}`); };
    sloSpan.appendChild(a);
  }
  p.appendChild(dl([['slo', sloSpan], ['method', s.method], ['horizon', s.horizon], ['on projected breach', s.on_projected_breach]]));
  return p;
}

function panelAlertRoute(s) {
  const p = panel('Alert route', 'p-alert');
  p.appendChild(dl([['severity', s.severity]]));
  if (s.channels?.length) {
    const sec = subpanel('channels');
    const rows = s.channels.map(ch => {
      const kind = Object.keys(ch)[0];
      const target = ch[kind];
      return [kind, target];
    });
    sec.appendChild(table(rows, ['kind', 'target']));
    p.appendChild(sec);
  }
  if (s.match) { const sec = subpanel('match'); sec.appendChild(dl(Object.entries(s.match))); p.appendChild(sec); }
  return p;
}

function panelRemediation(s) {
  const p = panel('Remediation', 'p-heal');
  p.appendChild(dl([
    ['trigger', s.trigger],
    ['runbook', s.runbook],
    ['automation', s.automation],
  ]));
  if (s.guardrails) {
    const sec = subpanel('guardrails');
    sec.appendChild(dl([
      ['max invocations / hour', s.guardrails.max_invocations_per_hour],
      ['requires human above', s.guardrails.requires_human_above],
      ['rollback on failure', s.guardrails.rollback_on_failure == null ? null : String(s.guardrails.rollback_on_failure)],
      ['cooldown after success', s.guardrails.cooldown_after_success],
      ['circuit breaker', s.guardrails.circuit_breaker
        ? `${s.guardrails.circuit_breaker.failures} failures / ${s.guardrails.circuit_breaker.window}`
        : null],
    ]));
    p.appendChild(sec);
  }
  return p;
}

function panelBaselines(s) {
  const p = panel('Baselines', 'p-base');
  p.appendChild(dl([
    ['MTTD p50', s.mttd_target_p50],
    ['MTTD p95', s.mttd_target_p95],
    ['MTTR p50', s.mttr_target_p50],
    ['MTTR p95', s.mttr_target_p95],
    ['measurement source', s.measurement_source],
    ['review cadence', s.review_cadence],
    ['regression gate', s.regression_gate],
  ]));
  return p;
}

function panelChaos(s) {
  const p = panel('Chaos experiment', 'p-chaos');
  const hypSpan = document.createElement('span');
  if (s.steady_state_hypothesis) {
    const a = document.createElement('a');
    a.href = '#'; a.className = 'ref-link'; a.textContent = s.steady_state_hypothesis;
    a.onclick = (e) => { e.preventDefault(); jumpToRef(s.steady_state_hypothesis); };
    hypSpan.appendChild(a);
  }
  p.appendChild(dl([
    ['engine', s.engine],
    ['target', s.target],
    ['steady-state hypothesis', hypSpan],
    ['fault', s.fault ? `${s.fault.kind}${s.fault.duration ? ` · ${s.fault.duration}` : ''}${s.fault.fraction != null ? ` · ${s.fault.fraction}` : ''}` : null],
    ['expected MTTD', s.expected_mttd],
    ['schedule', s.schedule],
    ['environment', s.environment],
  ]));
  if (s.expected_alerts?.length) {
    const sec = subpanel('expected alerts');
    const ul = document.createElement('ul'); ul.className = 'endpoint-list';
    for (const a of s.expected_alerts) { const li = document.createElement('li'); li.textContent = a; ul.appendChild(li); }
    sec.appendChild(ul);
    p.appendChild(sec);
  }
  return p;
}

function panelSynthetic(s) {
  const p = panel('Synthetic check', 'p-syn');
  p.appendChild(dl([
    ['kind', s.kind],
    ['target', s.target],
    ['interval', s.interval],
    ['on fail severity', s.on_fail_severity],
    ['otel instrumentation', s.otel_instrumentation == null ? null : String(s.otel_instrumentation)],
  ]));
  if (s.assertions?.length) {
    const sec = subpanel('assertions');
    sec.appendChild(code(JSON.stringify(s.assertions, null, 2)));
    p.appendChild(sec);
  }
  return p;
}

function panelExtended(id, s) {
  let kind = 'extended surface';
  if (id.startsWith('PROF-')) kind = 'profiling';
  else if (id.startsWith('NET-'))  kind = 'network observability';
  else if (id.startsWith('POE-'))  kind = 'policy engine';
  else if (id.startsWith('MESH-')) kind = 'mesh / gateway';
  else if (id.startsWith('COL-'))  kind = 'collection pipeline';
  const p = panel(`Extended surface · ${kind}`, 'p-ext');
  p.appendChild(dl([
    ['product', s.product],
    ['role', s.role],
    ['backend', s.backend],
    ['version (declared)', s.version?.declared],
    ['version (min)', s.version?.min],
    ['gating', s.version?.gating],
    ['profile types', s.profile_types?.join(', ')],
    ['observe', s.observe?.join(', ')],
    ['bundles', s.bundles?.join(', ')],
  ]));
  return p;
}

function panelImport(s) {
  const p = panel('Import', 'p-import');
  p.appendChild(dl([['ref', s.ref]]));
  if (s.with) { const sec = subpanel('with'); sec.appendChild(code(JSON.stringify(s.with, null, 2))); p.appendChild(sec); }
  return p;
}

function subpanel(title) {
  const sec = document.createElement('div');
  sec.className = 'subpanel';
  sec.innerHTML = `<h4>${escapeHtml(title)}</h4>`;
  return sec;
}

function closeDrawer(side) {
  // No side passed = close all (Esc key / external triggers).
  const sides = side ? [side] : ['a', 'b'];
  for (const s of sides) {
    const els = DRAWER_ELS[s];
    if (!els) continue;
    $(els.drawer).setAttribute('aria-hidden', 'true');
    if (s === 'a') state.activeCardKeyA = null;
    else if (state.activeLayer === 'COMPARE') state.activeCardKeyB = null;
    else state.activeCardKey = null;
  }
  // Only release body scroll lock when both drawers are closed.
  const anyOpen = ['a', 'b'].some(s => $(DRAWER_ELS[s].drawer).getAttribute('aria-hidden') === 'false');
  if (!anyOpen) document.body.classList.remove('no-scroll');
  $$('.card').forEach(c => {
    const k = c.dataset.key;
    c.classList.toggle('is-active',
      k === state.activeCardKey || k === state.activeCardKeyA || k === state.activeCardKeyB);
  });
}

// ---------- toast ----------

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (kind ? ' is-' + kind : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 4000);
}

// ---------- upload ----------

async function handleFile(file) {
  if (!file) return;
  const text = await file.text();
  const isYaml = /\.ya?ml$/i.test(file.name) || file.type === 'text/yaml' || file.type === 'application/x-yaml';
  const ct = isYaml ? 'application/x-yaml' : 'application/json';
  try {
    const res = await validateUploaded(text, ct, state.selectedEnv);
    if (!res.ok) {
      const view = $('#layer-view');
      view.innerHTML = `
        <div class="error">
          <strong>${file.name} failed validation:</strong>
          <ul>${res.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
        </div>
      `;
      toast(`${file.name}: ${res.errors.length} validation error(s)`, 'error');
      return;
    }
    state.pack = res.adapted;
    state.conformance = res.conformance;
    state.symbolTable = buildSymbolTable(res.adapted);
    state.uploadedSource = file.name;
    state.activeLayer = 'L1';
    state.activeCardKey = null;
    state.mode = 'single';
    // The server now registers uploaded packs and returns an id so the
    // rest of the API (/api/packs/:id/compile-catalog, /conformance,
    // /deploy, /diff) can address them. Use it as state.selectedPackId
    // so Compile / Deploy / Compare all Just Work — instead of hanging
    // the way they did pre-registration.
    if (res.registered?.id) {
      state.selectedPackId = res.registered.id;
      state.selectedEnv = defaultEnvFor(state.selectedPackId);
      // Refresh the catalog so the picker shows the new uploaded pack
      // alongside the file-backed ones. Pack B picker reads the same
      // catalog so it's available there too.
      await loadCatalog();
    }
    applyModeChrome();
    renderPackSelect();
    renderPackBSelect();
    renderEnvSelect();
    renderMeta();
    renderTabs();
    renderMainView();
    toast(`Loaded ${file.name}`);
  } catch (e) {
    toast(`Failed to upload: ${e.message}`, 'error');
  }
}

function setupUpload() {
  const fileInput = $('#file-input');
  const btn = $('#upload-btn');
  const popover = $('#upload-popover');

  // Upload button now opens a small popover offering three paths:
  // (a) pick a local file (the original behaviour), (b) load Krystaline
  // from the live MCP, (c) scan the KrystalineX OSS repo. Click-outside
  // and Esc close it. The popover lets the demo feel organic — the
  // presenter clicks Upload like any user, sees one of the quick-start
  // cases listed, and loads it in one click. Same flows the rest of
  // the studio already uses (no demo-mode codepath).
  const closePopover = () => {
    if (!popover) return;
    popover.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  const openPopover = () => {
    if (!popover) return;
    popover.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  };
  btn.onclick = (ev) => {
    ev.stopPropagation();
    if (!popover) { fileInput.click(); return; }
    popover.hidden ? openPopover() : closePopover();
  };
  document.addEventListener('click', (ev) => {
    if (!popover || popover.hidden) return;
    if (ev.target.closest('.upload-popover-wrap')) return;
    closePopover();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && popover && !popover.hidden) closePopover();
  });
  if (popover) {
    popover.addEventListener('click', async (ev) => {
      const item = ev.target.closest('.upload-popover-item');
      if (!item) return;
      const action = item.dataset.action;
      closePopover();
      if (action === 'pick-file') {
        fileInput.click();
        return;
      }
      if (action === 'quick-krystaline') {
        // Same flow as the home's MCP connect → adopt path, just driven
        // programmatically. We pre-fill the URL and trigger the same
        // doHomeMcpConnect that the home button calls. The friendly
        // label is held on the panel via a data-attribute so the
        // adopt handler can pass it through to the API.
        window._tomographQuickLabel = 'Krystaline (live MCP draft)';
        const newFromLive = document.getElementById('draft-mcp-btn');
        if (newFromLive) newFromLive.click();
        setTimeout(() => {
          const panelUrl = document.getElementById('draft-mcp-url');
          if (panelUrl) panelUrl.value = 'https://www.krystaline.io/mcp/public';
          const goBtn = document.getElementById('draft-mcp-go-btn');
          if (goBtn) goBtn.click();
        }, 60);
        return;
      }
      if (action === 'quick-krystalinex-repo') {
        // Open the scan-a-repo panel and pre-fill the GitHub URL field.
        window._tomographQuickLabel = 'KrystalineX (repo scan)';
        const scanBtn = document.getElementById('crawl-btn');
        if (scanBtn) scanBtn.click();
        setTimeout(() => {
          const ghUrl = document.getElementById('crawl-github-url');
          if (ghUrl) {
            ghUrl.value = 'MoebiusX/KrystalineX';
            ghUrl.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const ghGo = document.getElementById('crawl-github-go-btn');
          if (ghGo && !ghGo.disabled) ghGo.click();
        }, 60);
        return;
      }
    });
  }
  fileInput.onchange = () => { if (fileInput.files?.[0]) handleFile(fileInput.files[0]); fileInput.value = ''; };

  let dragDepth = 0;
  const overlay = $('#drop-overlay');
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    overlay.hidden = false;
    document.body.classList.add('is-dragging');
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      overlay.hidden = true;
      document.body.classList.remove('is-dragging');
    }
  });
  document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0; overlay.hidden = true;
    document.body.classList.remove('is-dragging');
    handleFile(e.dataTransfer.files[0]);
  });
}

// ---------- boot ----------

async function refresh() {
  try {
    await loadPack(state.selectedPackId, state.selectedEnv);
    // Compile catalog is pack/env-specific — invalidate on switch so the
    // tree re-fetches the new pack's artifacts.
    state.compileCatalog = null;
    state.compileContent = null;
    renderEnvSelect();
    renderPackSelect();
    renderPackBSelect();
    renderMeta();
    renderTabs();
    renderMainView();
  } catch (e) {
    const view = $('#layer-view');
    view.innerHTML = `<div class="error">Failed to load pack: ${escapeHtml(e.message)}</div>`;
    toast('Failed to load pack', 'error');
  }
}

// ============================================================
// OBSERVA chrome — the three-tab top bar from the demo mockup.
//
// Replaces the legacy header (Tomograph logo + dense pack-picker row +
// meta strip + view-nav + layer chips) with a single clean chrome:
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │ [logo] TOMOGRAPH    ① Layers       ② Comparison    ③ ObsOps     │
//   │                       What's in...   Is it good...   Compile &  │
//   │                                                                  │
//   │                                          Projects · Alerts · AD  │
//   └──────────────────────────────────────────────────────────────────┘
//
// The legacy chrome stays in the DOM but hidden — every existing event
// handler that references #pack-select, #upload-btn, etc. keeps working.
// A small "⚙ controls" button reveals the legacy controls row on demand
// for pack switching / upload / scan / theme until those move into the
// tab content in later phases.
// ============================================================
// Question-oriented chrome: the tab title IS the user's mental
// question, the small workflow word beneath identifies the act the
// product takes to answer it. This is the load-bearing framing —
// most observability tools organize around data types or products;
// Tomograph organizes around three questions that map onto a workflow
// people already understand from medicine:
//
//     Discover  →  Diagnose  →  Remediate
//      (CT scan)    (Diagnosis)   (Treatment)
//
// The technical names (Layers / Comparison / ObsOps) move into the
// tooltip — discoverable but not load-bearing on the chrome.
const OBSERVA_TABS = [
  {
    id: 'layers',
    n: '1',
    label: 'What Do We Have?',
    sub: 'Discover',
    techName: 'Layers',
    tagline: 'the Observability Tomogram',
    accent: 'tab-blue',
  },
  {
    id: 'compare',
    n: '2',
    label: 'Can We Trust It?',
    sub: 'Diagnose',
    techName: 'Comparison',
    tagline: 'Coverage & Fidelity',
    accent: 'tab-magenta',
  },
  {
    id: 'compile',
    n: '3',
    label: 'Fix The Gaps',
    sub: 'Remediate',
    techName: 'ObsOps',
    tagline: 'Compile & Deploy',
    accent: 'tab-emerald',
  },
];

// "Advanced / Alien Observability" — the deep, specialised tools that
// sit OFF the three-step workflow. A first-time user never needs these;
// an expert reaches for them. They live behind a single right-side
// chrome button (styled like the old action cluster) that opens a menu.
// Each routes to a view that already exists in the dispatcher.
const OBSERVA_ADV = [
  { id: 'references',   label: 'References',   sub: 'catalogue reference packs · benchmark vs best practice' },
  { id: 'conformance',  label: 'Conformance',  sub: 'maturity rubric · MUST/SHOULD per tier' },
  { id: 'schema',       label: 'Schema',       sub: 'canonical YAML + v1.2 validation' },
  { id: 'otlp',         label: 'OTLP Coverage', sub: 'receiver protocols · per-signal exporters' },
  { id: 'traceability', label: 'Traceability', sub: 'repo vs live · declared / verified / stale' },
  { id: 'atlas',        label: 'Atlas',        sub: 'visual atlases · strata · periodic · skyline' },
];
const OBSERVA_ADV_VIEWS = new Set(OBSERVA_ADV.map(a => a.id));

function installObservaChrome() {
  if (document.querySelector('.observa-hdr')) return;
  document.body.classList.add('chrome-observa');

  const hdr = document.createElement('header');
  hdr.className = 'observa-hdr';
  hdr.innerHTML = `
    <div class="observa-hdr-inner">
      <a class="observa-brand" href="/" aria-label="Tomograph home">
        <span class="observa-logo" aria-hidden="true">
          <svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="observaLogoG" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%"  stop-color="#3b82f6"/>
                <stop offset="50%" stop-color="#a855f7"/>
                <stop offset="100%" stop-color="#10b981"/>
              </linearGradient>
            </defs>
            <path d="M18 3 L31 11 L31 25 L18 33 L5 25 L5 11 Z" stroke="url(#observaLogoG)" stroke-width="2" fill="none"/>
            <path d="M18 11 L25 15 L25 22 L18 26 L11 22 L11 15 Z" stroke="url(#observaLogoG)" stroke-width="1.4" fill="rgba(168,85,247,0.12)"/>
            <circle cx="18" cy="18" r="2.4" fill="url(#observaLogoG)"/>
          </svg>
        </span>
        <span class="observa-brand-text">
          <span class="observa-wordmark">TOMO<strong>GRAPH</strong></span>
          <span class="observa-tagline">
            <span class="observa-tagline-step">Discover</span>
            <span class="observa-tagline-dot">·</span>
            <span class="observa-tagline-step">Diagnose</span>
            <span class="observa-tagline-dot">·</span>
            <span class="observa-tagline-step">Remediate</span>
          </span>
        </span>
      </a>

      <nav class="observa-tabs" role="tablist" aria-label="Primary">
        ${OBSERVA_TABS.map(t => `
          <button type="button" role="tab" class="observa-tab ${t.accent}" data-view="${t.id}"
                  aria-selected="false" title="${escapeHtml(t.techName + ' — ' + t.tagline)}">
            <span class="observa-tab-num">${t.n}</span>
            <span class="observa-tab-text">
              <span class="observa-tab-eyebrow">${escapeHtml(t.sub)}</span>
              <span class="observa-tab-title">${escapeHtml(t.label)}</span>
              <span class="observa-tab-tagline">${escapeHtml(t.tagline)}</span>
            </span>
          </button>
        `).join('')}
      </nav>

      <div class="observa-actions" aria-label="Advanced tools">
        <div class="observa-adv-wrap">
          <button type="button" class="observa-action observa-adv-toggle"
                  aria-haspopup="true" aria-expanded="false"
                  title="Advanced — deep observability tools">
            <span class="observa-action-glyph">⬡</span>
            <span class="observa-action-label">Advanced</span>
            <span class="observa-adv-caret">▾</span>
          </button>
          <div class="observa-adv-menu" role="menu" hidden>
            <div class="observa-adv-menu-head">Alien Observability · deep tools</div>
            ${OBSERVA_ADV.map(a => `
              <button type="button" class="observa-adv-item" role="menuitem" data-view="${a.id}">
                <span class="observa-adv-item-label">${escapeHtml(a.label)}</span>
                <span class="observa-adv-item-sub">${escapeHtml(a.sub)}</span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.insertBefore(hdr, document.body.firstChild);

  // Wire tab clicks → route to the existing view dispatcher.
  const routeTo = (id) => {
    if (!id) return;
    // Clicking any tab leaves the landing/reset hero and enters the
    // workspace. Without this the no-pack state stays mode='home' and
    // every tab would keep rendering the landing hero (the bug behind
    // "why is Discover like the landing hero page?"). The pack is still
    // null until the user loads one — Discover's empty state handles that.
    if (state.mode === 'home') state.mode = 'single';
    state.view = id;
    state.activeCardKey = null;
    state.activeLayer = ({ compile: 'COMPILE', conformance: 'CONF', schema: 'CONF', atlas: 'ATLAS', layers: state.layerFilter !== 'all' ? state.layerFilter : 'L1' })[id] || 'L1';
    applyModeChrome();
    paintObservaActiveTab();
    renderTabs();
    renderMainView();
  };
  for (const btn of hdr.querySelectorAll('.observa-tab')) {
    btn.addEventListener('click', () => routeTo(btn.dataset.view));
  }

  // Wire the Advanced menu — deep tools off the main workflow.
  const advToggle = hdr.querySelector('.observa-adv-toggle');
  const advMenu   = hdr.querySelector('.observa-adv-menu');
  const closeAdv = () => { if (advMenu) { advMenu.hidden = true; advToggle?.setAttribute('aria-expanded', 'false'); } };
  advToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = advMenu.hidden;
    advMenu.hidden = !willOpen;
    advToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
  hdr.querySelectorAll('.observa-adv-item').forEach(item => {
    item.addEventListener('click', () => { closeAdv(); routeTo(item.dataset.view); });
  });
  // Close the menu on any outside click / Escape.
  document.addEventListener('click', (e) => {
    if (advMenu && !advMenu.hidden && !e.target.closest('.observa-adv-wrap')) closeAdv();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAdv(); });

  paintObservaActiveTab();
}

function paintObservaActiveTab() {
  const v = state.view || 'layers';
  const active = (v === 'benchmark' || v === 'compare-artefacts') ? 'compare' : v;
  const advActive = OBSERVA_ADV_VIEWS.has(v);
  // The landing/reset hero is NOT a tab — it's the pre-workspace start
  // screen. Clearing the active marker there is what keeps Discover from
  // "being" the landing hero: you only light a tab once you're working.
  const onLanding = state.mode === 'home';
  for (const btn of document.querySelectorAll('.observa-tab')) {
    // A workflow tab is active only when we're NOT in an advanced view
    // and NOT on the landing screen.
    const isActive = !onLanding && !advActive && btn.dataset.view === active;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  const advToggle = document.querySelector('.observa-adv-toggle');
  if (advToggle) advToggle.classList.toggle('is-active', advActive);
}

async function boot() {
  // Mount the new chrome FIRST so the user sees the demo shape even
  // while the catalog loads.
  installObservaChrome();
  try { await loadCatalog(); }
  catch (e) {
    document.body.innerHTML = `<pre class="json" style="margin:48px;max-width:800px">Failed to reach Tomograph's API.\n\n${escapeHtml(e.message)}\n\nMake sure the server is running: \`node server/index.mjs\` or \`npm run serve\`.</pre>`;
    return;
  }

  setupUpload();
  setupTheme();
  setupResetButton();
  // Eagerly fetch /api/examples so the Pack B picker has the archived
  // reference packs available even before the user visits the home
  // examples disclosure. AWAITED so the persistence rehydrate below can
  // validate saved pack IDs against the merged catalog ∪ examples set.
  await loadAndCacheExamples();
  // Fetch the catalogue reference packs (Advanced → References) so they're
  // available both in that view and as Pack B benchmark targets.
  await loadAndCacheReferences();
  // Wire the Pack B "×" clear button.
  $('#pack-b-clear')?.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    state.compareBId = null; state.compareBEnv = null;
    state.packB = null; state.diff = null;
    // Drop B's parallel state slots + reset focus to A.
    state.conformanceB = null;
    state.compileCatalogB = null;
    state.compileContentB = null;
    state.viewFocus = 'a';
    // Compare + Traceability are cross-pack only; Atlas stays available
    // in single mode (Strata / Periodic / Skyline / Arbor work on one pack).
    if (state.view === 'compare' || state.view === 'traceability') state.view = 'layers';
    if (state.view === 'atlas' && CROSS_PACK_VARIANTS.has(state.atlasVariant)) {
      state.atlasVariant = 'strata';
    }
    applyModeChrome();
    renderPackBSelect();
    renderTabs();
    renderMainView();
  });
  setupMcpPanel();
  setupCrawlPanel();
  setupDraftFromMcpPanel();
  setupDeployModal();
  setupHomeAffordance();   // logo click returns home

  // Initial live-status load + 60s soft-refresh of the badge so "3m ago"
  // ticks forward without manual reload.
  state.mcpStatus = await loadLiveStatus();
  renderMcpBadge(state.mcpStatus);
  renderMcpStatusBody(state.mcpStatus);
  setInterval(() => renderMcpBadge(state.mcpStatus), 60_000);

  // Deploy matrix loaded eagerly; used by the compile view.
  loadDeployMatrix().then(() => {
    if (state.mode !== 'home' && state.activeLayer === 'COMPILE') renderMainView();
  });

  // Try to rehydrate from the previous session before falling back to
  // home. Persistence stays suspended until rehydrate finishes so the
  // boot-time mutations don't fire `schedule()` writes.
  const restored = await rehydrateFromPersistence();
  persistence.resume();
  if (!restored) goHome();
}

// ============================================================
// Home / Analyze / Compare mode transitions
// ============================================================

function goHome() {
  state.mode = 'home';
  state.pack = null;
  state.packB = null;
  state.diff = null;
  state.compileCatalog = null;
  state.compileContent = null;
  // Going home is the user saying "start over" — clear the persisted
  // pack/compare-B IDs so the next reload doesn't re-enter analyze mode.
  state.selectedPackId = null;
  state.selectedEnv = null;
  state.compareBId = null;
  state.compareBEnv = null;
  state.conformanceB = null;
  state.compileCatalogB = null;
  state.compileContentB = null;
  state.viewFocus = 'a';
  // Reset view so the next pack lands on the default browse, not on
  // whatever the previous session left selected (e.g. Compile, which
  // would be weird with no pack loaded yet).
  state.view = 'layers';
  state.layerFilter = 'all';
  applyModeChrome();
  renderHomeView();
  persistence.schedule();
}

function enterAnalyzeMode(packId, env) {
  if (!packId) return;
  state.mode = 'single';
  state.selectedPackId = packId;
  state.selectedEnv    = env || defaultEnvFor(packId);
  state.activeLayer = 'L1';
  state.activeCardKey = null;
  applyModeChrome();
  renderPackSelect();
  refresh();
}

function enterCompareMode(aId, aEnv, bId, bEnv) {
  if (!aId || !bId) return;
  state.mode = 'compare';
  state.selectedPackId = aId;
  state.selectedEnv    = aEnv || defaultEnvFor(aId);
  state.compareBId     = bId;
  state.compareBEnv    = bEnv || defaultEnvFor(bId);
  state.activeLayer    = 'COMPARE';
  applyModeChrome();
  renderPackSelect();
  refresh();
  refreshDiff();
}

// Show/hide global chrome based on mode. Home hides the pack-select,
// env-select, meta strip and tabs — only the brand + the corner
// utility buttons (upload, new from repo, new from live, mcp, theme,
// api) stay visible because they're the entry points to creating a
// new pack.
function applyModeChrome() {
  const isHome = state.mode === 'home';
  // Under the OBSERVA chrome the pack/env selectors are PINNED as a
  // permanent master row — they are the user's primary controls and
  // must never be hidden by view. Only the legacy (non-chrome) layout
  // hides them on the artefact-id side-by-side view, where the inline
  // pack cards carry their own pickers.
  const observa = document.body.classList.contains('chrome-observa');
  const onCompare = !observa && state.view === 'compare-artefacts';
  document.body.dataset.mode = state.mode;
  document.body.dataset.view = state.view || '';
  const packSel = $('#pack-select')?.parentElement;
  const envSel  = $('#env-select')?.parentElement;
  if (packSel) packSel.hidden = isHome || onCompare;
  if (envSel)  envSel.hidden  = isHome || onCompare;
  // Pack B picker stays visible whenever we're not on home — empty until
  // the user picks something. This is the unlock: no more rigid single
  // vs compare mode. Hide it on Compare for the same duplication reason.
  const packBCtrl = $('#ctrl-pack-b');
  const envBCtrl  = $('#ctrl-env-b');
  if (packBCtrl) packBCtrl.hidden = isHome || onCompare;
  if (envBCtrl)  envBCtrl.hidden  = isHome || onCompare || !state.packB;
  // Clear-B button only when B is loaded.
  const clearB = $('#pack-b-clear');
  if (clearB) clearB.hidden = !state.packB || onCompare;
  const meta = $('#meta');   if (meta) meta.hidden = isHome;
  const tabs = $('#layer-tabs'); if (tabs) tabs.hidden = isHome;
}

// RESET button — clears EVERYTHING (server uploads + client persistence)
// and reloads. Hard-refresh alone doesn't reset the studio because
// persistence rehydrates the previous pack, and uploaded packs sit in
// the server's in-memory map until the process restarts. This button
// gives the user one click for a true clean slate without bouncing
// `npm run dev`.
function setupResetButton() {
  const btn = $('#reset-btn');
  if (!btn) return;
  btn.onclick = async () => {
    const ok = confirm('Reset Tomograph?\n\n' +
      'This will:\n' +
      '  • drop every uploaded / scanned / drafted pack from the server\n' +
      '  • clear saved view + filter + focus + trace preferences from localStorage\n' +
      '  • reload the page to the empty home screen\n\n' +
      'Catalog-shipped example packs are unaffected (they live on disk).');
    if (!ok) return;
    // 1. Stop persistence from racing the reload + writing stale state.
    try { persistence.suspend(); } catch (_) {}
    // 2. Wipe localStorage. Keep theme so the user's dark/light choice
    //    survives — that's not session state, it's a preference.
    try {
      const theme = localStorage.getItem('studioTheme');
      localStorage.clear();
      if (theme) localStorage.setItem('studioTheme', theme);
    } catch (_) {}
    // 3. Drop server-side uploads. If the endpoint is unreachable we
    //    still reload — the client-side reset is the higher-leverage part.
    try {
      await fetch('/api/uploads', { method: 'DELETE' });
    } catch (_) {}
    // 4. Reload. location.reload(true) is non-standard in modern Firefox;
    //    plain reload() picks up server changes since the navigation
    //    bypasses the disk cache for HTML.
    location.reload();
  };
}

// Logo click returns home.
function setupHomeAffordance() {
  const brand = document.querySelector('.hdr-brand h1');
  if (!brand) return;
  brand.style.cursor = 'pointer';
  brand.title = 'Return home';
  brand.onclick = () => goHome();
}

// Hero / home screen — two big affordances. Mode-aware.
// Default MCP endpoint shown on the home screen — points to Krystaline's
// public reference MCP so a first-time visitor's one-click experience
// is connecting to a real, live observability platform. localStorage
// override (the user's last-used MCP URL) wins so returning users keep
// their own configured endpoint. To rebrand for a different anchor MCP,
// change this constant — the rest of the home is data-driven.
const DEFAULT_MCP_URL = 'https://www.krystaline.io/mcp/public';

// Packs available to inspect right now: anything uploaded/drafted this
// session plus the archived /api/examples set (cached at boot), de-duped.
function availablePickerPacks() {
  return [
    ...((state.catalog || []).filter(p => p.ok && p.id)),
    ...((state._examplesCache || []).filter(p => p.ok)),
  ].filter((p, i, arr) => arr.findIndex(q => q.id === p.id) === i);
}

// Wire a list of .home-pick-row buttons → load the chosen pack as Pack A
// and draw it. Examples live only in the cache, so promote the selected
// one into the catalog before entering analyze mode.
function wirePackPickerRows(scope) {
  scope.querySelectorAll('.home-pick-row').forEach(row => {
    row.onclick = () => {
      const id = row.dataset.packId;
      if (!id) return;
      if (!(state.catalog || []).find(p => p.id === id)) {
        const ex = (state._examplesCache || []).find(p => p.id === id);
        if (ex) (state.catalog = state.catalog || []).push(ex);
      }
      enterAnalyzeMode(id, defaultEnvFor(id));
    };
  });
}

function packPickerRowsHtml() {
  return availablePickerPacks().map(p => `
    <button type="button" class="home-pick-row" data-pack-id="${escapeHtml(p.id)}">
      <span class="home-pick-name">${escapeHtml(p.label || p.name || p.id)}</span>
      <span class="home-pick-meta">
        ${p.criticality ? `<span class="home-pick-tier">${escapeHtml(p.criticality)}</span>` : ''}
        <span class="home-pick-ver">v${escapeHtml(p.version || '1.2')}</span>
      </span>
      <span class="home-pick-go" aria-hidden="true">→</span>
    </button>
  `).join('');
}

// ============================================================
// DISCOVER — empty state. The Discover tab answers "what do we have?",
// and the FLOW is: load-or-generate a pack first, THEN see its inventory.
// So with no pack this renders the three ways to GET a pack — crawl a
// repo, generate live from an MCP server, or upload a manifest — plus a
// quick picker of packs already on hand. This is deliberately NOT the
// marketing hero (no giant headline, no Möbius loop); that hero is the
// separate landing/reset screen.
// ============================================================
function renderDiscoverEmpty(view) {
  const pickerRows = packPickerRowsHtml();
  view.innerHTML = `
    <section class="discover-empty">
      <header class="discover-empty-head">
        <h2 class="discover-empty-title">What do we have?</h2>
        <p class="discover-empty-lede">
          Load or generate an ObservabilityPack to draw its tomogram — the
          per-layer inventory of every contract, signal, dashboard, alert
          and check that makes up this service's observability posture.
        </p>
      </header>

      <ol class="discover-journey" aria-label="The drift check, in three steps">
        <li class="discover-journey-step">
          <span class="discover-journey-num">1</span>
          <span class="discover-journey-body">
            <span class="discover-journey-label">Scan a repo</span>
            <span class="discover-journey-sub">what the service <em>declares</em> — Pack A</span>
          </span>
        </li>
        <li class="discover-journey-step">
          <span class="discover-journey-num">2</span>
          <span class="discover-journey-body">
            <span class="discover-journey-label">Generate from live</span>
            <span class="discover-journey-sub">what the platform <em>verifies</em> — Pack B</span>
          </span>
        </li>
        <li class="discover-journey-step">
          <span class="discover-journey-num">3</span>
          <span class="discover-journey-body">
            <span class="discover-journey-label">Diagnose drift</span>
            <span class="discover-journey-sub">where declared and live disagree — automatic</span>
          </span>
        </li>
      </ol>

      <div class="discover-load">
        <button type="button" class="discover-load-card" data-load="crawl">
          <span class="discover-load-glyph" aria-hidden="true">↻</span>
          <span class="discover-load-label">① Scan a repository</span>
          <span class="discover-load-sub">walk Prom / OTel / Grafana / Alertmanager configs — local folder or a GitHub URL</span>
        </button>
        <button type="button" class="discover-load-card" data-load="mcp">
          <span class="discover-load-glyph" aria-hidden="true">⟳</span>
          <span class="discover-load-label">② Generate live from MCP</span>
          <span class="discover-load-sub">interrogate a live OpenTelemetry MCP server for backends, baselines and anomalies</span>
        </button>
        <button type="button" class="discover-load-card" data-load="upload">
          <span class="discover-load-glyph" aria-hidden="true">▤</span>
          <span class="discover-load-label">Upload a pack</span>
          <span class="discover-load-sub">an existing canonical v1.2 YAML or JSON manifest</span>
        </button>
      </div>

      ${pickerRows ? `
      <div class="home-picker discover-empty-picker">
        <div class="home-picker-head"><span>or inspect a pack already on hand</span></div>
        <div class="home-picker-list">${pickerRows}</div>
      </div>` : ''}
    </section>
  `;

  // The three load cards proxy the proven header entry points so there's
  // a single implementation of crawl / draft-from-mcp / upload.
  const proxy = { crawl: '#crawl-btn', mcp: '#draft-mcp-btn', upload: '#upload-btn' };
  view.querySelectorAll('.discover-load-card').forEach(card => {
    card.onclick = () => $(proxy[card.dataset.load])?.click();
  });
  wirePackPickerRows(view);
}

// Diagnose / Remediate with no pack loaded — both need a pack from
// Discover first. Point the user there rather than showing an empty grid.
function renderNeedPackPrompt(view) {
  const what = state.view === 'compile' ? 'compile and deploy' : 'diagnose';
  view.innerHTML = `
    <section class="need-pack">
      <h2 class="need-pack-title">Load a pack first</h2>
      <p class="need-pack-lede">There's nothing to ${escapeHtml(what)} yet. Head to
        <strong>Discover</strong> to crawl a repo, generate from a live MCP server, or
        upload a manifest — then come back here.</p>
      <button type="button" class="need-pack-btn" id="need-pack-goto-discover">
        <span>Go to Discover</span><span aria-hidden="true">→</span>
      </button>
    </section>
  `;
  $('#need-pack-goto-discover').onclick = () => {
    state.view = 'layers';
    applyModeChrome();
    paintObservaActiveTab();
    renderTabs();
    renderMainView();
  };
}

function renderHomeView() {
  const view = $('#layer-view');
  if (!view) return;

  // Premium fintech-grade home. The previous draft was functional but
  // crude — eyebrow numbering, four widget boxes, textbook-internal
  // tone. This redesign assumes a sophisticated audience: confident
  // serif headline, single primary action (URL already filled in, just
  // hit Connect), capability surface presented as an executive summary
  // not a dashboard. Auth + manual paths still reachable but quiet.
  const mcpUrl = (() => {
    try { return localStorage.getItem('mcpUrl') || DEFAULT_MCP_URL; }
    catch (_) { return DEFAULT_MCP_URL; }
  })();

  view.innerHTML = `
    <section class="home-hero">
      <div class="home-hero-eyebrow">tomograph · the observability compiler</div>
      <h2 class="home-hero-title">Map your observability platform in seconds.</h2>
      <p class="home-hero-lede">
        Scan a service repo to capture what it <em>declares</em>, then draft
        from a live OpenTelemetry MCP server to capture what the platform
        <em>verifies</em> — Tomograph diffs the two and shows you exactly where
        they drift. Connect below to begin, or scan a repo from Discover.
      </p>

      <div class="home-mcp-card">
        <label class="home-mcp-url-row">
          <span class="home-mcp-url-label">MCP endpoint</span>
          <input id="home-mcp-url" type="url" autocomplete="off" spellcheck="false" value="${escapeHtml(mcpUrl)}">
        </label>
        <div class="home-mcp-actions">
          <button id="home-mcp-connect" type="button" class="home-mcp-connect-btn">
            <span class="home-mcp-connect-label">Connect</span>
            <span class="home-mcp-connect-arrow" aria-hidden="true">→</span>
          </button>
          <button id="home-mcp-advanced-toggle" type="button" class="home-mcp-advanced-toggle" aria-expanded="false">
            Advanced
          </button>
          <span id="home-mcp-status" class="home-mcp-status"></span>
        </div>
        <div id="home-mcp-advanced" class="home-mcp-advanced" hidden>
          <label class="home-mcp-field">
            <span class="home-mcp-key">Auth token <em>not persisted</em></span>
            <input id="home-mcp-auth" type="password" placeholder="bearer" autocomplete="off">
          </label>
        </div>

        <!-- Capabilities surface here once the MCP responds. -->
        <div id="home-mcp-capabilities" class="home-mcp-capabilities" hidden></div>

        <div id="home-mcp-adopt-bar" class="home-mcp-adopt-bar" hidden>
          <button id="home-mcp-adopt" type="button" class="home-mcp-adopt-btn">
            <span class="home-mcp-adopt-title">Render the manifest</span>
            <span class="home-mcp-adopt-sub" id="home-mcp-adopt-hint">canonical v1.2 · ready to compile and deploy</span>
          </button>
        </div>
      </div>

      <div class="home-alt">
        <div class="home-alt-head"><span>or open a pack manually</span></div>
        <div class="home-alt-buttons">
          <button id="home-shortcut-upload" type="button" class="home-alt-btn">
            <span class="home-alt-key" aria-hidden="true">▤</span>
            <span class="home-alt-label">Drop a YAML / JSON pack</span>
            <span class="home-alt-sub">canonical v1.2 manifest</span>
          </button>
          <button id="home-shortcut-crawl" type="button" class="home-alt-btn">
            <span class="home-alt-key" aria-hidden="true">↻</span>
            <span class="home-alt-label">Scan a service repo</span>
            <span class="home-alt-sub">walks Prom / OTel / Grafana / AM configs · or a GitHub URL</span>
          </button>
        </div>
      </div>

      <div class="home-cycle">
        <svg class="home-cycle-svg" viewBox="0 0 960 640" xmlns="http://www.w3.org/2000/svg" role="img" font-family="'IBM Plex Sans', system-ui, sans-serif">
          <title>The Möbius Loop — Tomograph's continuous assurance cycle</title>
          <desc>Four stages — Declare, Compile, Observe, Verify — arranged as a closed loop around a single twisted Möbius ribbon, signifying one continuous surface with no first or last step.</desc>

          <defs>
            <pattern id="cyc-dots" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1" fill="#1e2a3b" opacity="0.55"/>
            </pattern>
            <linearGradient id="cyc-mobius-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#5dcaa5"/>
              <stop offset="0.34" stop-color="#54b3d4"/>
              <stop offset="0.67" stop-color="#8f86e8"/>
              <stop offset="1" stop-color="#e0703f"/>
            </linearGradient>
            <marker id="cyc-ah" markerWidth="9" markerHeight="6" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0,0 L8,3 L0,6 Z" fill="#5a6b82"/>
            </marker>
          </defs>

          <!-- panel -->
          <rect x="12" y="12" width="936" height="616" rx="18" fill="#0e1622" stroke="#21314a" stroke-width="1.5"/>
          <rect x="12" y="12" width="936" height="616" rx="18" fill="url(#cyc-dots)"/>

          <!-- header -->
          <line x1="330" y1="50" x2="392" y2="50" stroke="#33485f" stroke-width="1"/>
          <text x="480" y="55" text-anchor="middle" font-size="13" letter-spacing="4" font-weight="600" fill="#7fa9a0">THE MÖBIUS LOOP</text>
          <line x1="568" y1="50" x2="630" y2="50" stroke="#33485f" stroke-width="1"/>

          <!-- intro -->
          <g font-family="'Newsreader', Georgia, serif" fill="#aab4c2" font-size="15.5" text-anchor="middle">
            <text x="480" y="94">Declare once. Compile the platform. Observe it live. Verify the image still matches the system —</text>
            <text x="480" y="118">then begin again. Like the strip it's named for, the loop is one continuous surface:</text>
            <text x="480" y="142">no first step, no last, and nowhere for drift to hide.</text>
          </g>

          <!-- central Möbius ribbon (lemniscate) -->
          <path d="M 480 399 C 540 329 630 329 630 399 C 630 469 540 469 480 399 C 420 329 330 329 330 399 C 330 469 420 469 480 399 Z"
                fill="none" stroke="url(#cyc-mobius-grad)" stroke-width="16" stroke-linecap="round" opacity="0.85"/>
          <path d="M 480 399 C 540 329 630 329 630 399 C 630 469 540 469 480 399 C 420 329 330 329 330 399 C 330 469 420 469 480 399 Z"
                fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" opacity="0.10"/>

          <!-- connectors (clockwise) — mirror-symmetric about x=480.
               All four arrows attach to nodes at the same 51px inset
               from the corner: x=706 on COMPILE (left side), x=254 on
               VERIFY (right side), and the matching offsets on
               DECLARE + OBSERVE for the corner-exit arrows. -->
          <path d="M 588 276 Q 690 300 706 358" fill="none" stroke="#4a5b72" stroke-width="2" marker-end="url(#cyc-ah)"/>
          <path d="M 706 442 Q 690 502 590 522" fill="none" stroke="#4a5b72" stroke-width="2" marker-end="url(#cyc-ah)"/>
          <path d="M 370 522 Q 270 502 254 442" fill="none" stroke="#4a5b72" stroke-width="2" marker-end="url(#cyc-ah)"/>
          <!-- closing arc: dashed return = "and again" -->
          <path d="M 254 358 Q 270 300 372 276" fill="none" stroke="#4a5b72" stroke-width="2" stroke-dasharray="5 5" marker-end="url(#cyc-ah)"/>
          <text x="207" y="312" font-size="15" fill="#7fa9a0">↺</text>
          <text x="192" y="300" font-family="'Newsreader', Georgia, serif" font-size="11" font-style="italic" fill="#6f7d90">begin again</text>

          <!-- node: DECLARE (green) -->
          <rect x="375" y="212" width="210" height="76" rx="12" fill="#141d2c" stroke="#5dcaa5" stroke-width="2"/>
          <text x="480" y="242" text-anchor="middle" font-size="15" font-weight="700" letter-spacing="1.5" fill="#e9eef5">DECLARE</text>
          <text x="480" y="261" text-anchor="middle" font-family="'Newsreader', Georgia, serif" font-style="italic" font-size="12.5" fill="#9aa6b8">generate the pack</text>
          <text x="480" y="277" text-anchor="middle" font-size="10.5" fill="#6f7d90">one service · one contract</text>

          <!-- node: COMPILE (purple) -->
          <rect x="655" y="362" width="210" height="76" rx="12" fill="#141d2c" stroke="#8f86e8" stroke-width="2"/>
          <text x="760" y="392" text-anchor="middle" font-size="15" font-weight="700" letter-spacing="1.5" fill="#e9eef5">COMPILE</text>
          <text x="760" y="411" text-anchor="middle" font-family="'Newsreader', Georgia, serif" font-style="italic" font-size="12.5" fill="#9aa6b8">packc → every backend</text>
          <text x="760" y="427" text-anchor="middle" font-size="10.5" fill="#6f7d90">Prom · Grafana · OTel · AM</text>

          <!-- node: OBSERVE (cyan) -->
          <rect x="375" y="510" width="210" height="76" rx="12" fill="#141d2c" stroke="#54b3d4" stroke-width="2"/>
          <text x="480" y="540" text-anchor="middle" font-size="15" font-weight="700" letter-spacing="1.5" fill="#e9eef5">OBSERVE</text>
          <text x="480" y="559" text-anchor="middle" font-family="'Newsreader', Georgia, serif" font-style="italic" font-size="12.5" fill="#9aa6b8">live signal via MCP</text>
          <text x="480" y="575" text-anchor="middle" font-size="10.5" fill="#6f7d90">"declared" becomes "verified"</text>

          <!-- node: VERIFY (amber) -->
          <rect x="95" y="362" width="210" height="76" rx="12" fill="#141d2c" stroke="#e0703f" stroke-width="2"/>
          <text x="200" y="392" text-anchor="middle" font-size="15" font-weight="700" letter-spacing="1.5" fill="#e9eef5">VERIFY</text>
          <text x="200" y="411" text-anchor="middle" font-family="'Newsreader', Georgia, serif" font-style="italic" font-size="12.5" fill="#9aa6b8">scan · score · attest</text>
          <text x="200" y="427" text-anchor="middle" font-size="10.5" fill="#6f7d90">does the image still hold?</text>
        </svg>
      </div>
    </section>
  `;

  $('#home-mcp-connect').onclick = () => doHomeMcpConnect();
  $('#home-mcp-url').onkeydown = (e) => { if (e.key === 'Enter') doHomeMcpConnect(); };
  $('#home-mcp-advanced-toggle').onclick = () => {
    const adv = $('#home-mcp-advanced');
    const tog = $('#home-mcp-advanced-toggle');
    const shown = adv.hidden;
    adv.hidden = !shown;
    tog.setAttribute('aria-expanded', String(shown));
    if (shown) $('#home-mcp-auth')?.focus();
  };
  $('#home-shortcut-upload').onclick = () => $('#upload-btn')?.click();
  $('#home-shortcut-crawl').onclick  = () => $('#crawl-btn')?.click();
}

async function doHomeMcpConnect() {
  const urlInput  = $('#home-mcp-url');
  const authInput = $('#home-mcp-auth');
  const statusEl  = $('#home-mcp-status');
  const goBtn     = $('#home-mcp-connect');
  const capEl     = $('#home-mcp-capabilities');
  const adoptBar  = $('#home-mcp-adopt-bar');
  if (!urlInput || !statusEl) return;

  const url  = urlInput.value.trim();
  const auth = authInput?.value || '';
  if (!url) {
    statusEl.textContent = 'enter your MCP URL first';
    statusEl.className = 'home-mcp-status is-error';
    return;
  }
  try { localStorage.setItem('mcpUrl', url); } catch (_) {}

  goBtn.disabled = true;
  statusEl.textContent = 'contacting MCP…';
  statusEl.className = 'home-mcp-status is-pending';
  capEl.hidden = true;
  adoptBar.hidden = true;

  try {
    const r = await fetch('/api/draft-from-mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcpUrl: url,
        mcpAuth: auth || undefined,
        // Forward the quick-start friendly label when the user came
        // through the Upload popover. window._tomographQuickLabel is
        // cleared after consumption so manual draft-from-mcp from the
        // panel keeps the auto-generated label.
        label: window._tomographQuickLabel || undefined,
      }),
    });
    if (window._tomographQuickLabel) window._tomographQuickLabel = null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error(`server returned ${r.status} ${ct || 'no content-type'}`);
    }
    const out = await r.json();
    if (!out.ok) throw new Error(out.error || 'MCP draft failed');
    draftMcpState.lastResult = out;

    statusEl.textContent = `connected · ${out.summary.discovered.backends} backend(s) · ${out.tookMs}ms`;
    statusEl.className = 'home-mcp-status is-ok';

    renderHomeMcpCapabilities(out, capEl);
    capEl.hidden = false;
    adoptBar.hidden = false;

    const hint = $('#home-mcp-adopt-hint');
    if (hint) hint.textContent = out.canonical?.metadata?.name
      ? `pack name: ${out.canonical.metadata.name}` : '';

    $('#home-mcp-adopt').onclick = () => adoptDraftFromMcpResult();
  } catch (e) {
    statusEl.textContent = `error: ${e.message}`;
    statusEl.className = 'home-mcp-status is-error';
  } finally {
    goBtn.disabled = false;
  }
}

function renderHomeMcpCapabilities(out, host) {
  const s = out.summary?.discovered || {};
  const ann = out.annotations || {};
  const tools = (ann['mcp.toolsCalled'] || '').split(',').filter(Boolean);
  const failed = (ann['mcp.toolsFailed'] || '').split(',').filter(Boolean);
  const services = (ann['mcp.servicesDiscovered'] || '').split(',').filter(Boolean);
  const baselines = parseInt(ann['mcp.baselinesComputed'] || '0', 10);
  const anomalies = parseInt(ann['mcp.activeAnomalies'] || '0', 10);
  const backends = s.backends ?? 0;

  // tools/list inventory: the full set of tools the MCP advertised, and the
  // subset Tomograph doesn't yet have a probe pattern for. These come from
  // the post-rename fetcher that calls `tools/list` instead of guessing.
  const toolsExposed   = (ann['mcp.toolsExposed']   || '').split(',').filter(Boolean);
  const toolsUnmatched = (ann['mcp.toolsUnmatched'] || '').split(',').filter(Boolean);

  // backend_capabilities inventory: the canonical skill → backend →
  // product → version matrix the MCP exposes. When present, render the
  // full version-gating story below the 4-card grid so the user sees
  // EVERYTHING their MCP can speak to before drafting a pack.
  const capabilities = out.summary?.capabilities || null;

  // Live version captures — authoritative version strings pulled from
  // grafana_health / metrics_query vm_app_version etc. Threaded into
  // the capability chips so the demo audience sees ground truth, not
  // just the policy band.
  const liveVersions = {};
  for (const [k, v] of Object.entries(ann)) {
    const m = /^mcp\.versions\.([a-z0-9_-]+)$/.exec(k);
    if (m) liveVersions[m[1]] = v;
  }

  // Recognised vs unrecognised tools (over what we CALLED, not what was
  // advertised). Tracks the canonical otel-mcp-server tool catalog
  // (metrics_*, grafana_*, alertmanager_*, pipeline_*) plus the generic
  // system + zk-proof tools.
  const knownTools = new Set([
    // generic / system
    'system_health', 'system_topology',
    'anomalies_active', 'anomalies_baselines',
    // zk-proofs skill
    'zk_proof_get', 'zk_proof_verify', 'zk_solvency', 'zk_stats',
    // metrics skill (Prometheus)
    'metrics_query', 'metrics_query_range', 'metrics_targets',
    'metrics_alerts', 'metrics_metadata', 'metrics_label_values',
    // grafana skill
    'grafana_health', 'grafana_datasources', 'grafana_datasource_health',
    'grafana_datasource_query', 'grafana_dashboards_search',
    'grafana_dashboard_get', 'grafana_folders', 'grafana_alert_rules',
    'grafana_alerts', 'grafana_contact_points',
    // alertmanager skill
    'alertmanager_alerts', 'alertmanager_groups', 'alertmanager_silences',
    'alertmanager_status',
    // pipeline skill
    'pipeline_alloy', 'pipeline_beats', 'pipeline_fluentbit', 'pipeline_vector',
  ]);
  const recognised   = tools.filter(t => knownTools.has(t));
  const unrecognised = tools.filter(t => !knownTools.has(t));
  const mcpHost = (() => {
    try { return new URL(out.summary?.mcpUrl || '').host || 'mcp'; }
    catch (_) { return 'mcp'; }
  })();

  // Four-card grid: each capability owns its own card with detail
  // content inside. Connection status sits above as a pulse-dot line.
  // Styling kept from the premium pass (subtle borders, serif numbers,
  // ink-tone accents) but the per-card content is back so the user can
  // SEE which tools were called, which services were discovered, etc.
  host.innerHTML = `
    <div class="home-mcp-report">
      <div class="home-mcp-report-head">
        <span class="home-mcp-report-dot" aria-hidden="true"></span>
        Connected to <strong>${escapeHtml(mcpHost)}</strong>${out.tookMs ? ` <span class="home-mcp-report-meta">· ${out.tookMs}ms</span>` : ''}
      </div>
      <div class="home-mcp-cap-grid">
        <div class="home-mcp-cap" data-cap="tools">
          <div class="home-mcp-cap-num">${toolsExposed.length || tools.length}</div>
          <div class="home-mcp-cap-key">${toolsExposed.length ? 'tools exposed' : 'tools called'}</div>
          <div class="home-mcp-cap-detail">${recognised.length ? recognised.map(t => `<code>${escapeHtml(t)}</code>`).join(' ') : '<em>none recognised</em>'}</div>
          ${toolsUnmatched.length ? `<div class="home-mcp-cap-detail home-mcp-cap-detail-unknown">+${toolsUnmatched.length} not yet probed: ${toolsUnmatched.slice(0, 8).map(t => `<code>${escapeHtml(t)}</code>`).join(' ')}${toolsUnmatched.length > 8 ? ` <em>+${toolsUnmatched.length - 8} more</em>` : ''}</div>` : ''}
          ${unrecognised.length && !toolsUnmatched.length ? `<div class="home-mcp-cap-detail home-mcp-cap-detail-unknown">+${unrecognised.length} unrecognised: ${unrecognised.map(t => `<code>${escapeHtml(t)}</code>`).join(' ')}</div>` : ''}
          ${failed.length ? `<div class="home-mcp-cap-detail home-mcp-cap-detail-fail">⚠ failed: ${failed.map(t => `<code>${escapeHtml(t)}</code>`).join(' ')}</div>` : ''}
        </div>
        <div class="home-mcp-cap" data-cap="services">
          <div class="home-mcp-cap-num">${services.length}</div>
          <div class="home-mcp-cap-key">services discovered</div>
          <div class="home-mcp-cap-detail">${services.length ? services.slice(0, 6).map(s => `<code>${escapeHtml(s)}</code>`).join(' ') + (services.length > 6 ? `<div class="home-mcp-cap-more">+${services.length - 6} more</div>` : '') : '<em>none</em>'}</div>
        </div>
        <div class="home-mcp-cap" data-cap="backends">
          <div class="home-mcp-cap-num">${backends}</div>
          <div class="home-mcp-cap-key">backends inferred</div>
          <div class="home-mcp-cap-detail">${backends ? 'metrics / logs / traces<div class="home-mcp-cap-meta">pipelines inferred from topology</div>' : '<em>none observed</em>'}</div>
        </div>
        <div class="home-mcp-cap" data-cap="anomalies">
          <div class="home-mcp-cap-num">${anomalies}</div>
          <div class="home-mcp-cap-key">active anomalies</div>
          <div class="home-mcp-cap-detail">${baselines} baseline${baselines === 1 ? '' : 's'} computed<div class="home-mcp-cap-meta">from recent telemetry</div></div>
        </div>
      </div>
      ${renderCapabilitiesPanel(capabilities, liveVersions)}
      ${out.summary?.warnings?.length ? `
        <div class="home-mcp-gaps">
          <div class="home-mcp-gaps-head">⚠ Honest gaps</div>
          <ul>${out.summary.warnings.slice(0, 5).map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
        </div>` : ''}
    </div>
  `;
}

// Render the skill → backend → product → version matrix the MCP
// exposes via `backend_capabilities`. The signal-class skills
// (metrics/logs/traces/profiles + alerting/dashboards) lead because
// they're what drive Tomograph's L1–L4 projection; the rest follow
// in a compact tail.
//
// When `liveVersions` carries an authoritative live version for a
// product (e.g. {grafana: "12.4.0", victoriametrics: "v1.113.0"} from
// grafana_health + metrics_query), the chip flips to "live mode": the
// live version is shown in bold instead of the policy must[0], and a
// "● LIVE" indicator hangs off the chip so the audience can see at a
// glance which versions are attested vs which are inferred from
// capabilities.
function renderCapabilitiesPanel(capabilities, liveVersions = {}) {
  if (!capabilities || !Array.isArray(capabilities.inventory) || !capabilities.inventory.length) return '';

  // The spec's Signal enum order — used to group + sort entries.
  const SIGNAL_SKILLS = ['metrics', 'logs', 'traces', 'pyroscope', 'alertmanager', 'grafana'];
  const grouped = new Map();
  for (const row of capabilities.inventory) {
    if (!grouped.has(row.skill)) grouped.set(row.skill, []);
    grouped.get(row.skill).push(row);
  }
  const orderedSkills = [
    ...SIGNAL_SKILLS.filter(s => grouped.has(s)),
    ...[...grouped.keys()].filter(s => !SIGNAL_SKILLS.includes(s)).sort(),
  ];

  const liveCount = Object.keys(liveVersions).length;

  const rows = orderedSkills.map(skill => {
    const backends = grouped.get(skill);
    const chips = backends.map(b => {
      const product = b.product || b.backend;
      // `liveVersions[product]` carries either a real version string
      // (e.g. "12.4.0") OR the sentinel "live" when the backend
      // responded to a probe but doesn't expose a readable version
      // (Jaeger via traces_services). Both flip the chip to live mode.
      const live = liveVersions[product];
      const policyVer = (b.versions?.must || [])[0] || '';
      const isLive = !!live;
      // When the capture has a real version, show it. When it's the
      // "live" sentinel, keep showing the policy version (jaeger 2.x)
      // because that's the only number we have — but still mark it
      // ● LIVE so the user knows the backend itself is responding.
      const isAliveSentinel = isLive && live === 'live';
      const ver = isAliveSentinel ? policyVer : (isLive ? live : policyVer);
      const liveTooltip = !isLive ? '' :
        (isAliveSentinel
          ? ` · live=responding (version not exposed)`
          : ` · live=${live}`);
      return `<span class="home-mcp-skill-chip${isLive ? ' is-live' : ''}" title="${escapeHtml(b.backend)} · must=${escapeHtml((b.versions?.must||[]).join(','))}${liveTooltip}">
        <strong>${escapeHtml(product)}</strong>${ver ? ` <em>${escapeHtml(ver)}</em>` : ''}${isLive ? `<span class="home-mcp-skill-chip-live" aria-label="live version">●&nbsp;LIVE</span>` : ''}
      </span>`;
    }).join('');
    return `
      <div class="home-mcp-skill-row" data-skill="${escapeHtml(skill)}">
        <div class="home-mcp-skill-name">${escapeHtml(skill)}</div>
        <div class="home-mcp-skill-chips">${chips}</div>
      </div>
    `;
  }).join('');

  const liveSummary = liveCount
    ? ` · <span class="home-mcp-skills-meta-live">${liveCount} live version${liveCount === 1 ? '' : 's'}</span>`
    : '';

  return `
    <div class="home-mcp-skills">
      <div class="home-mcp-skills-head">
        <div class="home-mcp-skills-title">
          Backend capabilities
          <span class="home-mcp-skills-meta">
            ${capabilities.skillCount} skill${capabilities.skillCount === 1 ? '' : 's'}
            · ${capabilities.backendCount} backend${capabilities.backendCount === 1 ? '' : 's'}
            · gating <code>${escapeHtml(capabilities.gatingMode)}</code>${liveSummary}
          </span>
        </div>
        <div class="home-mcp-skills-sub">From <code>backend_capabilities</code> — every skill the MCP can speak to, the products it implements, and the version policy it enforces. <strong>LIVE</strong> chips carry an authoritative version captured from the backend itself.</div>
      </div>
      <div class="home-mcp-skills-body">${rows}</div>
    </div>
  `;
}

async function loadAndCacheExamples() {
  if (state._examplesCache?.length) return state._examplesCache;
  try {
    const r = await api('/api/examples');
    state._examplesCache = r.examples || [];
    // Re-render the Pack B picker so the newly available options appear.
    renderPackBSelect();
  } catch (_) { state._examplesCache = []; }
  return state._examplesCache;
}

// Catalogue reference packs (Kafka / Prometheus / Grafana) — fetched once
// and cached. They power the Advanced → References view (reference
// component analysis) and stay available as Pack B options so the
// benchmark CTA can load them for comparison.
async function loadAndCacheReferences() {
  if (state._referencesCache?.length) return state._referencesCache;
  try {
    const r = await api('/api/references');
    state._referencesCache = r.references || [];
    renderPackBSelect();
  } catch (_) { state._referencesCache = []; }
  return state._referencesCache;
}

// loadAndRenderHomeExamples + openExampleAsPack lived here until the
// home-screen redesign — they powered the "Browse archived reference
// packs" disclosure. Dropped now that the home screen is just the
// drop-zone affordance + 3 input buttons; example packs are still
// reachable as Pack B options (loadAndCacheExamples populates them in
// the picker) but no longer surface on the empty start screen.

$('#drawer-close').onclick   = () => closeDrawer('b');
$('#drawer-a-close').onclick = () => closeDrawer('a');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeMcpPanel(); } });

// ---------- MCP refresh panel ----------

const MCP_STALE_HOURS = 1;

async function loadLiveStatus() {
  try { return await api('/api/live-status'); }
  catch { return { present: false }; }
}

function fmtRelative(iso) {
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

function renderMcpBadge(status) {
  const btn = $('#mcp-btn');
  const ageEl = $('#mcp-btn-age');
  if (!btn || !ageEl) return;
  if (!status?.present) {
    btn.dataset.mcpState = 'idle';
    ageEl.textContent = 'idle';
    btn.title = 'No live pack yet — open to refresh from MCP';
    return;
  }
  const stale = status.refreshedAt && (Date.now() - Date.parse(status.refreshedAt) > MCP_STALE_HOURS * 3600_000);
  const errored = (status.toolsFailed || '').trim() !== '';
  btn.dataset.mcpState = errored ? 'error' : stale ? 'stale' : 'fresh';
  ageEl.textContent = fmtRelative(status.refreshedAt) || '—';
  btn.title = errored
    ? `MCP refresh had errors (${status.toolsFailed})`
    : `Last refresh ${fmtRelative(status.refreshedAt)} from ${status.url || 'unknown'}`;
}

function renderMcpStatusBody(status) {
  const el = $('#mcp-status-body');
  if (!el) return;
  if (!status?.present) {
    el.innerHTML = '<em>No production-live pack on disk yet.</em>';
    return;
  }
  const rows = [
    ['refreshed',  status.refreshedAt ? `${fmtRelative(status.refreshedAt)} (${escapeHtml(status.refreshedAt)})` : '—'],
    ['mcp url',    status.url || '—'],
    ['tools called',  status.toolsCalled || '—'],
    ['tools failed',  status.toolsFailed || 'none'],
    ['services',   status.servicesDiscovered || '—'],
    ['baselines',  status.baselinesComputed || '0'],
    ['anomalies',  status.activeAnomalies   || '0'],
  ];
  el.innerHTML = '<dl>' + rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${k === 'refreshed' ? v : escapeHtml(v)}</dd>`).join('') + '</dl>';
}

function openMcpPanel() {
  const panel = $('#mcp-panel');
  if (!panel) return;
  panel.hidden = false;
  $('#mcp-btn').setAttribute('aria-expanded', 'true');
  const urlInput = $('#mcp-url');
  // pre-fill: saved value > server-known value > empty
  if (!urlInput.value) {
    const saved = (() => { try { return localStorage.getItem('mcpUrl'); } catch { return null; } })();
    const liveUrl = state.mcpStatus?.url || null;
    urlInput.value = saved || liveUrl || '';
  }
  urlInput.focus();
}
function closeMcpPanel() {
  const panel = $('#mcp-panel');
  if (panel) panel.hidden = true;
  const btn = $('#mcp-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

async function refreshLive() {
  const url = $('#mcp-url').value.trim();
  const auth = $('#mcp-auth').value;
  if (!url) {
    setRefreshStatus('mcp url required', 'error');
    return;
  }
  try { localStorage.setItem('mcpUrl', url); } catch (_) {}
  const btn = $('#mcp-refresh-btn');
  btn.disabled = true;
  $('#mcp-btn').dataset.mcpState = 'active';
  setRefreshStatus('contacting mcp…');
  try {
    const r = await fetch('/api/refresh-live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpUrl: url, mcpAuth: auth || undefined }),
    });
    // Read as text first so we can surface a useful error if the server
    // returned HTML (typical when the dev server is stale and the route
    // doesn't exist yet — Express's default 404 is HTML).
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    let body;
    if (!ct.includes('application/json')) {
      const hint = r.status === 404
        ? 'server returned 404 — does it have /api/refresh-live? Restart `npm run dev`.'
        : `server returned ${r.status} ${ct || 'no content-type'}`;
      setRefreshStatus(`error: ${hint}`, 'error');
      $('#mcp-btn').dataset.mcpState = 'error';
      console.error('[refresh-live] non-JSON response:', raw.slice(0, 400));
      return;
    }
    try { body = JSON.parse(raw); }
    catch (e) {
      setRefreshStatus(`error: malformed JSON response (${e.message})`, 'error');
      $('#mcp-btn').dataset.mcpState = 'error';
      console.error('[refresh-live] bad JSON:', raw.slice(0, 400));
      return;
    }
    if (!body.ok) {
      setRefreshStatus(`error: ${body.error || 'unknown'}`, 'error');
      $('#mcp-btn').dataset.mcpState = 'error';
      return;
    }
    setRefreshStatus(`refreshed · ${fmtRelative(body.refreshedAt)}`, 'ok');
    // Replace live status from response annotations + refetch authoritative status
    state.mcpStatus = await loadLiveStatus();
    renderMcpBadge(state.mcpStatus);
    renderMcpStatusBody(state.mcpStatus);
    toast('Live pack refreshed');
    // If the user is currently viewing production-live, reload it so the
    // adapter projection updates.
    if (state.selectedPackId === 'production-live') {
      await refresh();
    } else {
      // Refresh the catalog so the production-live entry's ok-state updates.
      await loadCatalog();
      renderPackSelect();
    renderPackBSelect();
    }
  } catch (e) {
    setRefreshStatus(`error: ${e.message}`, 'error');
    $('#mcp-btn').dataset.mcpState = 'error';
  } finally {
    btn.disabled = false;
  }
}

function setRefreshStatus(msg, kind = '') {
  const el = $('#mcp-refresh-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
}

// ============================================================
// Crawler panel — Path A of pack creation.
//
// Engineer drops a service repo (or picks files) → studio reads them
// in the browser → POSTs to /api/crawl → server returns a draft
// canonical pack + validation + conformance → we render the review.
// "Use this pack" hands the draft to the existing upload flow so it
// loads into the active session just like any other pack.
// ============================================================

const CRAWL_SCAN_EXT = /\.(ya?ml|json)$/i;
const CRAWL_IGNORE_DIRS = new Set([
  '.git', '.github', '.gitlab', '.circleci',     // CI and version control
  'node_modules', 'vendor', 'venv', '.venv',
  'dist', 'build', 'out', 'target', '.cache',
  '.next', '.nuxt', '.svelte-kit',
  '.terraform', '.serverless',
  '__pycache__', '.pytest_cache', '.mypy_cache',
  '.idea', '.vscode',
  'coverage',
]);
const CRAWL_MAX_FILE_BYTES = 5 * 1024 * 1024;
const CRAWL_PAYLOAD_SOFT_CAP = 15 * 1024 * 1024;  // leave 1 MB headroom under the 16 MB server cap

// Lazy-loaded reference to the shared crawler library (also used by
// the CLI and server). Importing it here lets us classify files in the
// browser BEFORE posting — keeping payloads small and the user honest
// about what's being sent.
let _crawlerLib = null;
async function getCrawlerLib() {
  if (!_crawlerLib) _crawlerLib = await import('/lib/crawler.mjs');
  return _crawlerLib;
}

const crawlState = {
  files: new Map(),       // relPath → string content (ALL staged files)
  classified: new Map(),  // relPath → kind (only files that match an artefact)
  skipped: [],            // [{relPath, reason}] for the "what was skipped" disclosure
  rootName: null,
  lastResult: null,
};

function setupCrawlPanel() {
  const btn = $('#crawl-btn');
  if (!btn) return;
  const panel = $('#crawl-panel');
  const dropzone = $('#crawl-dropzone');
  const pickFilesBtn = $('#crawl-pick-files-btn');
  const pickFolderBtn = $('#crawl-pick-folder-btn');
  const goBtn = $('#crawl-go-btn');
  const resetBtn = $('#crawl-reset-btn');
  const closeBtn = $('#crawl-panel-close');
  const resultCloseBtn = $('#crawl-result-close');
  const adoptBtn = $('#crawl-adopt-btn');
  const folderInput = $('#crawl-file-input');
  // We add a separate non-webkitdirectory input lazily for "pick files".
  let multiInput = null;

  btn.onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) $('#crawl-name')?.focus(); };
  closeBtn.onclick = () => { panel.hidden = true; };
  resultCloseBtn.onclick = () => { $('#crawl-result').hidden = true; };
  resetBtn.onclick = () => { resetCrawlStaged(); };

  pickFolderBtn.onclick = () => folderInput.click();
  pickFilesBtn.onclick = () => {
    if (!multiInput) {
      multiInput = document.createElement('input');
      multiInput.type = 'file';
      multiInput.multiple = true;
      multiInput.accept = '.yaml,.yml,.json';
      multiInput.style.display = 'none';
      multiInput.addEventListener('change', () => {
        if (multiInput.files?.length) stageFileList(multiInput.files, null);
        multiInput.value = '';
      });
      document.body.appendChild(multiInput);
    }
    multiInput.click();
  };
  folderInput.onchange = () => {
    if (folderInput.files?.length) stageFileList(folderInput.files, null);
    folderInput.value = '';
  };

  // Drag-and-drop. We accept both files (FileList) and DataTransferItem
  // entries (so a directory drag works in Chromium/Edge/Firefox via
  // webkitGetAsEntry).
  ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.add('is-dragover');
  }));
  ['dragleave', 'dragend', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => {
    if (ev === 'drop') return;
    if (e.target === dropzone || !dropzone.contains(e.target)) dropzone.classList.remove('is-dragover');
  }));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove('is-dragover');
    const dt = e.dataTransfer;
    const entries = dt?.items
      ? [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean)
      : [];
    if (entries.length) {
      for (const ent of entries) await readEntry(ent, '');
      finalizeStaging();
    } else if (dt?.files?.length) {
      stageFileList(dt.files, null);
    }
  });

  goBtn.onclick = () => doCrawl();
  adoptBtn.onclick = () => adoptCrawlResult();

  // GitHub URL crawl — same modal, different source. Enables the
  // "crawl github" button as soon as the URL field has text matching
  // the owner/repo or full-URL shape.
  const githubUrl = $('#crawl-github-url');
  const githubRef = $('#crawl-github-ref');
  const githubGo  = $('#crawl-github-go-btn');
  if (githubUrl && githubGo) {
    const updateGhEnabled = () => {
      const v = (githubUrl.value || '').trim();
      githubGo.disabled = !/^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/.test(v);
    };
    githubUrl.addEventListener('input', updateGhEnabled);
    githubUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !githubGo.disabled) { e.preventDefault(); doCrawlFromGithub(); }
    });
    githubGo.onclick = () => doCrawlFromGithub();
    updateGhEnabled();
  }
}

// Read a single FileSystemEntry recursively into the staged map.
async function readEntry(entry, prefix) {
  if (!entry) return;
  if (entry.isFile) {
    if (!CRAWL_SCAN_EXT.test(entry.name)) return;
    const file = await new Promise((res, rej) => entry.file(res, rej));
    if (file.size > CRAWL_MAX_FILE_BYTES) return;
    const rel = (prefix ? `${prefix}/` : '') + entry.name;
    const text = await file.text();
    crawlState.files.set(rel, text);
    if (!crawlState.rootName) crawlState.rootName = entry.fullPath?.split('/')[1] || null;
  } else if (entry.isDirectory) {
    if (CRAWL_IGNORE_DIRS.has(entry.name)) return;
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const ent of batch) await readEntry(ent, (prefix ? `${prefix}/` : '') + entry.name);
    } while (batch.length > 0);
  }
}

async function stageFileList(fileList, _rootHint) {
  for (const f of fileList) {
    if (!CRAWL_SCAN_EXT.test(f.name)) continue;
    if (f.size > CRAWL_MAX_FILE_BYTES) continue;
    // webkitRelativePath populated when picked via webkitdirectory.
    const rel = f.webkitRelativePath || f.name;
    crawlState.files.set(rel, await f.text());
    if (!crawlState.rootName && f.webkitRelativePath) {
      crawlState.rootName = f.webkitRelativePath.split('/')[0];
    }
  }
  finalizeStaging();
}

async function finalizeStaging() {
  const list = $('#crawl-staged-files');
  const go = $('#crawl-go-btn');
  const n = crawlState.files.size;
  if (n === 0) {
    list.innerHTML = '<span class="crawl-staged-empty">nothing staged yet</span>';
    go.disabled = true;
    return;
  }
  // Run the shared classifier in the browser. Same heuristic the server
  // uses — filename hints first, content sniff for ambiguous YAML.
  list.innerHTML = '<span class="crawl-staged-empty">classifying…</span>';
  crawlState.classified.clear();
  crawlState.skipped = [];
  let lib;
  try { lib = await getCrawlerLib(); }
  catch (e) {
    list.innerHTML = `<span class="crawl-staged-empty">classifier unavailable (${escapeHtml(e.message)}); sending raw set</span>`;
    // Fallback: treat every staged file as classified so behaviour
    // degrades gracefully.
    for (const k of crawlState.files.keys()) crawlState.classified.set(k, 'unknown');
    go.disabled = false;
    return;
  }
  let totalBytes = 0;
  for (const [path, content] of crawlState.files) {
    let kind = 'unknown';
    try { kind = lib.detectArtefactKind(path, content); }
    catch (_) { kind = 'unknown'; }
    if (kind === 'unknown') {
      crawlState.skipped.push({ relPath: path, reason: 'not an observability artefact' });
      continue;
    }
    crawlState.classified.set(path, kind);
    totalBytes += content.length;
  }
  if (totalBytes > CRAWL_PAYLOAD_SOFT_CAP) {
    list.innerHTML = `<span class="crawl-staged-empty">payload too large after classification (${(totalBytes/1024/1024).toFixed(1)} MB). Reduce scope — drop a subdirectory instead.</span>`;
    go.disabled = true;
    return;
  }
  renderStagedList(totalBytes);
  go.disabled = crawlState.classified.size === 0;
  if (crawlState.rootName && !$('#crawl-name').value) $('#crawl-name').value = crawlState.rootName;
}

function renderStagedList(totalBytes) {
  const list = $('#crawl-staged-files');
  const total = crawlState.files.size;
  const classified = crawlState.classified.size;
  const skipped = crawlState.skipped.length;

  // Group classified by kind for a count-by-kind line.
  const byKind = {};
  for (const k of crawlState.classified.values()) byKind[k] = (byKind[k] || 0) + 1;
  const kindCounts = Object.entries(byKind).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<strong>${n}</strong>&nbsp;${escapeHtml(k)}`).join(' · ');

  const sample = [...crawlState.classified.keys()].slice(0, 8);
  const sampleHtml = sample.length
    ? sample.map(p => `<code>${escapeHtml(p)}</code>`).join('  ·  ')
    + (classified > sample.length ? ` <em>… and ${classified - sample.length} more</em>` : '')
    : '<em>nothing matched — drop a folder with docker-compose, Prometheus rules, Grafana dashboards, etc.</em>';

  list.innerHTML = `
    <div class="crawl-staged-counts">
      <strong>${classified}</strong> observability artefact${classified === 1 ? '' : 's'} found
      from <strong>${total}</strong> staged file${total === 1 ? '' : 's'}
      ${crawlState.rootName ? ` (root <code>${escapeHtml(crawlState.rootName)}/</code>)` : ''}.
      ${totalBytes ? `<span class="crawl-staged-bytes">${(totalBytes/1024).toFixed(1)} KB will be sent.</span>` : ''}
    </div>
    ${kindCounts ? `<div class="crawl-staged-kinds">${kindCounts}</div>` : ''}
    <div class="crawl-staged-sample">${sampleHtml}</div>
    ${skipped ? `
      <details class="crawl-staged-skipped">
        <summary>${skipped} file${skipped === 1 ? '' : 's'} skipped — not an observability artefact</summary>
        <div class="crawl-skipped-list">${
          crawlState.skipped.slice(0, 40)
            .map(s => `<code>${escapeHtml(s.relPath)}</code>`).join('  ·  ')
          + (skipped > 40 ? ` <em>… and ${skipped - 40} more</em>` : '')
        }</div>
      </details>` : ''}
  `;
}

function resetCrawlStaged() {
  crawlState.files.clear();
  crawlState.classified.clear();
  crawlState.skipped = [];
  crawlState.rootName = null;
  crawlState.lastResult = null;
  finalizeStaging();
  $('#crawl-result').hidden = true;
  $('#crawl-status').textContent = '';
}

async function doCrawl() {
  const statusEl = $('#crawl-status');
  const setStatus = (msg, kind) => {
    statusEl.textContent = msg;
    statusEl.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
  };
  if (crawlState.classified.size === 0) {
    if (crawlState.files.size > 0) setStatus('no observability artefacts in the staged set; nothing to scan', 'error');
    else setStatus('drop a folder or pick files first', 'error');
    return;
  }

  // Only send the classified subset. This is the key change — even when
  // the user drops a 3000-file repo, we transmit just the few
  // observability artefacts the crawler will actually use.
  const files = {};
  for (const k of crawlState.classified.keys()) {
    files[k] = crawlState.files.get(k);
  }

  const body = {
    files,
    repoName:   $('#crawl-name').value.trim() || crawlState.rootName || 'crawled-service',
    environment:$('#crawl-env').value.trim() || 'prod',
  };
  const crit = $('#crawl-criticality').value;
  if (crit) body.criticality = crit;

  const goBtn = $('#crawl-go-btn');
  goBtn.disabled = true;
  setStatus(`scanning ${crawlState.classified.size} artefact${crawlState.classified.size === 1 ? '' : 's'}…`);

  try {
    const r = await fetch('/api/crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    if (!ct.includes('application/json')) {
      setStatus(`server returned ${r.status} ${ct || 'no content-type'} — restart \`npm run dev\` if you just changed server code`, 'error');
      return;
    }
    const out = JSON.parse(raw);
    if (!out.ok) { setStatus(`error: ${out.error || 'unknown'}`, 'error'); return; }
    crawlState.lastResult = out;
    renderCrawlResult(out);
    setStatus(`done in ${out.tookMs}ms · ${out.summary.files.classified}/${out.summary.files.scanned} files classified`, 'ok');
  } catch (e) {
    setStatus(`error: ${e.message}`, 'error');
  } finally {
    goBtn.disabled = false;
  }
}

// GitHub URL variant of doCrawl(). Posts to /api/crawl-github which
// downloads the relevant files server-side and feeds them into the
// same crawler pipeline.
async function doCrawlFromGithub() {
  const ghStatus = $('#crawl-github-status');
  const setGhStatus = (msg, kind) => {
    if (!ghStatus) return;
    ghStatus.textContent = msg;
    ghStatus.className = 'crawl-github-status' + (kind ? ' is-' + kind : '');
  };
  const url = $('#crawl-github-url')?.value?.trim();
  if (!url) return setGhStatus('paste a github URL first', 'error');

  const ref = $('#crawl-github-ref')?.value?.trim() || undefined;
  const body = {
    url,
    ref,
    repoName:   $('#crawl-name').value.trim() || undefined,  // server falls back to owner/repo
    environment:$('#crawl-env').value.trim() || 'prod',
    // Quick-start cases pass a friendly label via the global so the
    // picker doesn't read "moebiusx-krystalinex" but the human name.
    label:      window._tomographQuickLabel || undefined,
  };
  if (window._tomographQuickLabel) window._tomographQuickLabel = null;
  const crit = $('#crawl-criticality').value;
  if (crit) body.criticality = crit;

  const goBtn = $('#crawl-github-go-btn');
  goBtn.disabled = true;
  setGhStatus(`fetching ${url}…`);
  try {
    const r = await fetch('/api/crawl-github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    if (!ct.includes('application/json')) {
      setGhStatus(`server returned ${r.status} ${ct || 'no content-type'} — restart \`npm run dev\` if you just changed server code`, 'error');
      return;
    }
    const out = JSON.parse(raw);
    if (!out.ok) {
      const hint = out.hint ? ` · ${out.hint}` : '';
      setGhStatus(`error: ${out.error || 'unknown'}${hint}`, 'error');
      return;
    }
    crawlState.lastResult = out;
    renderCrawlResult(out);
    if (out.canonical) {
      setGhStatus(`done in ${out.tookMs}ms · ${out.summary?.files?.classified ?? 0} files classified from ${out.summary?.repo}@${out.summary?.ref}`, 'ok');
    } else {
      setGhStatus(`done in ${out.tookMs}ms · no observability artefacts found in this repo`, 'warn');
    }
  } catch (e) {
    setGhStatus(`error: ${e.message}`, 'error');
  } finally {
    goBtn.disabled = false;
  }
}

function renderCrawlResult(out) {
  const resBox = $('#crawl-result');
  resBox.hidden = false;

  $('#crawl-result-sub').textContent =
    `${out.canonical.metadata.name} · ${out.canonical.metadata.bindings.criticality} (inferred ${out.summary.inferred.tier})`;
  $('#crawl-result-yaml').textContent = out.canonicalYaml;

  // Validation
  const vBox = $('#crawl-result-validation');
  vBox.innerHTML = `
    <h4>schema validation</h4>
    ${out.validation.ok
      ? `<div class="crawl-pill crawl-pill-ok">✓ valid v1.2</div>`
      : `<div class="crawl-pill crawl-pill-err">✗ ${out.validation.errors.length} schema error(s)</div>
         <ul class="crawl-result-errs">${out.validation.errors.slice(0, 8).map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`}
  `;

  // Discovery summary
  const s = out.summary.discovered;
  $('#crawl-result-summary').innerHTML = `
    <h4>what we found</h4>
    <table class="crawl-summary-table">
      <tr><td>backends</td><td>${s.backends}</td></tr>
      <tr><td>recording rules</td><td>${s.recordingRules}</td></tr>
      <tr><td>burn-rate alerts</td><td>${s.burnRateAlerts}</td></tr>
      <tr><td>dashboards</td><td>${s.dashboards}</td></tr>
      <tr><td>alerting routes</td><td>${s.alertingRoutes}</td></tr>
      <tr><td>pipelines</td><td>${s.pipelines}</td></tr>
    </table>
    <div class="crawl-inferred">
      <em>inferred</em>: ${out.summary.inferred.slis} SLI(s) · ${out.summary.inferred.slos} SLO(s) · tier ${out.summary.inferred.tier}
    </div>
  `;

  // Warnings — these are the bits we stubbed.
  const w = out.summary.warnings || [];
  $('#crawl-result-warnings').innerHTML = w.length
    ? `<h4>what to refine</h4><ul class="crawl-warnings">${w.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    : `<h4>what to refine</h4><div class="crawl-pill crawl-pill-ok">nothing flagged — review the YAML and ship</div>`;

  // Evidence
  const ev = out.evidence || {};
  const evEntries = Object.entries(ev).slice(0, 12);
  $('#crawl-result-evidence').innerHTML = evEntries.length
    ? `<h4>evidence (top ${evEntries.length})</h4><ul class="crawl-evidence">${evEntries.map(([id, path]) => `<li><code>${escapeHtml(id)}</code> ← <code>${escapeHtml(path)}</code></li>`).join('')}</ul>`
    : '';

  // Download link
  const dl = $('#crawl-download-btn');
  const blob = new Blob([out.canonicalYaml], { type: 'application/x-yaml' });
  if (dl.href.startsWith('blob:')) URL.revokeObjectURL(dl.href);
  dl.href = URL.createObjectURL(blob);
  dl.download = `${out.canonical.metadata.name}.pack.yaml`;
}

// Shared adoption for the two pack-creation paths — Path A (repo scan)
// and Path B (live MCP draft). Routes the new pack into the canonical
// drift journey instead of blindly overwriting Pack A:
//
//   • repo scans prefer slot A ("declared"), live drafts prefer slot B
//     ("verified") — so "scan a repo, then scan the live deployment"
//     lands you straight in the Diagnose / drift compare view.
//   • whichever slot is empty gets filled; as soon as BOTH are present
//     we auto-switch to compare. With only one pack we stay in
//     single-pack Discover.
//   • re-running the same path while comparing replaces just that slot
//     (a fresh repo scan refreshes A and keeps the live B, and vice
//     versa) so the drift view stays put.
//
// kind ∈ {'repo','live'}. Returns true when it entered compare.
async function adoptValidatedPack(res, sourceLabel, kind) {
  state.pack = res.adapted;
  state.conformance = res.conformance;
  state.symbolTable = buildSymbolTable(res.adapted);
  state.uploadedSource = sourceLabel;
  state.activeCardKey = null;

  const newId = res.registered?.id;
  if (!newId) {
    // No server id (shouldn't normally happen) — render the adapted
    // pack inline as a single, unaddressable view.
    state.selectedPackId = null;
    state.mode = 'single';
    state.view = 'layers';
    state.activeLayer = 'L1';
    applyModeChrome();
    renderPackSelect();
    renderPackBSelect();
    renderEnvSelect();
    renderMeta();
    renderTabs();
    renderMainView();
    return false;
  }

  await loadCatalog();

  const prevA = state.selectedPackId;
  const prevB = state.compareBId;
  const wasCompare = state.mode === 'compare' && prevA && prevB;

  let aId = null, bId = null;
  if (wasCompare && (newId === prevA || newId === prevB)) {
    // Re-adopted a pack already on screen — keep the existing pairing.
    aId = prevA; bId = prevB;
  } else if (wasCompare) {
    // Already comparing — replace the slot matching this path's kind,
    // keep the other half of the drift view intact.
    if (kind === 'repo') { aId = newId; bId = prevB; }
    else                 { aId = prevA; bId = newId; }
  } else if (prevA && state.mode !== 'home' && prevA !== newId) {
    // One pack already loaded — pair it with the new one. Repo → A,
    // live → B; the existing pack takes the other slot.
    if (kind === 'repo') { aId = newId; bId = prevA; }
    else                 { aId = prevA; bId = newId; }
  } else {
    // Empty start (or re-adopting the only pack) — single Discover.
    aId = newId; bId = null;
  }

  if (aId && bId && aId !== bId) {
    state.view = 'compare';
    enterCompareMode(aId, defaultEnvFor(aId), bId, defaultEnvFor(bId));
    return true;
  }
  state.view = 'layers';
  enterAnalyzeMode(aId, defaultEnvFor(aId));
  return false;
}

async function adoptCrawlResult() {
  const out = crawlState.lastResult;
  if (!out) return;
  // Reuse the upload flow: POST /api/validate → if ok, route the pack
  // into the drift journey (repo scan → Pack A). Same validation path
  // as drag-dropping a yaml file onto the studio shell.
  try {
    const res = await validateUploaded(out.canonicalYaml, 'application/x-yaml', state.selectedEnv);
    if (!res.ok) {
      toast(`Could not adopt — ${res.errors.length} validation error(s)`, 'error');
      return;
    }
    $('#crawl-panel').hidden = true;
    const compared = await adoptValidatedPack(res, `${out.canonical.metadata.name} (scanned draft)`, 'repo');
    toast(compared
      ? `Comparing ${out.canonical.metadata.name} against the live deployment`
      : `Loaded scanned draft for ${out.canonical.metadata.name}`);
  } catch (e) {
    toast(`Adopt failed: ${e.message}`, 'error');
  }
}

// ============================================================
// Draft-from-MCP panel — Path B of pack creation.
//
// Parallel to the crawler (Path A). The SRE enters their MCP URL,
// optionally an auth token, and a pack name; the server hits the
// MCP, builds a canonical pack from what the MCP can attest to, and
// returns it for review. Adoption round-trips through /api/validate
// like every other pack path.
// ============================================================

const draftMcpState = {
  lastResult: null,
};

// ============================================================
// Deploy modal — full per-artefact picker. Replaces the inline
// deploy panel that used to live below the compile output.
//
// Drives off /api/packs/:id/compile-catalog to enumerate every
// individually deployable artefact in the active pack, surfaces a
// type-filter row (Alert rule / Recording rule / Dashboard) +
// per-row checkboxes, and POSTs to /api/packs/:id/deploy-bulk
// with the selected items.
// ============================================================

const DEPLOY_PROFILES_KEY = 'deployProfiles.v1';

const deployModalState = {
  manifest: null,        // [{id, type, name, group, flavor, artifact, dashboardId, scope}]
  packId: null,
  selected: new Set(),
  presetIdentities: null,  // Set<string> from Remediate plan, or null
  inflight: false,
};

function setupDeployModal() {
  const modal = $('#deploy-modal');
  if (!modal) return;
  $('#deploy-modal-close').onclick   = () => closeDeployModal();
  $('#deploy-modal-cancel').onclick  = () => closeDeployModal();
  $('#deploy-modal-go').onclick      = () => doDeployBulk();

  $('#deploy-profile-save').onclick  = () => saveDeployProfile();
  $('#deploy-profile-delete').onclick = () => deleteDeployProfile();
  $('#deploy-target-profile').onchange = () => loadDeployProfile($('#deploy-target-profile').value);

  // Recompute the target summary line on any target field change.
  for (const id of ['deploy-target-profile','deploy-target-url','deploy-target-folder','deploy-target-product','deploy-target-version','deploy-target-mcp']) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input',  updateDeployTargetSummary);
    if (el) el.addEventListener('change', updateDeployTargetSummary);
  }

  // Pack picker rebuilds the manifest.
  $('#deploy-source-pack').onchange = () => loadDeployManifest($('#deploy-source-pack').value);

  // Type filter checkboxes hide rows.
  $('#deploy-type-filters').addEventListener('change', () => renderDeployManifestTable());

  // Manifest toolbar
  $('#deploy-manifest-toggle').onchange = (e) => bulkSelectVisibleManifest(e.target.checked);
  $('#deploy-manifest-all').onclick     = () => bulkSelectVisibleManifest(true);
  $('#deploy-manifest-none').onclick    = () => bulkSelectVisibleManifest(false);

  // Esc closes
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDeployModal(); });
}

function openDeployModal({ packId, packLabel, presetIdentities } = {}) {
  const modal = $('#deploy-modal');
  if (!modal) return;
  // Optional preset: when the Remediate plan hands off a curated set, pre-
  // select only the matching manifest rows (by row.id). Cleared otherwise
  // so a direct open defaults to all-deployable.
  deployModalState.presetIdentities = (presetIdentities && presetIdentities.size) ? presetIdentities : null;
  if (!state.deployMatrix) loadDeployMatrix().then(() => populateDeployTargetSelects());
  else populateDeployTargetSelects();
  populateDeploySourcePackSelect(packId || state.selectedPackId);
  populateDeployProfileSelect();
  modal.hidden = false;
  modal.focus?.();
  $('#deploy-modal-status').textContent = '';
  $('#deploy-modal-result').hidden = true;
  loadDeployManifest(packId || state.selectedPackId);
  updateDeployTargetSummary();
}

function closeDeployModal() {
  const modal = $('#deploy-modal');
  if (modal) modal.hidden = true;
}

function populateDeployTargetSelects() {
  const matrix = state.deployMatrix || { products: ['grafana'], versions: { grafana: ['12', '13'] } };
  const prodSel = $('#deploy-target-product');
  prodSel.innerHTML = matrix.products.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  prodSel.value = state.deployProduct || matrix.products[0];
  const verSel = $('#deploy-target-version');
  const versions = matrix.versions[prodSel.value] || ['12'];
  verSel.innerHTML = versions.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  verSel.value = state.deployVersion || versions[0];
}

function populateDeploySourcePackSelect(activeId) {
  const sel = $('#deploy-source-pack');
  sel.innerHTML = '';
  for (const p of (state.catalog || [])) {
    if (!p.ok) continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.label} · v${p.version || '?'}`;
    sel.appendChild(opt);
  }
  sel.value = activeId || state.selectedPackId;
}

function updateDeployTargetSummary() {
  const prof = $('#deploy-target-profile').selectedOptions?.[0]?.textContent?.trim() || '(no profile)';
  const url  = $('#deploy-target-url').value.trim() || '—';
  const prod = $('#deploy-target-product').value || '—';
  const ver  = $('#deploy-target-version').value || '—';
  $('#deploy-target-summary').textContent = `Target: ${prof}  |  ${prod} ${ver}  |  ${url}`;
}

// ----- Profiles in localStorage -----

function loadDeployProfiles() {
  try { return JSON.parse(localStorage.getItem(DEPLOY_PROFILES_KEY) || '{}'); }
  catch { return {}; }
}
function saveDeployProfiles(profiles) {
  try { localStorage.setItem(DEPLOY_PROFILES_KEY, JSON.stringify(profiles)); } catch (_) {}
}
function populateDeployProfileSelect() {
  const sel = $('#deploy-target-profile');
  const profiles = loadDeployProfiles();
  sel.innerHTML = '<option value="">(no profile — fill manually)</option>'
    + Object.keys(profiles).sort().map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
}
function loadDeployProfile(name) {
  if (!name) return;
  const p = loadDeployProfiles()[name];
  if (!p) return;
  $('#deploy-target-url').value     = p.targetUrl || '';
  $('#deploy-target-folder').value  = p.folder || '';
  $('#deploy-target-product').value = p.product || 'grafana';
  $('#deploy-target-version').value = p.version || '12';
  $('#deploy-target-mcp').value     = p.mcpUrl || '';
  updateDeployTargetSummary();
}
function saveDeployProfile() {
  const name = prompt('Profile name (e.g. "Prod Grafana"):', $('#deploy-target-profile').selectedOptions?.[0]?.value || '');
  if (!name) return;
  const profiles = loadDeployProfiles();
  profiles[name] = {
    targetUrl: $('#deploy-target-url').value.trim(),
    folder:    $('#deploy-target-folder').value.trim(),
    product:   $('#deploy-target-product').value,
    version:   $('#deploy-target-version').value,
    mcpUrl:    $('#deploy-target-mcp').value.trim(),
  };
  saveDeployProfiles(profiles);
  populateDeployProfileSelect();
  $('#deploy-target-profile').value = name;
  updateDeployTargetSummary();
  toast(`Saved deploy profile: ${name}`);
}
function deleteDeployProfile() {
  const name = $('#deploy-target-profile').value;
  if (!name) return;
  if (!confirm(`Delete deploy profile "${name}"?`)) return;
  const profiles = loadDeployProfiles();
  delete profiles[name];
  saveDeployProfiles(profiles);
  populateDeployProfileSelect();
  toast(`Deleted profile: ${name}`);
}

// ----- Manifest (per-artefact rows) -----

async function loadDeployManifest(packId) {
  deployModalState.packId = packId;
  deployModalState.selected = new Set();
  const tbody = $('#deploy-manifest-tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="placeholder">Loading manifest…</td></tr>';
  try {
    const params = new URLSearchParams();
    if (state.selectedEnv) params.set('env', state.selectedEnv);
    const cat = await api(`/api/packs/${encodeURIComponent(packId)}/compile-catalog?${params}`);
    deployModalState.manifest = catalogToManifest(cat);
    // Default-select: when a preset (from the Remediate plan) is present,
    // select only deployable rows whose id matches a preset identity; fall
    // back to all-deployable if nothing matched (safe — never deploys
    // something the user didn't intend, never silently empties the form).
    const preset = deployModalState.presetIdentities;
    let presetMatched = 0;
    for (const row of deployModalState.manifest) {
      if (!row.deployable) continue;
      if (preset) {
        if (preset.has(row.id)) { deployModalState.selected.add(row.key); presetMatched++; }
      } else {
        deployModalState.selected.add(row.key);
      }
    }
    if (preset && presetMatched === 0) {
      // No id overlap (keyspace mismatch) — fall back to all-deployable.
      for (const row of deployModalState.manifest) {
        if (row.deployable) deployModalState.selected.add(row.key);
      }
    }
    renderDeployManifestTable();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="error">Could not load manifest: ${escapeHtml(e.message)}</td></tr>`;
  }
}

// Map a compile catalog (groups → items) to a flat manifest with
// per-row deploy semantics. Rules' per-SLO items expand into separate
// recording + alerting rows so the type filter is meaningful.
function catalogToManifest(catalog) {
  const out = [];
  for (const g of (catalog.groups || [])) {
    const deployable = g.flavors?.some(f => f.deployable);
    if (g.id === 'rules') {
      // Per-SLO items: each becomes TWO rows (recording + alerting).
      // The 'all' bundle becomes one row of each flavor as well.
      for (const it of g.items) {
        if (it.kind === 'rules-slo') {
          out.push({
            key: `rules:recording:slo:${it.sloId}`,
            type: 'recording',
            name: `${it.label} (recording rules)`,
            id: it.sloId,
            group: 'rules', flavor: 'prometheus', artifact: `slo:${it.sloId}`, scope: 'recording',
            deployable, source: 'Repo',
          });
          out.push({
            key: `rules:alert:slo:${it.sloId}`,
            type: 'alert',
            name: `${it.label} (burn-rate alerts)`,
            id: it.sloId,
            group: 'rules', flavor: 'prometheus', artifact: `slo:${it.sloId}`, scope: 'alerting',
            deployable, source: 'Repo',
          });
        } else if (it.kind === 'rules-declared') {
          out.push({
            key: `rules:recording:declared:${it.ruleIndex}`,
            type: 'recording',
            name: it.label,
            id: it.ruleName || it.id,
            group: 'rules', flavor: 'prometheus', artifact: `declared:${it.ruleIndex}`, scope: 'recording',
            deployable, source: 'Repo',
          });
        }
      }
    } else if (g.id === 'dashboards') {
      for (const it of g.items) {
        if (it.kind !== 'dashboard') continue;
        out.push({
          key: `dashboards:${it.dashboardId}`,
          type: 'dashboard',
          name: it.label,
          id: it.dashboardId,
          subtitle: it.subtitle,
          group: 'dashboards', flavor: 'grafana', dashboardId: it.dashboardId,
          deployable, source: 'Repo',
        });
      }
    }
    // pipelines + alertmanager are excluded from the Grafana deploy
    // surface — they're emitted by compile but not deployable here.
  }
  return out;
}

function renderDeployManifestTable() {
  const tbody = $('#deploy-manifest-tbody');
  const types = new Set([...document.querySelectorAll('#deploy-type-filters input:checked')].map(i => i.value));
  const rows = (deployModalState.manifest || []).filter(r => types.has(r.type));
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="placeholder">No artefacts of the selected types in this pack.</td></tr>';
    updateManifestCounter(0, 0);
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr class="${deployModalState.selected.has(r.key) ? 'is-checked' : ''}" data-key="${escapeHtml(r.key)}">
      <td class="deploy-col-check"><input type="checkbox" ${deployModalState.selected.has(r.key) ? 'checked' : ''}></td>
      <td><span class="type-pill type-pill-${escapeHtml(r.type)}">${escapeHtml(r.type === 'recording' ? 'Recording rule' : r.type === 'alert' ? 'Alert rule' : 'Dashboard')}</span></td>
      <td><code>${escapeHtml(r.id)}</code></td>
      <td>${escapeHtml(r.name)}</td>
      <td><span class="source-chip" data-source="${escapeHtml(r.source)}">${escapeHtml(r.source)}</span></td>
    </tr>
  `).join('');
  // Per-row toggle
  tbody.querySelectorAll('tr').forEach(tr => {
    const cb = tr.querySelector('input[type=checkbox]');
    cb.onchange = () => {
      const k = tr.dataset.key;
      if (cb.checked) deployModalState.selected.add(k);
      else deployModalState.selected.delete(k);
      tr.classList.toggle('is-checked', cb.checked);
      updateManifestCounter(rows.filter(r => deployModalState.selected.has(r.key)).length, rows.length);
    };
  });
  updateManifestCounter(rows.filter(r => deployModalState.selected.has(r.key)).length, rows.length);
}

function bulkSelectVisibleManifest(checked) {
  const types = new Set([...document.querySelectorAll('#deploy-type-filters input:checked')].map(i => i.value));
  for (const r of (deployModalState.manifest || [])) {
    if (!types.has(r.type)) continue;
    if (checked) deployModalState.selected.add(r.key);
    else deployModalState.selected.delete(r.key);
  }
  renderDeployManifestTable();
}

function updateManifestCounter(selected, total) {
  $('#deploy-manifest-counter').textContent = `${selected} of ${total} artefact${total === 1 ? '' : 's'} selected`;
  const goBtn = $('#deploy-modal-go');
  if (goBtn) goBtn.disabled = selected === 0;
  const toggle = $('#deploy-manifest-toggle');
  if (toggle) {
    toggle.checked = total > 0 && selected === total;
    toggle.indeterminate = selected > 0 && selected < total;
  }
}

async function doDeployBulk() {
  if (deployModalState.inflight) return;
  const url  = $('#deploy-target-mcp').value.trim();
  const auth = $('#deploy-target-auth').value;
  const folder = $('#deploy-target-folder').value.trim();
  const product = $('#deploy-target-product').value;
  const version = $('#deploy-target-version').value;
  const statusEl = $('#deploy-modal-status');
  const setStatus = (msg, kind) => {
    statusEl.textContent = msg;
    statusEl.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
  };
  if (!url) { setStatus('mcp url required', 'error'); return; }
  if (deployModalState.selected.size === 0) { setStatus('select at least one artefact', 'error'); return; }

  const items = [...deployModalState.selected].map(k => {
    const row = (deployModalState.manifest || []).find(r => r.key === k);
    return row && {
      group:       row.group,
      flavor:      row.flavor,
      artifact:    row.artifact,
      dashboardId: row.dashboardId,
      scope:       row.scope,
    };
  }).filter(Boolean);

  deployModalState.inflight = true;
  const goBtn = $('#deploy-modal-go');
  goBtn.disabled = true;
  setStatus(`deploying ${items.length} artefact${items.length === 1 ? '' : 's'}…`);

  try {
    const qs = new URLSearchParams();
    if (state.selectedEnv) qs.set('env', state.selectedEnv);
    const path = `/api/packs/${encodeURIComponent(deployModalState.packId)}/deploy-bulk?${qs}`;
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcpUrl: url, mcpAuth: auth || undefined,
        targetProduct: product, targetVersion: version, targetFolder: folder || undefined,
        items,
      }),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    if (!ct.includes('application/json')) {
      setStatus(`server returned ${r.status} ${ct || 'no content-type'}`, 'error');
      return;
    }
    const body = JSON.parse(raw);
    if (body.summary) {
      const { ok, failed, total } = body.summary;
      setStatus(`${ok}/${total} deployed in ${body.tookMs}ms · ${failed} failed`, failed === 0 ? 'ok' : 'error');
    }
    renderDeployBulkResult(body);
  } catch (e) {
    setStatus(`error: ${e.message}`, 'error');
  } finally {
    deployModalState.inflight = false;
    goBtn.disabled = false;
  }
}

function renderDeployBulkResult(body) {
  const el = $('#deploy-modal-result');
  el.hidden = false;
  const rows = (body.results || []).map(r => `
    <tr class="${r.ok ? 'is-ok' : 'is-err'}">
      <td>${r.ok ? '✓' : '✗'}</td>
      <td><code>${escapeHtml(r.item?.group || '')}/${escapeHtml(r.item?.artifact || '')}</code></td>
      <td>${r.ok ? `${r.bytes || 0} b · ${r.tool || ''}` : escapeHtml(r.error || 'failed')}</td>
      <td>${r.tookMs || 0} ms</td>
    </tr>
  `).join('');
  el.innerHTML = `
    <h4>Deploy result</h4>
    <table class="deploy-result-table">
      <thead><tr><th></th><th>Artefact</th><th>Detail</th><th>Took</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function setupDraftFromMcpPanel() {
  const btn = $('#draft-mcp-btn');
  if (!btn) return;
  const panel    = $('#draft-mcp-panel');
  const closeBtn = $('#draft-mcp-panel-close');
  const goBtn    = $('#draft-mcp-go-btn');
  const resetBtn = $('#draft-mcp-reset-btn');
  const resultCloseBtn = $('#draft-mcp-result-close');
  const adoptBtn = $('#draft-mcp-adopt-btn');

  btn.onclick = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      // Pre-fill URL from the same localStorage slot the MCP refresh
      // panel uses, so the SRE doesn't have to retype.
      const urlInput = $('#draft-mcp-url');
      if (!urlInput.value) {
        try { urlInput.value = localStorage.getItem('mcpUrl') || ''; } catch (_) {}
      }
      urlInput.focus();
    }
  };
  closeBtn.onclick = () => { panel.hidden = true; };
  resultCloseBtn.onclick = () => { $('#draft-mcp-result').hidden = true; };
  resetBtn.onclick = () => {
    $('#draft-mcp-url').value = '';
    $('#draft-mcp-auth').value = '';
    $('#draft-mcp-name').value = '';
    $('#draft-mcp-result').hidden = true;
    $('#draft-mcp-status').textContent = '';
    draftMcpState.lastResult = null;
  };
  goBtn.onclick = () => doDraftFromMcp();
  adoptBtn.onclick = () => adoptDraftFromMcpResult();
}

async function doDraftFromMcp() {
  const url  = $('#draft-mcp-url').value.trim();
  const auth = $('#draft-mcp-auth').value;
  const name = $('#draft-mcp-name').value.trim();
  const statusEl = $('#draft-mcp-status');
  const setStatus = (msg, kind) => {
    statusEl.textContent = msg;
    statusEl.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
  };
  if (!url) { setStatus('mcp url required', 'error'); return; }
  try { localStorage.setItem('mcpUrl', url); } catch (_) {}

  const goBtn = $('#draft-mcp-go-btn');
  goBtn.disabled = true;
  setStatus('contacting mcp…');
  $('#draft-mcp-result').hidden = true;

  try {
    const r = await fetch('/api/draft-from-mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpUrl: url, mcpAuth: auth || undefined, packName: name || undefined }),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    if (!ct.includes('application/json')) {
      setStatus(`server returned ${r.status} ${ct || 'no content-type'} — restart \`npm run dev\` if you just changed server code`, 'error');
      return;
    }
    const out = JSON.parse(raw);
    if (!out.ok) { setStatus(`error: ${out.error || 'unknown'}`, 'error'); return; }
    draftMcpState.lastResult = out;
    renderDraftMcpResult(out);
    setStatus(`drafted in ${out.tookMs}ms · ${out.summary.discovered.backends} backend(s) discovered`, 'ok');
  } catch (e) {
    setStatus(`error: ${e.message}`, 'error');
  } finally {
    goBtn.disabled = false;
  }
}

function renderDraftMcpResult(out) {
  const resBox = $('#draft-mcp-result');
  resBox.hidden = false;

  $('#draft-mcp-result-sub').textContent =
    `${out.canonical.metadata.name} · ${out.canonical.metadata.bindings?.criticality || 'tier-3'} · MCP @ ${out.summary.mcpUrl}`;
  $('#draft-mcp-result-yaml').textContent = out.canonicalYaml;

  // Validation
  const v = out.validation;
  $('#draft-mcp-result-validation').innerHTML = `
    <h4>schema validation</h4>
    ${v.ok
      ? `<div class="crawl-pill crawl-pill-ok">✓ valid v1.2</div>`
      : `<div class="crawl-pill crawl-pill-err">✗ ${v.errors.length} schema error(s)</div>
         <ul class="crawl-result-errs">${v.errors.slice(0, 8).map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`}
  `;

  // Discovery summary — show what the MCP actually attested, not just
  // raw tool counts. Rows are present only when the value is non-zero
  // or the probe was attempted (so the SRE sees what was asked vs found).
  const d = out.summary.discovered;
  const row = (label, value, dim = false) =>
    `<tr${dim ? ' class="is-dim"' : ''}><td>${escapeHtml(label)}</td><td>${typeof value === 'number' ? value : escapeHtml(String(value))}</td></tr>`;
  const probesA = new Set(d.probesAttempted || []);
  const probesS = new Set(d.probesSucceeded || []);
  const probesE = new Set(d.probesEmpty || []);
  const probesF = new Set(d.probesFailed || []);
  // Three distinct outcomes when a probe was attempted:
  //   data     — MCP responded with real content → show count
  //   empty    — MCP responded with empty payload → "0 (none configured)"
  //              honest zero, e.g. Krystaline has no Prometheus rules
  //   failed   — every candidate errored / 503'd → "— probe failed"
  //              transient or systemic, not the same as zero
  const probeRow = (label, key, value) => {
    if (!probesA.has(key)) return '';
    if (probesS.has(key))  return row(label, value || 0);
    if (probesE.has(key))  return row(label, `0 — none configured`, true);
    if (probesF.has(key))  return row(label, '— probe failed', true);
    // Older packs (pre-Phase 5) don't have probesEmpty/probesFailed
    // annotations; fall back to the original behaviour.
    return row(label, '— probed, none found', true);
  };
  // Rule-evidence fallback rows — only shown when the primary probe
  // came back empty (or failed) but the fallback found evidence. Reads
  // directly from the annotations the fetcher stamped.
  const ann = out.annotations || {};
  const alertsFiringNames = (ann['mcp.discovered.alerts_firing.names'] || '').split(',').filter(Boolean);
  const alertsFiringCount = Number(ann['mcp.discovered.alerts_firing.count'] || 0);
  const alertsTotalFirings = Number(ann['mcp.discovered.alerts_firing.total_firings'] || 0);
  const recordingFallbackCount = Number(ann['mcp.discovered.recording_rules_via_inventory.count'] || 0);
  const evidenceRow = (label, value, hint) =>
    `<tr class="is-evidence"><td>${escapeHtml(label)}<span class="row-evidence-hint">${escapeHtml(hint)}</span></td><td>${escapeHtml(String(value))}</td></tr>`;
  const alertEvidenceRow = alertsFiringCount > 0
    ? evidenceRow(
        'alerts firing',
        `${alertsFiringCount} alertname${alertsFiringCount === 1 ? '' : 's'} · ${alertsTotalFirings} total`,
        `via ALERTS metric — rule definitions hidden, firing state visible`,
      )
    : '';
  const recordingEvidenceRow = recordingFallbackCount > 0
    ? evidenceRow(
        'recording rule outputs',
        `${recordingFallbackCount}`,
        `via colon-pattern grep over metric inventory`,
      )
    : '';
  $('#draft-mcp-result-summary').innerHTML = `
    <h4>what the MCP attested</h4>
    <table class="crawl-summary-table">
      ${row('services', (d.servicesDiscovered || []).length)}
      ${row('backends', d.backends)}
      ${row('active anomalies', d.activeAnomalies)}
      ${probeRow('recording rules', 'recording_rules', d.recordingRules)}
      ${recordingEvidenceRow}
      ${probeRow('alert rules',     'alert_rules',     d.alertRules)}
      ${alertEvidenceRow}
      ${probeRow('dashboards',      'dashboards',      d.dashboards)}
      ${probeRow('scrape jobs',     'scrape_configs',  (d.scrapeJobs || []).length)}
      ${probeRow('metric names',    'metric_names',    d.metricNamesCount)}
    </table>
    ${alertsFiringCount > 0 || recordingFallbackCount > 0 ? `
      <div class="crawl-evidence-note">
        Rows in italic = fallback evidence. The standard rule endpoints came back empty,
        but Tomograph found evidence in metric data: firing alerts via the
        <code>ALERTS</code> series, recording rules via metric names following the
        <code>&lt;ns&gt;:&lt;metric&gt;:&lt;op&gt;</code> convention.
      </div>
    ` : ''}
    <div class="crawl-inferred">
      <em>refreshed</em>: ${escapeHtml(out.summary.refreshedAt)}
    </div>
  `;

  // Warnings
  const w = out.summary.warnings || [];
  $('#draft-mcp-result-warnings').innerHTML = w.length
    ? `<h4>what to refine</h4><ul class="crawl-warnings">${w.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    : `<h4>what to refine</h4><div class="crawl-pill crawl-pill-ok">nothing flagged</div>`;

  // Tools chip
  const tools = d.toolsCalled || [];
  const fails = d.toolsFailed || [];
  $('#draft-mcp-result-tools').innerHTML = `
    <h4>mcp tools</h4>
    <div class="draft-mcp-tools">
      ${tools.map(t => `<code class="draft-mcp-tool ${fails.includes(t) ? 'is-failed' : 'is-ok'}">${escapeHtml(t)}</code>`).join(' ')}
      ${tools.length === 0 ? '<em class="crawl-staged-empty">no tools called</em>' : ''}
    </div>
  `;

  // Download link
  const dl = $('#draft-mcp-download-btn');
  const blob = new Blob([out.canonicalYaml], { type: 'application/x-yaml' });
  if (dl.href.startsWith('blob:')) URL.revokeObjectURL(dl.href);
  dl.href = URL.createObjectURL(blob);
  dl.download = `${out.canonical.metadata.name}.pack.yaml`;
}

async function adoptDraftFromMcpResult() {
  const out = draftMcpState.lastResult;
  if (!out) return;
  try {
    const res = await validateUploaded(out.canonicalYaml, 'application/x-yaml', state.selectedEnv);
    if (!res.ok) {
      toast(`Could not adopt — ${res.errors.length} validation error(s)`, 'error');
      return;
    }
    $('#draft-mcp-panel').hidden = true;
    // Live drafts are the "verified" half of the drift journey → Pack B.
    const compared = await adoptValidatedPack(res, `${out.canonical.metadata.name} (live draft)`, 'live');
    toast(compared
      ? `Comparing the repo scan against ${out.canonical.metadata.name} (live)`
      : `Loaded live draft for ${out.canonical.metadata.name}`);
  } catch (e) {
    toast(`Adopt failed: ${e.message}`, 'error');
  }
}

function setupMcpPanel() {
  const btn = $('#mcp-btn');
  if (!btn) return;
  btn.onclick = () => {
    const open = !$('#mcp-panel').hidden;
    if (open) closeMcpPanel(); else openMcpPanel();
  };
  $('#mcp-panel-close').onclick = closeMcpPanel;
  $('#mcp-refresh-btn').onclick = refreshLive;

  // Close on outside click
  document.addEventListener('click', (e) => {
    const panel = $('#mcp-panel');
    if (panel.hidden) return;
    if (e.target.closest('#mcp-panel') || e.target.closest('#mcp-btn')) return;
    closeMcpPanel();
  });
}

// ---------- theme ----------

// ---------- theme ----------
// The inline script in <head> already applied the persisted/system theme
// before paint. Here we wire the toggle and keep the studio in sync with
// the system preference if the user hasn't pinned one.

function setupTheme() {
  const btn = $('#theme-toggle');
  if (!btn) return;
  const apply = (t) => document.documentElement.setAttribute('data-theme', t);
  const current = () => document.documentElement.getAttribute('data-theme') || 'light';

  btn.onclick = () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem('studioTheme', next); } catch (_) {}
    btn.setAttribute('title', `Switch to ${next === 'dark' ? 'light' : 'dark'} mode`);
  };
  btn.setAttribute('title', `Switch to ${current() === 'dark' ? 'light' : 'dark'} mode`);

  // Follow the system preference when the user hasn't explicitly chosen.
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', (e) => {
      const explicit = localStorage.getItem('studioTheme');
      if (explicit !== 'light' && explicit !== 'dark') {
        apply(e.matches ? 'dark' : 'light');
      }
    });
  } catch (_) {}
}

// ---------- helpers ----------

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

boot();
