// studio/compile-view.mjs
//
// The Compile / Remediate / Deploy workflow — Remediate's set-operation band
// and the per-artefact compile catalog (pack -> Prometheus rules, Grafana
// dashboards, OTel pipelines, Alertmanager routes), plus the deploy panel.
// Orchestration-coupled: imports the re-render entrypoint and a few compare-
// cluster helpers back from app.mjs (a safe call-time cycle).

import { state } from './state.mjs';
import { api } from './api.mjs';
import { escapeHtml, toast } from './util.mjs';
import {
  effectiveFocus, focusedPack, focusedPackId, focusedEnv,
  focusedCompileCatalog, setFocusedCompileCatalog,
  focusedCompileContent, setFocusedCompileContent,
  focusedCompileGroup, setFocusedCompileGroup,
  focusedCompileFlavor, setFocusedCompileFlavor,
  focusedCompileArtifact, setFocusedCompileArtifact,
} from './focus.mjs';
import { openDeployModal, renderMainView } from './app.mjs';
import { loadDiff, LAYERS_FOR_DIFF, renderLiveScopeControl } from './compare-view.mjs';
import { artefactLabel } from './artifact-model.mjs';
import {
  buildVerdictModel, projectGrade, projectionSentence, deploySelectionFromItems,
  kpiTile, fmtUnits, fixChip, badnessClassChip,
  partialEvidenceBanner, scaffoldOosNotes,
} from './verdict-ui.mjs';

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

export async function loadDeployMatrix() {
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
// renderSchemaView now lives in studio/schema-view.mjs (imported above).
// ============================================================

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
// renderOtlpView / renderOtlpBody now live in studio/otlp-view.mjs.
// ============================================================


// ============================================================
// TRIAGE QUEUE — the band that leads Remediate.
//
// "Fix the gaps" as a worklist, not a form: every finding from the same
// scoped diff Diagnose graded, ordered by the engine's own weighted
// badness (declared-not-live 1.0 · drifted 0.5/1.0/0.1 by field class ·
// live-not-declared 0.15). Each row names its fix path — one-click
// deploy, retrofeed repo patch, field decision, or manual — and the
// basket draws the line from work to grade: "fixing these N takes you
// from B to A", computed by re-running the verdict engine on the
// hypothetical post-fix diff (chains/freshness/chaos never projected).
// The per-artefact compiler below stays as the drill-down.
// ============================================================

// Display filter for the queue (session-only — selection is unaffected).
let triageFilter = 'all';

const TRIAGE_FILTERS = [
  { id: 'all',       label: 'All',             test: () => true },
  { id: 'deploy',    label: 'Deploy',          test: i => i.fix === 'deploy' },
  { id: 'retrofeed', label: 'Retrofeed',       test: i => i.fix === 'retrofeed' || i.fix === 'adopt' },
  { id: 'reconcile', label: 'Field decisions', test: i => i.fix === 'reconcile' },
  { id: 'manual',    label: 'Manual',          test: i => i.fix === 'manual' || i.fix === 'beyond-target' },
];

function renderTriageQueue(host) {
  const haveB = !!state.packB;
  const wrap = document.createElement('div');
  wrap.className = 'rq-band';
  host.appendChild(wrap);

  if (!haveB) {
    wrap.innerHTML = `
      <div class="rq-head">
        <span class="rq-eyebrow">TRIAGE</span>
        <span class="rq-title">What do we fix first?</span>
        <span class="rq-sub">Load a <strong>Pack B</strong> from the header to compute the queue —
          drift, shadow signals, and gaps to target, ordered by what they cost the grade.
          The compiler below emits any artefact directly in the meantime.</span>
      </div>`;
    return;
  }

  // The queue is carved from the same scoped diff as Diagnose; fetch it
  // lazily with motion, never a silent hang.
  if (!state.diff || state.diff.error || !state.diff.layers) {
    wrap.innerHTML = `<div class="remediate-loading">Computing the set…</div>`;
    loadDiff().then(() => renderMainView());
    return;
  }

  const vm = buildVerdictModel();
  const bName = vm.bName;

  // Basket = every finding minus explicit deselections (persisted shape
  // unchanged: state.remediateDeselected is the Set of unchecked rows).
  const deselected = state.remediateDeselected instanceof Set
    ? state.remediateDeselected
    : (state.remediateDeselected = new Set());
  for (const uid of [...deselected]) if (!vm.items.some(i => i.uid === uid)) deselected.delete(uid);
  const basket = new Set(vm.items.filter(i => !deselected.has(i.uid)).map(i => i.uid));
  const picked = vm.items.filter(i => basket.has(i.uid));
  const dep = deploySelectionFromItems(vm.items, basket);
  const projection = basket.size ? projectGrade(basket) : null;
  const sentence = projection ? projectionSentence(projection, basket.size) : '';

  const projTile = projection && projection.afterPct > projection.beforePct
    ? kpiTile({
        accent: 'cmp', label: 'PROJECTED GRADE',
        value: escapeHtml(projection.after.overall.instrumentGrade.letter),
        unit: ` ${projection.afterPct}%`,
        note: `from ${projection.before.overall.instrumentGrade.letter} (${projection.beforePct}%) — the selected fixes, engine-projected`,
      })
    : kpiTile({
        accent: 'cmp', label: 'PROJECTED GRADE', value: '—', unit: '',
        note: projection?.chainAnchored
          ? 'anchored on chain integrity — repairs land at the next live verification'
          : 'select fixes to project',
      });

  const filterChips = TRIAGE_FILTERS.map(f => {
    const n = f.id === 'all' ? vm.items.length : vm.items.filter(f.test).length;
    return `<button type="button" class="rq-filter${triageFilter === f.id ? ' is-active' : ''}" data-filter="${f.id}">
      ${escapeHtml(f.label)} <span class="rq-filter-n">${n}</span></button>`;
  }).join('');

  const activeFilter = TRIAGE_FILTERS.find(f => f.id === triageFilter) || TRIAGE_FILTERS[0];
  const shown = vm.items.filter(activeFilter.test);

  wrap.innerHTML = `
    <div class="rq-head">
      <span class="rq-eyebrow">TRIAGE</span>
      <span class="rq-title">What do we fix first?</span>
      <span class="rq-sub">every finding from the live diff vs <strong>${escapeHtml(bName)}</strong>,
        ordered by weighted badness — the engine's own cost model, not a heuristic</span>
    </div>
    ${partialEvidenceBanner(vm)}
    <div class="mc-tiles">
      ${kpiTile({ accent: 'red', label: 'FINDINGS', value: String(vm.items.length), unit: '', note: `${fmtUnits(vm.weighted.totalBadness)} weighted badness units total` })}
      ${kpiTile({ accent: 'amber', label: 'SELECTED', value: String(basket.size), unit: ` of ${vm.items.length}`, note: 'rows in the basket below' })}
      ${kpiTile({ accent: 'green', label: 'DEPLOYABLE', value: String(dep.identities.size), unit: ` · ${dep.rows} rows`, note: 'one-click via the deploy modal' })}
      ${projTile}
    </div>
    <div class="rq-tools">
      <div class="rq-filters">${filterChips}</div>
    </div>
    <table class="rq-table">
      <thead><tr><th></th><th>Finding</th><th>Layer</th><th>Class</th><th>Badness</th><th>Fix</th><th></th></tr></thead>
      <tbody>
        ${shown.map(i => `
          <tr class="${deselected.has(i.uid) ? 'is-deselected' : ''}" data-uid="${escapeHtml(i.uid)}">
            <td><input type="checkbox" ${deselected.has(i.uid) ? '' : 'checked'} aria-label="include in the basket"></td>
            <td class="rq-label">${escapeHtml(artefactLabel(i.art, i.label))}${i.fields?.length ? `<span class="rq-fields">${escapeHtml(i.fields.slice(0, 3).join(', '))}</span>` : ''}</td>
            <td><span class="mc-lnum">${i.layer}</span></td>
            <td>${badnessClassChip(i)}</td>
            <td class="rq-w">${escapeHtml(fmtUnits(i.badness))}</td>
            <td>${fixChip(i.fix)}</td>
            <td>${i.deployable ? `<button type="button" class="mc-act is-mini" data-deploy="${escapeHtml(i.uid)}">deploy</button>` : ''}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    ${shown.length === 0 ? `<div class="remediate-empty">Nothing ${triageFilter === 'all' ? 'to remediate — every concrete artefact aligns.' : `under the ${escapeHtml(activeFilter.label)} filter.`}</div>` : ''}
    ${scaffoldOosNotes(vm)}
    <div class="rq-patch-host"></div>
    <div class="mc-deploybar">
      ${dep.identities.size ? `<button type="button" class="mc-act is-primary" id="rq-deploy">⇪ Deploy ${dep.identities.size} selected (${dep.rows} row${dep.rows === 1 ? '' : 's'})</button>` : ''}
      ${sentence ? `<span class="mc-deploybar-projection">${escapeHtml(sentence)}</span>` : ''}
    </div>
  `;

  // Scope control right under the head — what's parked out of scope is a
  // visible choice while deciding what to deploy, not a silent precondition.
  const head = wrap.querySelector('.rq-head');
  head.insertAdjacentElement('afterend', renderLiveScopeControl({ standalone: true }));

  // Retrofeed repo patch — the live→repo half of the loop, scoped to the
  // basket's retrofeed rows. Same ReconcilePatch the classic band emitted.
  const retroPicked = picked.filter(i => i.fix === 'retrofeed' || i.fix === 'adopt');
  if (retroPicked.length) {
    const resolvedLike = { byLayer: {} };
    for (const i of retroPicked) {
      (resolvedLike.byLayer[i.layer] = resolvedLike.byLayer[i.layer] || []).push({
        direction: 'retrofeed', identity: i.identity || '', art: i.art,
      });
    }
    const patchText = buildRetrofeedPatchText(resolvedLike, bName);
    if (patchText) {
      const patch = document.createElement('details');
      patch.className = 'remediate-patch';
      patch.innerHTML = `
        <summary>Repo retrofeed patch (${retroPicked.length} item${retroPicked.length === 1 ? '' : 's'} in the basket)</summary>
        <pre>${escapeHtml(patchText)}</pre>
      `;
      wrap.querySelector('.rq-patch-host').appendChild(patch);
    }
  }

  // ---- wiring ----
  wrap.querySelectorAll('.rq-filter').forEach(btn => {
    btn.onclick = () => { triageFilter = btn.dataset.filter; renderMainView(); };
  });
  wrap.querySelectorAll('.rq-table input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => {
      const uid = cb.closest('tr').dataset.uid;
      if (cb.checked) deselected.delete(uid); else deselected.add(uid);
      renderMainView();
    };
  });
  wrap.querySelectorAll('[data-deploy]').forEach(btn => {
    btn.onclick = () => {
      const item = vm.items.find(i => i.uid === btn.dataset.deploy);
      if (!item?.deployIdentity) return;
      openDeployModal({ packId: state.selectedPackId, presetIdentities: new Set([item.deployIdentity]) });
    };
  });
  wrap.querySelector('#rq-deploy')?.addEventListener('click', () =>
    openDeployModal({ packId: state.selectedPackId, presetIdentities: dep.identities }));
}

function buildRetrofeedPatchText(resolved, bName) {
  const changes = [];
  for (const L of LAYERS_FOR_DIFF) {
    for (const e of resolved.byLayer[L] || []) {
      if (e.direction !== 'retrofeed') continue;
      changes.push({ layer: L, identity: e.identity || '', artefact: e.art });
    }
  }
  if (!changes.length) return '';
  const lines = [
    'apiVersion: tomograph.dev/v1alpha1',
    'kind: ReconcilePatch',
    'metadata:',
    `  service: ${yamlScalar(state.pack?.meta?.service || state.pack?.meta?.name || 'unknown')}`,
    `  source: ${yamlScalar(bName || 'Pack B')}`,
    'spec:',
    '  direction: live_to_repo',
    '  changes:',
  ];
  for (const change of changes) {
    const label = artefactLabel(change.artefact, change.identity);
    lines.push(`    - layer: ${yamlScalar(change.layer)}`);
    lines.push('      action: add_to_pack');
    lines.push(`      identity: ${yamlScalar(change.identity)}`);
    lines.push(`      title: ${yamlScalar(label)}`);
    lines.push('      artifact_json: |');
    for (const line of JSON.stringify(cleanPatchArtefact(change.artefact), null, 2).split('\n')) {
      lines.push(`        ${line}`);
    }
  }
  return lines.join('\n');
}

function cleanPatchArtefact(artefact) {
  if (!artefact || typeof artefact !== 'object') return artefact;
  const rest = { ...artefact };
  delete rest.domId;
  delete rest._sub;
  return rest;
}

function yamlScalar(value) {
  const s = String(value ?? '');
  if (!s) return "''";
  if (/^[A-Za-z0-9_.:/@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

export function renderCompileView(host) {
  // The triage queue leads the view: every finding ordered by weighted
  // badness, basket → deploy/retrofeed, projected grade. The per-artefact
  // compiler below remains the drill-down to inspect/emit one artefact.
  renderTriageQueue(host);

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
  if (product === 'grafana') {
    if (target === 'prometheus-rules') {
      return 'grafana_create_alert_rule';
    }
    if (target === 'grafana-dashboard') return 'grafana_create_dashboard';
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
        <input id="deploy-mcp-tool" type="text" placeholder="grafana_create_alert_rule" autocomplete="off">
      </label>
      <label class="mcp-field">
        <span class="mcp-field-key">MCP client key <em>(optional, not persisted)</em></span>
        <input id="deploy-mcp-auth" type="password" placeholder="sk-..." autocomplete="off">
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
