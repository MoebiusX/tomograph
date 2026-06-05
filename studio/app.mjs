// studio/app.mjs
//
// Studio v0.3 client. Phase 3b adds:
//   - Per-artefact-type drawer panels (SLI/SLO/backend/dashboard/chaos/...).
//   - Version-gating chips on backend cards.
//   - Cross-reference checker (red border + drawer "broken refs" list).
//   - Conformance tab (maturity rubric scoring per dimension).
//   - File-upload + drag-and-drop UI for POST /api/validate.

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

const CONFORMANCE_TAB = { id: 'CONF', num: 'CONF', name: 'Conformance' };

const state = {
  catalog: [],
  selectedPackId: null,
  selectedEnv: null,
  pack: null,
  conformance: null,
  symbolTable: null,
  activeLayer: 'L1',
  activeCardKey: null,
  uploadedSource: null,        // set when user uploaded a pack instead of using the catalog
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
  return r.json();
}

async function loadCatalog() {
  const { packs } = await api('/api/packs');
  state.catalog = packs || [];
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
    opt.textContent = p.ok
      ? `${p.label} · v${p.version || '?'} · ${p.criticality || '?'}`
      : `${p.label} (error)`;
    if (!p.ok) opt.disabled = true;
    sel.appendChild(opt);
  }
  if (state.uploadedSource) {
    const opt = document.createElement('option');
    opt.value = '__uploaded__';
    opt.textContent = `📂 ${state.uploadedSource} (uploaded)`;
    opt.selected = true;
    sel.appendChild(opt);
    sel.disabled = false;
  } else {
    sel.value = state.selectedPackId || (state.catalog.find(p => p.ok)?.id ?? '');
  }
  sel.onchange = () => {
    if (sel.value === '__uploaded__') return;
    state.selectedPackId = sel.value;
    state.selectedEnv = defaultEnvFor(state.selectedPackId);
    refresh();
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

function renderTabs() {
  const tabs = $('#layer-tabs');
  tabs.innerHTML = '';
  for (const def of LAYER_DEFS) {
    const count = layerArtefactCount(def.id);
    if (def.id === 'L2X' && count === 0) continue;
    tabs.appendChild(renderTab(def, count));
  }
  if (state.conformance) {
    const def = CONFORMANCE_TAB;
    const conf = state.conformance;
    const label = `${conf.mustPercent}% MUST`;
    tabs.appendChild(renderTab(def, label, true));
  }
}

function renderTab(def, countOrLabel, isMeta = false) {
  const btn = document.createElement('button');
  btn.className = 'tab' + (isMeta ? ' tab-meta' : '');
  btn.dataset.layer = def.id;
  btn.setAttribute('aria-selected', def.id === state.activeLayer ? 'true' : 'false');
  btn.innerHTML = `
    <span class="tab-num">${def.num}</span>
    <span class="tab-name">${def.name}</span>
    <span class="tab-count">${countOrLabel}</span>
  `;
  btn.onclick = () => { state.activeLayer = def.id; state.activeCardKey = null; renderTabs(); renderMainView(); };
  return btn;
}

// ---------- main view ----------

function renderMainView() {
  const view = $('#layer-view');
  view.innerHTML = '';
  if (!state.pack) { view.innerHTML = '<div class="placeholder">Loading pack…</div>'; return; }

  if (state.activeLayer === 'CONF') {
    view.appendChild(renderConformanceView());
    return;
  }

  const def = LAYER_DEFS.find(d => d.id === state.activeLayer) || LAYER_DEFS[0];
  if (def.id === 'L4') {
    renderLayer4(view);
    return;
  }
  const items = state.pack.layers[def.id] || [];
  view.appendChild(renderSection(def, items));
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

  const c = state.conformance;
  if (!c) {
    wrap.innerHTML = '<div class="placeholder">conformance report unavailable</div>';
    return wrap;
  }

  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <span class="section-num">CONF</span>
    <span class="section-name">Maturity rubric · ${escapeHtml(c.declaredTier)}</span>
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

// ---------- drawer ----------

function openDrawer(artefact, def, sublayerKey) {
  const drawer = $('#drawer');
  drawer.setAttribute('aria-hidden', 'false');
  drawer.dataset.layer = def.id;
  document.body.classList.add('no-scroll');

  state.activeCardKey = cardKey(def.id, sublayerKey, artefact.id);
  $$('.card').forEach(c => c.classList.toggle('is-active', c.dataset.key === state.activeCardKey));

  $('#drawer-eyebrow').textContent = `${def.num}${sublayerKey ? `.${sublayerKey}` : ''} · ${artefact.id}`;
  $('#drawer-title').textContent = artefact.title || artefact.id;

  // Meta strip (always shown)
  const meta = $('#drawer-meta');
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

  // Broken refs warning (if any)
  const panels = $('#drawer-panels');
  panels.innerHTML = '';
  const broken = state.symbolTable?.broken?.get(state.activeCardKey);
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

function closeDrawer() {
  const drawer = $('#drawer');
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('no-scroll');
  state.activeCardKey = null;
  $$('.card').forEach(c => c.classList.remove('is-active'));
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
    renderPackSelect();
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
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  });
  document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0; overlay.hidden = true;
    handleFile(e.dataTransfer.files[0]);
  });
}

// ---------- boot ----------

async function refresh() {
  try {
    await loadPack(state.selectedPackId, state.selectedEnv);
    renderEnvSelect();
    renderPackSelect();
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
  const firstOk = state.catalog.find(p => p.ok);
  if (!firstOk) {
    $('#layer-view').innerHTML = '<div class="error">No pack in the catalog could be loaded. Check the server logs.</div>';
    renderPackSelect();
    return;
  }
  state.selectedPackId = firstOk.id;
  state.selectedEnv = firstOk.environments?.[0] || null;
  renderPackSelect();
  setupUpload();
  await refresh();
}

$('#drawer-close').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ---------- helpers ----------

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

boot();
