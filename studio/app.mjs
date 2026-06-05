// studio/app.mjs
//
// Studio v0.3 client. Fetches the canonical pack catalog, lets the user pick
// a pack + environment, asks the server for the adapted layered object, and
// renders it as a tabbed layer view with a slide-in drawer for artefact
// detail. Phase 3a foundation; Phase 3b adds per-artefact-type drawer
// panels, version-gating badges, cross-reference checking, and the
// conformance panel.

const LAYER_DEFS = [
  { id: 'L1',  num: 'L1',  name: 'Contract'    },
  { id: 'L2',  num: 'L2',  name: 'Telemetry'   },
  { id: 'L2X', num: 'L2X', name: 'Extended'    },
  { id: 'L3',  num: 'L3',  name: 'Insight'     },
  { id: 'L4',  num: 'L4',  name: 'Action'      },
  { id: 'L5',  num: 'L5',  name: 'Validation'  },
  { id: 'GOV', num: 'GOV', name: 'Governance'  },
];

const L4_SUBGROUPS = [
  { key: 'policy',   label: 'Policy' },
  { key: 'alerting', label: 'Alerting' },
  { key: 'healing',  label: 'Self-healing' },
];

const state = {
  catalog: [],
  selectedPackId: null,
  selectedEnv: null,
  pack: null,             // current layered display object
  activeLayer: 'L1',
  activeCardKey: null,    // "<layer>/<id>" or null
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- API ----------

async function api(path) {
  const r = await fetch(path, { headers: { Accept: 'application/json' } });
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
  state.pack = await api(`/api/packs/${encodeURIComponent(id)}${q}`);
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
  sel.value = state.selectedPackId || (state.catalog.find(p => p.ok)?.id ?? '');
  sel.onchange = () => {
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
    opt.value = '';
    opt.textContent = '— none —';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const e of envs) {
    const opt = document.createElement('option');
    opt.value = e;
    opt.textContent = e;
    sel.appendChild(opt);
  }
  sel.value = state.selectedEnv ?? envs[0];
  sel.onchange = () => {
    state.selectedEnv = sel.value || null;
    refresh();
  };
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

// ---------- layer tabs ----------

function layerArtefacts(layerId) {
  const layers = state.pack?.layers;
  if (!layers) return [];
  if (layerId === 'L4') {
    return [
      ...(layers.L4?.policy   || []),
      ...(layers.L4?.alerting || []),
      ...(layers.L4?.healing  || []),
    ];
  }
  return layers[layerId] || [];
}

function renderTabs() {
  const tabs = $('#layer-tabs');
  tabs.innerHTML = '';
  for (const def of LAYER_DEFS) {
    const count = layerArtefacts(def.id).length;
    if (def.id === 'L2X' && count === 0) continue; // hidden when empty
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.layer = def.id;
    btn.setAttribute('aria-selected', def.id === state.activeLayer ? 'true' : 'false');
    btn.innerHTML = `
      <span class="tab-num">${def.num}</span>
      <span class="tab-name">${def.name}</span>
      <span class="tab-count">${count}</span>
    `;
    btn.onclick = () => { state.activeLayer = def.id; state.activeCardKey = null; renderTabs(); renderLayerView(); };
    tabs.appendChild(btn);
  }
}

// ---------- layer view ----------

function renderLayerView() {
  const view = $('#layer-view');
  view.innerHTML = '';
  if (!state.pack) { view.innerHTML = '<div class="placeholder">Loading pack…</div>'; return; }

  const def = LAYER_DEFS.find(d => d.id === state.activeLayer) || LAYER_DEFS[0];

  if (def.id === 'L4') {
    renderLayer4(view);
    return;
  }

  const items = layerArtefacts(def.id);
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
    <span class="section-name">${def.name}</span>
    <span class="section-count">${items.length} artefact${items.length === 1 ? '' : 's'}</span>
  `;
  if (opts.subtitle) head.querySelector('.section-name').textContent = opts.subtitle;
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
  for (const a of items) grid.appendChild(renderCard(a, def));
  section.appendChild(grid);
  return section;
}

function renderLayer4(view) {
  const def = LAYER_DEFS.find(d => d.id === 'L4');
  const all = state.pack.layers.L4 || {};
  const head = document.createElement('div');
  head.className = 'section';
  head.dataset.layer = 'L4';
  head.innerHTML = `
    <div class="section-head">
      <span class="section-num">L4</span>
      <span class="section-name">Action — policy · alerting · self-healing</span>
      <span class="section-count">${(all.policy?.length || 0) + (all.alerting?.length || 0) + (all.healing?.length || 0)} artefacts</span>
    </div>
  `;
  view.appendChild(head);

  for (const sg of L4_SUBGROUPS) {
    const items = all[sg.key] || [];
    const wrapper = document.createElement('div');
    wrapper.className = 'subgroup';
    const h = document.createElement('h4');
    h.className = 'subgroup-head';
    h.textContent = `L4.${sg.key} · ${sg.label}`;
    h.style.color = 'var(--L4)';
    wrapper.appendChild(h);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = `no ${sg.label.toLowerCase()} declared`;
      wrapper.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'section-grid';
      grid.style.border = '1px solid var(--L4)';
      for (const a of items) grid.appendChild(renderCard(a, def, sg.key));
      wrapper.appendChild(grid);
    }
    view.appendChild(wrapper);
  }
}

function renderCard(artefact, def, sublayerKey) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  const key = cardKey(def.id, sublayerKey, artefact.id);
  btn.dataset.key = key;
  if (state.activeCardKey === key) btn.classList.add('is-active');

  const tags = (artefact.tags || []).slice(0, 4).map(t =>
    `<span class="tag">${escapeHtml(t)}</span>`).join('');

  btn.innerHTML = `
    <div class="card-head">
      <span class="card-id">${escapeHtml(artefact.id)}</span>
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

function cardKey(layerId, sublayerKey, id) {
  return sublayerKey ? `${layerId}/${sublayerKey}/${id}` : `${layerId}/${id}`;
}

// ---------- drawer ----------

function openDrawer(artefact, def, sublayerKey) {
  const drawer = $('#drawer');
  drawer.setAttribute('aria-hidden', 'false');
  drawer.dataset.layer = def.id;
  document.body.classList.add('no-scroll');

  state.activeCardKey = cardKey(def.id, sublayerKey, artefact.id);
  $$('.card').forEach(c => c.classList.toggle('is-active', c.dataset.key === state.activeCardKey));

  $('#drawer-eyebrow').textContent =
    `${def.num}${sublayerKey ? `.${sublayerKey}` : ''} · ${artefact.id}`;
  $('#drawer-title').textContent = artefact.title || artefact.id;

  const meta = $('#drawer-meta');
  meta.innerHTML = '';
  const rows = [];
  if (artefact.tool)   rows.push(['tool', artefact.tool]);
  if (artefact.tags?.length) rows.push(['tags', artefact.tags.join(', ')]);
  if (artefact.source) rows.push(['source', artefact.source]);
  if (artefact.defines) rows.push(['defines', artefact.defines]);
  if (artefact.refs?.length) rows.push(['refs', artefact.refs.join(', ')]);
  if (artefact.desc)   rows.push(['summary', artefact.desc]);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    meta.appendChild(dt); meta.appendChild(dd);
  }

  $('#drawer-source').textContent = JSON.stringify(artefact.spec ?? artefact, null, 2);
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

// ---------- boot ----------

async function refresh() {
  try {
    await loadPack(state.selectedPackId, state.selectedEnv);
    renderEnvSelect();
    renderMeta();
    renderTabs();
    renderLayerView();
  } catch (e) {
    const view = $('#layer-view');
    view.innerHTML = `<div class="error">Failed to load pack: ${escapeHtml(e.message)}</div>`;
    toast('Failed to load pack', 'error');
  }
}

async function boot() {
  try {
    await loadCatalog();
  } catch (e) {
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
  await refresh();
}

$('#drawer-close').onclick = closeDrawer;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

// ---------- helpers ----------

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

boot();
