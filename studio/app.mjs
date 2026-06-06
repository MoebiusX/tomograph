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

const LAYER_DEFS = [
  { id: 'L1',  num: 'L1',  name: 'Contract'   },
  { id: 'L2',  num: 'L2',  name: 'Telemetry'  },
  { id: 'L2X', num: 'L2X', name: 'Extended'   },
  { id: 'L3',  num: 'L3',  name: 'Insight'    },
  { id: 'L4',  num: 'L4',  name: 'Action'     },
  { id: 'L5',  num: 'L5',  name: 'Validation' },
  { id: 'GOV', num: 'GOV', name: 'Governance' },
];

const L4_SUBGROUPS = [
  { key: 'policy',   label: 'Policy' },
  { key: 'alerting', label: 'Alerting' },
  { key: 'healing',  label: 'Self-healing' },
];

const CONFORMANCE_TAB = { id: 'CONF',    num: 'CONF', name: 'Conformance' };
const COMPILE_TAB     = { id: 'COMPILE', num: 'BLD',  name: 'Compile' };
const COMPARE_TAB     = { id: 'COMPARE', num: 'CMP',  name: 'Compare' };
const ATLAS_TAB       = { id: 'ATLAS',   num: 'ATL',  name: 'Atlas' };

const state = {
  // 'home' starts the studio empty; user picks Analyze (one pack) or
  // Compare (two packs). Once chosen, mode becomes 'single' or 'compare'
  // and the header bar + tabs appear. Logo click returns to 'home'.
  mode: 'home',
  catalog: [],
  selectedPackId: null,
  selectedEnv: null,
  pack: null,
  conformance: null,
  symbolTable: null,
  // Primary view selector (top nav). One of: layers, conformance,
  // compile, atlas, schema. Compare mode hides conformance + compile.
  view: 'layers',
  // Per-pack focus toggle (A | B). Surfaces the A|B switch on the
  // conformance / compile / schema views when both packs are loaded so
  // the user can read B's report without losing A. Resets to 'a' when
  // Pack B is cleared. Stays 'a' until the user flips it.
  viewFocus: 'a',
  // Parallel slots for Pack B — populated when the user flips focus
  // to B (or pre-fetched alongside loadPackB() so toggling is instant).
  conformanceB: null,
  compileCatalogB: null,        // mirrors compileCatalog for B
  compileGroupB: 'rules',       // mirrors compileGroup for B
  compileFlavorB: 'prometheus', // mirrors compileFlavor for B
  compileArtifactB: 'all',      // mirrors compileArtifact for B
  compileContentB: null,        // mirrors compileContent for B
  // Traceability view preferences (persisted via Direction 3). Keys are
  // `${layer}::${key}` strings — see compareKeyOf. Suppressed findings
  // are hidden from their bucket; resolved findings render as resolved.
  tracePrefs: { suppressed: [], resolved: [] },
  traceOpen: { aligned: false, declaredNotVerified: true, verifiedNotDeclared: true, stale: true },
  // Secondary layer filter chips (only visible on view='layers').
  // 'all' stacks every layer; the layer ids narrow to one.
  layerFilter: 'all',
  // Legacy: kept for back-compat with code that still reads it
  // (drawer card highlight on per-layer cards, etc.). Mirrors view.
  activeLayer: 'L1',
  activeCardKey: null,
  activeCardKeyA: null,        // side-A card highlight (compare view)
  activeCardKeyB: null,        // side-B card highlight (compare view)
  uploadedSource: null,        // set when user uploaded a pack instead of using the catalog
  compareBId: null,            // second pack id for the COMPARE view
  compareBEnv: null,
  compareSlice: 'all',         // 'all' | 'onlyA' | 'onlyB' | 'both' | 'a-b' | 'a+b'
  compareSearch: '',           // text filter applied to card id/title
  diff: null,                  // last fetched /api/diff result
  packB: null,                 // B's full layered pack (for atlases)
  atlasVariant: 'strata',      // 'strata' | 'periodic' | 'constellation' | 'skyline' | 'transit' | 'arbor'
  atlasMorph: 0,               // 0..1 for the constellation slider
  arborView: 'A',              // 'A' | 'B' | 'both' — arbor side-by-side toggle
  compileTarget: 'prometheus-rules',
  compileDashId: null,
  compileContent: null,        // { filename, contentType, text, source } | { error }
  compileTargets: null,        // legacy catalog from /api/compile/targets
  // Per-artifact compile state (Phase 7m).
  compileCatalog: null,        // { groups: [...] } from /api/packs/:id/compile-catalog
  compileGroup: 'rules',       // 'rules' | 'dashboards' | 'pipelines' | 'alertmanager'
  compileFlavor: 'prometheus', // chosen flavor for the active group
  compileArtifact: 'all',      // chosen leaf in the artifact tree
  deployMatrix: null,          // catalog from /api/deploy/matrix
  deployProduct: 'grafana',    // chosen target product
  deployVersion: '12',         // chosen target version (string — matches matrix.versions)
  deployScope: 'both',         // for prometheus-rules: both | recording | alerting
  mcpStatus: null,
};

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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

// ---------- persistence (localStorage) ----------
//
// The studio used to forget everything on refresh: which pack was open,
// which view you were on, your layer filter, your compare slice. That's
// fine for a demo but cruel for a tool you live in for hours. We persist
// a small whitelist of state under a versioned key and re-hydrate on
// boot — re-fetching packs the normal way (no skipping validation) so a
// pack that vanished from the catalog just drops silently.
const PERSIST_KEY = 'studioState.v1';
const PERSIST_FIELDS = [
  'selectedPackId', 'selectedEnv',
  'compareBId', 'compareBEnv',
  'view', 'layerFilter',
  'compareSlice', 'compareSearch',
  'viewFocus',
  'atlasVariant', 'arborView',
  'compileGroup', 'compileFlavor', 'compileArtifact',
  'compileGroupB', 'compileFlavorB', 'compileArtifactB',
  'tracePrefs',
];
const persistence = {
  _suspended: true,  // boot-phase guard — flipped to false once rehydrate finishes
  _timer: null,
  suspend() { this._suspended = true; if (this._timer) { clearTimeout(this._timer); this._timer = null; } },
  resume()  { this._suspended = false; },
  read() {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return (data && typeof data === 'object') ? data : null;
    } catch (_) { return null; }
  },
  write() {
    if (this._suspended) return;
    const snap = {};
    for (const k of PERSIST_FIELDS) snap[k] = state[k];
    try { localStorage.setItem(PERSIST_KEY, JSON.stringify(snap)); } catch (_) {}
  },
  schedule() {
    if (this._suspended) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.write(); }, 250);
  },
  clear() { try { localStorage.removeItem(PERSIST_KEY); } catch (_) {} },
};

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
  if (typeof saved.layerFilter === 'string')   state.layerFilter = saved.layerFilter;
  if (typeof saved.compareSlice === 'string')  state.compareSlice = saved.compareSlice;
  if (typeof saved.compareSearch === 'string') state.compareSearch = saved.compareSearch;
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
    // them apart from file-backed catalog entries at a glance.
    const prefix = p.source === 'uploaded' ? '📂 ' : '';
    opt.textContent = p.ok
      ? `${prefix}${p.label} · v${p.version || '?'} · ${p.criticality || '?'}`
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
    + options.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)} · v${escapeHtml(p.version || '?')} · ${escapeHtml(p.criticality || '?')}</option>`).join('');
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
      if (state.view === 'compare' || state.view === 'atlas' || state.view === 'traceability') {
        state.view = 'layers';
      }
      applyModeChrome();
      renderTabs();
      renderMainView();
      return;
    }
    // Push the chosen pack into state.catalog (if not already present)
    // so loadPackB() + the catalog-entry resolver have a label to read.
    if (!state.catalog.find(p => p.id === newId)) {
      const ex = (state._examplesCache || []).find(p => p.id === newId);
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
  const tabs = $('#layer-tabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  tabs.appendChild(renderPrimaryViewNav());
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

function renderPrimaryViewNav() {
  const nav = document.createElement('div');
  nav.className = 'view-nav';

  // Decide which views are available for the current mode.
  // View nav adapts to what's loaded — no rigid mode locking.
  //   Pack A only  → Layers · Conformance · Compile · Schema
  //   Pack B added → adds Compare + Atlas (cross-pack views)
  // User toggles Pack B from the header picker; the view nav refreshes.
  const hasB = !!state.packB;
  const views = [
    { id: 'layers',     label: 'Layers',     hint: 'Browse artefacts by layer (L1..GOV).' },
    { id: 'conformance',label: 'Conformance',hint: 'Maturity rubric per tier with pass/fail.' },
    { id: 'compile',    label: 'Compile',    hint: 'Per-artefact compilation to native platform format.' },
    ...(hasB ? [
      { id: 'compare',     label: 'Compare',     hint: 'Side-by-side per-layer comparison of PACK A vs PACK B.' },
      { id: 'traceability',label: 'Traceability',hint: 'Repo vs live: aligned / declared-not-verified / verified-not-declared / stale.' },
      { id: 'atlas',       label: 'Atlas',       hint: 'Cross-pack atlas variants — Stratigraphy, Periodic, Constellation, Skyline, Transit, Arbor.' },
    ] : []),
    { id: 'schema',     label: 'Schema',     hint: 'Maturity score + canonical schema view.' },
  ];
  const active = state.view || 'layers';

  for (const v of views) {
    const b = document.createElement('button');
    b.className = 'view-nav-btn' + (v.id === active ? ' is-active' : '');
    b.type = 'button';
    b.title = v.hint;
    b.textContent = v.label;
    b.onclick = () => {
      state.view = v.id;
      // Mirror to activeLayer for legacy code paths.
      state.activeLayer = ({ conformance: 'CONF', compile: 'COMPILE', atlas: 'ATLAS', schema: 'CONF', layers: state.layerFilter !== 'all' ? state.layerFilter : 'L1' })[v.id] || 'L1';
      state.activeCardKey = null;
      // Header chrome depends on the current view (Compare hides its
      // pickers because the compare pack-cards have their own).
      applyModeChrome();
      renderTabs();
      renderMainView();
    };
    nav.appendChild(b);
  }
  nav.appendChild(renderFocusToggle());
  return nav;
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
  if (!state.pack) { view.innerHTML = '<div class="placeholder">Loading pack…</div>'; return; }

  // Mode-free dispatch (Phase 7r): the view nav decides what to render
  // based on what's loaded. 'compare' and 'atlas' only appear in the
  // nav when state.packB is truthy, so we can reach them here without
  // needing a separate 'compare' mode.
  switch (state.view) {
    case 'compare':      renderCompareView(view); return;
    case 'traceability': renderTraceabilityView(view); return;
    case 'atlas':        renderAtlasView(view); return;
    case 'conformance':  view.appendChild(renderConformanceView()); return;
    case 'compile':      renderCompileView(view); return;
    case 'schema':       view.appendChild(renderConformanceView()); return;
    case 'layers':
    default:
      renderLayersView(view);
      return;
  }
}

// Layers view — stacks every layer when filter='all', narrows to one
// otherwise. Replaces the old per-layer-tab navigation.
function renderLayersView(view) {
  const filter = state.layerFilter || 'all';
  const layersToShow = (filter === 'all')
    ? LAYER_DEFS
    : LAYER_DEFS.filter(d => d.id === filter);

  let rendered = 0;
  for (const def of layersToShow) {
    // Skip L2X if empty (it's optional per spec v1.2).
    if (def.id === 'L2X' && layerArtefactCount('L2X') === 0) continue;
    if (def.id === 'L4') {
      renderLayer4(view);
    } else {
      const items = state.pack.layers[def.id] || [];
      view.appendChild(renderSection(def, items));
    }
    rendered++;
  }
  if (rendered === 0) {
    view.innerHTML = '<div class="placeholder">No artefacts on this layer.</div>';
  }
}

function renderSection(def, items, opts = {}) {
  const section = document.createElement('section');
  section.className = 'section';
  section.dataset.layer = def.id;

  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <span class="section-num">${def.num}</span>
    <span class="section-name">${escapeHtml(opts.subtitle || def.name)}</span>
    <span class="section-count">${items.length} artefact${items.length === 1 ? '' : 's'}</span>
  `;
  section.appendChild(head);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'no artefacts declared in this section';
    section.appendChild(empty);
    return section;
  }

  const grid = document.createElement('div');
  grid.className = 'section-grid';
  for (const a of items) grid.appendChild(renderCard(a, def, opts.sublayerKey));
  section.appendChild(grid);
  return section;
}

function renderLayer4(view) {
  const head = document.createElement('div');
  head.className = 'section';
  head.dataset.layer = 'L4';
  head.innerHTML = `
    <div class="section-head">
      <span class="section-num">L4</span>
      <span class="section-name">Action — policy · alerting · self-healing</span>
      <span class="section-count">${layerArtefactCount('L4')} artefacts</span>
    </div>
  `;
  view.appendChild(head);

  for (const sg of L4_SUBGROUPS) {
    const items = state.pack.layers.L4?.[sg.key] || [];
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
    </div>
  `;
  btn.onclick = () => openDrawer(artefact, def, sublayerKey);
  return btn;
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

function renderCompileView(host) {
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
    <span class="section-name">Compile — pack as the source of truth${focusBadge}</span>
    <span class="section-count">${escapeHtml(focusedPk?.id || '')}</span>
  `;
  section.appendChild(head);

  const lede = document.createElement('div');
  lede.className = 'compile-lede';
  lede.innerHTML = `
    Pick an artifact on the left and choose its target flavor. Each leaf compiles individually — one SLO's rules,
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

// Apply slice + text search to a side's items.
function filterCompareItems(items, L, side, sets) {
  const slice = state.compareSlice || 'all';
  const search = (state.compareSearch || '').trim().toLowerCase();
  return items.filter(art => {
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
    opt.textContent = `${p.label} · v${p.version || '?'} · ${p.criticality || '?'}`;
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

function renderAtlasView(view) {
  if (!state.compareBId) state.compareBId = defaultCompareB();
  if (!state.compareBEnv) state.compareBEnv = defaultEnvFor(state.compareBId);

  if (!state.compareBId) {
    view.innerHTML = '<div class="placeholder">Need at least two packs in the catalog to render an atlas.</div>';
    return;
  }

  const section = document.createElement('section');
  section.className = 'section atlas-view';
  section.dataset.layer = 'ATLAS';

  const meta = ATLAS_META[state.atlasVariant] || { title: state.atlasVariant, lede: '' };
  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <span class="section-num">ATL</span>
    <span class="section-name">${escapeHtml(meta.title)}</span>
    <span class="section-count">${escapeHtml(state.atlasVariant)}</span>
  `;
  section.appendChild(head);

  const sub = document.createElement('div');
  sub.className = 'atlas-lede';
  sub.textContent = meta.lede;
  section.appendChild(sub);

  // Variant selector pills
  const pills = document.createElement('div');
  pills.className = 'atlas-variants';
  for (const v of ATLAS_VARIANTS) {
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

  // Pack-B + env-B + swap (same controls as compare view)
  section.appendChild(renderComparePicker());

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
  btn.onclick = () => fileInput.click();
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

async function boot() {
  try { await loadCatalog(); }
  catch (e) {
    document.body.innerHTML = `<pre class="json" style="margin:48px;max-width:800px">Failed to reach the studio API.\n\n${escapeHtml(e.message)}\n\nMake sure the server is running: \`node server/index.mjs\` or \`npm run serve\`.</pre>`;
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
    if (state.view === 'compare' || state.view === 'atlas') state.view = 'layers';
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
  // On Compare view the pack-A / pack-B cards inside the comparison
  // already carry their own pickers, env selectors, swap button, and
  // metadata chips. Showing the header pickers above is pure
  // duplication — the same two controls fifty pixels higher. Hide them.
  // Every other view needs the header pickers as the only way to swap
  // packs.
  const onCompare = state.view === 'compare';
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
    const ok = confirm('Reset the studio?\n\n' +
      'This will:\n' +
      '  • drop every uploaded / crawled / drafted pack from the server\n' +
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
      <div class="home-hero-eyebrow">canonical observability · spec v1.2</div>
      <h2 class="home-hero-title">Map your observability platform in seconds.</h2>
      <p class="home-hero-lede">
        Connect to any OpenTelemetry MCP server. The studio interrogates it
        for backends, topology, baselines, and anomalies — and renders a
        complete, conformant canonical v1.2 manifest you can compile and
        deploy.
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

      <div class="home-alt-row">
        <span class="home-alt-prefix">Or work from</span>
        <button id="home-shortcut-upload" type="button" class="home-alt-link">a YAML / JSON manifest</button>
        <span class="home-alt-sep">·</span>
        <button id="home-shortcut-crawl" type="button" class="home-alt-link">a service repository</button>
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
      body: JSON.stringify({ mcpUrl: url, mcpAuth: auth || undefined }),
    });
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

  // Recognised vs unrecognised tools. Surfacing this honestly is part
  // of the studio's integrity story.
  const knownTools = new Set([
    'system_health', 'system_topology',
    'anomalies_active', 'anomalies_baselines',
    'zk_stats', 'zk_solvency',
  ]);
  const recognised   = tools.filter(t => knownTools.has(t));
  const unrecognised = tools.filter(t => !knownTools.has(t));
  const mcpHost = (() => {
    try { return new URL(out.summary?.mcpUrl || '').host || 'mcp'; }
    catch (_) { return 'mcp'; }
  })();

  // Executive-summary layout: a narrative line up top, then a four-row
  // signal report. Each row is a single metric with the number set in
  // serif and a one-line interpretation in sans. No widget boxes.
  host.innerHTML = `
    <div class="home-mcp-report">
      <div class="home-mcp-report-head">
        <span class="home-mcp-report-dot" aria-hidden="true"></span>
        Connected to <strong>${escapeHtml(mcpHost)}</strong>${out.tookMs ? ` <span class="home-mcp-report-meta">· ${out.tookMs}ms</span>` : ''}
      </div>
      <div class="home-mcp-report-body">
        <div class="home-mcp-signal">
          <div class="home-mcp-signal-num">${services.length}</div>
          <div class="home-mcp-signal-text">
            <span class="home-mcp-signal-label">services</span>
            <span class="home-mcp-signal-detail">${services.length ? services.slice(0, 5).map(s => escapeHtml(s)).join(', ') + (services.length > 5 ? `, +${services.length - 5} more` : '') : 'none discovered'}</span>
          </div>
        </div>
        <div class="home-mcp-signal">
          <div class="home-mcp-signal-num">${backends}</div>
          <div class="home-mcp-signal-text">
            <span class="home-mcp-signal-label">backends</span>
            <span class="home-mcp-signal-detail">${backends ? 'metrics, logs, traces — pipelines inferred from topology' : 'none observed'}</span>
          </div>
        </div>
        <div class="home-mcp-signal">
          <div class="home-mcp-signal-num">${tools.length}</div>
          <div class="home-mcp-signal-text">
            <span class="home-mcp-signal-label">tools exposed</span>
            <span class="home-mcp-signal-detail">${recognised.length ? recognised.join(', ') : 'unrecognised set'}${unrecognised.length ? ` · <span class="home-mcp-signal-extra">+${unrecognised.length} unrecognised</span>` : ''}${failed.length ? ` · <span class="home-mcp-signal-fail">⚠ ${failed.length} failed</span>` : ''}</span>
          </div>
        </div>
        <div class="home-mcp-signal">
          <div class="home-mcp-signal-num">${anomalies}</div>
          <div class="home-mcp-signal-text">
            <span class="home-mcp-signal-label">active anomalies</span>
            <span class="home-mcp-signal-detail">${baselines} baseline${baselines === 1 ? '' : 's'} computed from recent telemetry</span>
          </div>
        </div>
      </div>
      ${out.summary?.warnings?.length ? `
        <div class="home-mcp-gaps">
          <div class="home-mcp-gaps-head">Honest gaps</div>
          <ul>${out.summary.warnings.slice(0, 5).map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
        </div>` : ''}
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
    if (crawlState.files.size > 0) setStatus('no observability artefacts in the staged set; nothing to crawl', 'error');
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
  setStatus(`crawling ${crawlState.classified.size} artefact${crawlState.classified.size === 1 ? '' : 's'}…`);

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

async function adoptCrawlResult() {
  const out = crawlState.lastResult;
  if (!out) return;
  // Reuse the upload flow: POST /api/validate → if ok, load into the
  // active state and re-render. Same path as drag-dropping a yaml file
  // onto the studio shell.
  try {
    const res = await validateUploaded(out.canonicalYaml, 'application/x-yaml', state.selectedEnv);
    if (!res.ok) {
      toast(`Could not adopt — ${res.errors.length} validation error(s)`, 'error');
      return;
    }
    state.pack = res.adapted;
    state.conformance = res.conformance;
    state.symbolTable = buildSymbolTable(res.adapted);
    state.uploadedSource = `${out.canonical.metadata.name} (crawled draft)`;
    state.activeLayer = 'L1';
    state.activeCardKey = null;
    state.mode = 'single';
    if (res.registered?.id) {
      state.selectedPackId = res.registered.id;
      state.selectedEnv = defaultEnvFor(state.selectedPackId);
      await loadCatalog();
    }
    applyModeChrome();
    renderPackSelect();
    renderPackBSelect();
    renderEnvSelect();
    renderMeta();
    renderTabs();
    renderMainView();
    $('#crawl-panel').hidden = true;
    toast(`Loaded crawled draft for ${out.canonical.metadata.name}`);
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

function openDeployModal({ packId, packLabel } = {}) {
  const modal = $('#deploy-modal');
  if (!modal) return;
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
    opt.textContent = `${p.label} · v${p.version || '?'} · ${p.criticality || '?'}`;
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
    // Default-select all deployable rows.
    for (const row of deployModalState.manifest) {
      if (row.deployable) deployModalState.selected.add(row.key);
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
  const probeRow = (label, key, value) => {
    if (!probesA.has(key)) return '';
    const succeeded = probesS.has(key);
    if (!succeeded) return row(label, '— probed, none found', true);
    return row(label, value || 0);
  };
  $('#draft-mcp-result-summary').innerHTML = `
    <h4>what the MCP attested</h4>
    <table class="crawl-summary-table">
      ${row('services', (d.servicesDiscovered || []).length)}
      ${row('backends', d.backends)}
      ${row('active anomalies', d.activeAnomalies)}
      ${probeRow('recording rules', 'recording_rules', d.recordingRules)}
      ${probeRow('alert rules',     'alert_rules',     d.alertRules)}
      ${probeRow('dashboards',      'dashboards',      d.dashboards)}
      ${probeRow('scrape jobs',     'scrape_configs',  (d.scrapeJobs || []).length)}
      ${probeRow('metric names',    'metric_names',    d.metricNamesCount)}
    </table>
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
    state.pack = res.adapted;
    state.conformance = res.conformance;
    state.symbolTable = buildSymbolTable(res.adapted);
    state.uploadedSource = `${out.canonical.metadata.name} (live draft)`;
    state.activeLayer = 'L1';
    state.activeCardKey = null;
    state.mode = 'single';
    if (res.registered?.id) {
      state.selectedPackId = res.registered.id;
      state.selectedEnv = defaultEnvFor(state.selectedPackId);
      await loadCatalog();
    }
    applyModeChrome();
    renderPackSelect();
    renderPackBSelect();
    renderEnvSelect();
    renderMeta();
    renderTabs();
    renderMainView();
    $('#draft-mcp-panel').hidden = true;
    toast(`Loaded live draft for ${out.canonical.metadata.name}`);
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
