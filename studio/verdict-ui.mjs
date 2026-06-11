// studio/verdict-ui.mjs
//
// Shared substrate for the Diagnose grade page and the Remediate triage
// queue (the 2026-06 redesign — docs/UX_DIAGNOSE_REMEDIATE.md). Pure
// view-layer: every number comes from the ratified engines
// (diagnostic-grade, /api/diff, /api/journeys); nothing here re-scores.
//
// Three responsibilities:
//   1. buildVerdictModel()  — one normalized read of the drift universe:
//      per-layer buckets, per-item badness (the engine's own weights),
//      biggest-gap attribution, honesty flags. Accepts the active
//      product-lens predicate so counts match the lensed drill.
//   2. projectGrade()       — "fixing these N takes you from B to A",
//      computed by RE-RUNNING computeDiagnosticGrade on a hypothetical
//      post-fix diff. Conservative: requirement-chain integrity is held
//      constant, freshness/chaos are never projected; when the drift
//      criterion is anchored on chain integrity, chainAnchored lets the
//      caller say so instead of faking a delta.
//   3. Widgets + honesty blocks — KPI tiles, sparklines, chips, donuts,
//      and the partial-evidence / scaffold / out-of-scope /
//      verification≠validation blocks every surface must carry.

import { state } from './state.mjs';
import { api } from './api.mjs';
import { escapeHtml } from './util.mjs';
import { diffEntryLabel, deploySurfaceForArtefact } from './artifact-model.mjs';
import {
  computeDiagnosticGrade,
  computePostureMatrix,
  computeWeightedDeltaRisk,
  compareModeFor,
  driftedEntryBadness,
  isScaffoldDiffEntry,
  partialLiveEvidence,
  criterionScore,
  DELTA_BADNESS,
} from './diagnostic-grade.mjs';
import { catalogEntryFor, LAYERS_FOR_DIFF } from './compare-view.mjs';

export const VERDICT_LAYER_NAMES = {
  L1: 'Contract', L2: 'Telemetry', L2X: 'Extended', L3: 'Insight',
  L4: 'Action', L5: 'Validation', GOV: 'Governance',
};

// ---------- the normalized model ----------

// Stable identity for a diff entry inside the view layer — used to match
// basket selections back to entries when building the hypothetical
// post-fix diff. diff entries carry a server `key`; fall back to label.
function entryUid(L, kind, entry) {
  return `${L}::${kind}::${entry.key || diffEntryLabel(entry)}`;
}

// passesLens(entry, side) — optional predicate threading the Diagnose
// product lens into the model so the lattice matches the lensed counts.
export function buildVerdictModel({ passesLens = null } = {}) {
  const haveB = !!state.packB;
  const posture = computePostureMatrix(state.pack, state.packB);
  const diff = (state.diff && !state.diff.error && state.diff.layers) ? state.diff : null;
  const diagnostic = computeDiagnosticGrade(state.pack, state.packB, posture, state.compareBId, diff);
  const mode = compareModeFor(state.packB, state.compareBId);
  const bName = catalogEntryFor(state.compareBId)?.label
    || state.packB?.meta?.name || state.packB?.metadata?.name || state.packB?.id || 'Pack B';
  const lensed = (entry, side) => !passesLens || passesLens(entry, side);

  const totals = { aligned: 0, drifted: 0, onlyInA: 0, onlyInB: 0, scaffold: 0, outOfScope: 0 };
  const layers = [];
  const items = [];
  const driftedEntries = [];

  if (diff) {
    for (const L of LAYERS_FOR_DIFF) {
      const bucket = diff.layers[L] || { onlyInA: [], onlyInB: [], inBoth: [], outOfScope: [] };
      const matched = (bucket.inBoth || []).filter(e => lensed(e, 'a') && !isScaffoldDiffEntry(e));
      const aligned = matched.filter(e => e.match !== 'drifted');
      const drifted = matched.filter(e => e.match === 'drifted');
      const onlyInA = (bucket.onlyInA || []).filter(e => lensed(e, 'a') && !isScaffoldDiffEntry(e));
      const onlyInB = (bucket.onlyInB || []).filter(e => lensed(e, 'b') && !isScaffoldDiffEntry(e));
      const scaffold = [
        ...(bucket.onlyInA || []), ...(bucket.onlyInB || []), ...(bucket.inBoth || []),
      ].filter(e => isScaffoldDiffEntry(e));
      const outOfScope = (bucket.outOfScope || []).filter(e => lensed(e, 'b'));

      totals.aligned += aligned.length;
      totals.drifted += drifted.length;
      totals.onlyInA += onlyInA.length;
      totals.onlyInB += onlyInB.length;
      totals.scaffold += scaffold.length;
      totals.outOfScope += outOfScope.length;
      driftedEntries.push(...drifted);

      if (aligned.length || drifted.length || onlyInA.length || onlyInB.length || outOfScope.length) {
        layers.push({ L, name: VERDICT_LAYER_NAMES[L] || L, aligned, drifted, onlyInA, onlyInB, outOfScope });
      }

      // Per-item triage entries with their REAL badness weight — the same
      // weights the engine scores with (DELTA_BADNESS / driftedEntryBadness).
      const aW = mode === 'drift' ? DELTA_BADNESS.declaredNotLive : DELTA_BADNESS.liveNotDeclared;
      const bW = mode === 'drift' ? DELTA_BADNESS.liveNotDeclared : DELTA_BADNESS.declaredNotLive;
      for (const e of onlyInA) {
        const art = e.artefact || e.a;
        const surface = art ? deploySurfaceForArtefact(art) : { deployable: false };
        items.push({
          uid: entryUid(L, 'onlyInA', e), layer: L, kind: 'onlyInA',
          label: diffEntryLabel(e), badness: aW, badnessClass: aW >= 1 ? 'anchor' : 'low',
          art, identity: e.key, deployable: mode === 'drift' && !!surface.deployable,
          deployIdentity: surface.identity || null, deployRows: surface.deployRows || 1,
          fix: mode === 'drift' ? (surface.deployable ? 'deploy' : 'manual') : 'beyond-target',
        });
      }
      for (const e of drifted) {
        const cost = driftedEntryBadness(e);
        items.push({
          uid: entryUid(L, 'drifted', e), layer: L, kind: 'drifted',
          label: diffEntryLabel(e), badness: cost.weight, badnessClass: cost.className,
          fields: (e.deltas || []).map(d => d.field).filter(Boolean),
          art: e.a, identity: e.key, deployable: false, fix: 'reconcile',
        });
      }
      for (const e of onlyInB) {
        items.push({
          uid: entryUid(L, 'onlyInB', e), layer: L, kind: 'onlyInB',
          label: diffEntryLabel(e), badness: bW, badnessClass: bW >= 1 ? 'anchor' : 'low',
          art: e.artefact || e.b, identity: e.key, deployable: false,
          fix: mode === 'drift' ? 'retrofeed' : 'adopt',
        });
      }
    }
  }
  items.sort((x, y) => y.badness - x.badness);

  const weighted = computeWeightedDeltaRisk({
    mode, aligned: totals.aligned, driftedEntries,
    onlyInA: totals.onlyInA, onlyInB: totals.onlyInB,
  });

  // Biggest-gap attribution: which badness bucket costs the most units.
  const buckets = [
    { kind: 'onlyInA', units: weighted.onlyInAUnits, n: totals.onlyInA,
      label: mode === 'drift' ? 'declared, not live' : 'beyond target' },
    { kind: 'drifted', units: weighted.driftedUnits, n: totals.drifted, label: 'drifted' },
    { kind: 'onlyInB', units: weighted.onlyInBUnits, n: totals.onlyInB,
      label: mode === 'drift' ? 'live, not declared' : 'missing vs target' },
  ].sort((x, y) => y.units - x.units);
  const biggestGap = buckets[0].units > 0 ? buckets[0] : null;

  const deployableSet = deploySelectionFromItems(items);

  return {
    haveB, posture, diff, diagnostic, mode, bName,
    totals, layers, items, weighted, biggestGap, deployableSet,
    liveEvidence: partialLiveEvidence(state.packB),
    overallPct: diagnostic.overall.total === 0 ? 0
      : Math.round((diagnostic.overall.passed / diagnostic.overall.total) * 100),
  };
}

// Deploy selection over triage items (optionally restricted to a basket
// of item uids) — same identity/rows arithmetic as the deploy modal.
export function deploySelectionFromItems(items, selectedUids = null) {
  const identities = new Set();
  let rows = 0;
  for (const it of items) {
    if (!it.deployable || !it.deployIdentity) continue;
    if (selectedUids && !selectedUids.has(it.uid)) continue;
    if (identities.has(it.deployIdentity)) continue;
    identities.add(it.deployIdentity);
    rows += it.deployRows || 1;
  }
  return { identities, rows };
}

// ---------- grade projection ----------

// "Fixing these N takes you from B (65%) to A (87%)" — computed by the
// REAL engine on a hypothetical diff where the given items are resolved:
// declared-not-live entries verify live, drifted entries re-align,
// live-not-declared entries get adopted. HONESTY FENCE: the requirement-
// chain graph is held constant (deploying may repair chains — we do not
// claim it), and freshness / chaos-validated are never projected. When
// the drift criterion is anchored on chain integrity the projection can
// legitimately be flat — `chainAnchored` lets the view say so.
export function projectGrade(uids /* Set<string> | null = fix everything */) {
  const diff = (state.diff && !state.diff.error && state.diff.layers) ? state.diff : null;
  if (!diff) return null;
  const fixAll = !uids;
  const isFixed = (L, kind, e) => fixAll || uids.has(entryUid(L, kind, e));

  const hypoLayers = {};
  for (const L of Object.keys(diff.layers)) {
    const bucket = diff.layers[L] || {};
    const inBoth = [];
    const onlyInA = [];
    const onlyInB = [];
    for (const e of bucket.inBoth || []) {
      if (e.match === 'drifted' && !isScaffoldDiffEntry(e) && isFixed(L, 'drifted', e)) {
        inBoth.push({ ...e, match: 'aligned', deltas: [] });
      } else inBoth.push(e);
    }
    for (const e of bucket.onlyInA || []) {
      if (!isScaffoldDiffEntry(e) && isFixed(L, 'onlyInA', e)) {
        inBoth.push({ key: e.key, a: e.artefact, b: e.artefact, match: 'aligned' });
      } else onlyInA.push(e);
    }
    for (const e of bucket.onlyInB || []) {
      if (!isScaffoldDiffEntry(e) && isFixed(L, 'onlyInB', e)) {
        inBoth.push({ key: e.key, a: e.artefact, b: e.artefact, match: 'aligned' });
      } else onlyInB.push(e);
    }
    hypoLayers[L] = { ...bucket, inBoth, onlyInA, onlyInB };
  }
  const hypo = { ...diff, layers: hypoLayers };

  const posture = computePostureMatrix(state.pack, state.packB);
  const before = computeDiagnosticGrade(state.pack, state.packB, posture, state.compareBId, diff);
  const after = computeDiagnosticGrade(state.pack, state.packB, posture, state.compareBId, hypo);
  return {
    before, after,
    beforePct: Math.round(before.overall.audit.scorePctExact),
    afterPct: Math.round(after.overall.audit.scorePctExact),
    chainAnchored: (diff.traceabilityGraph?.rollup?.declaredTotal || 0) > 0,
  };
}

// One sentence the demo hinges on. Returns '' when nothing would move.
export function projectionSentence(projection, n) {
  if (!projection) return '';
  const b = projection.before.overall.instrumentGrade;
  const a = projection.after.overall.instrumentGrade;
  if (projection.afterPct <= projection.beforePct) {
    return projection.chainAnchored
      ? `The grade is currently anchored on requirement-chain integrity — deploying these ${n} repairs chains on the next live verification (not projected here).`
      : '';
  }
  return `Fixing these ${n} takes you from ${b.letter} (${projection.beforePct}%) to ${a.letter} (${projection.afterPct}%) — projected by re-running the grade on the post-fix diff. Assumes the set verifies live on the next refresh; chain integrity, freshness and chaos are not projected.`;
}

// ---------- journey run history (sparklines + deltas) ----------

let _runsPromise = null;
let _runs = null;   // { journey, runs: [{gradeScore, alignmentPct, at, outcome}] } | null

export function runHistory() { return _runs; }

// Fire-and-forget loader: views call this; when it resolves with data
// the onReady callback fires once and runHistory() is populated.
export function loadRunHistory(onReady) {
  if (_runs) { return; }
  if (_runsPromise) { _runsPromise.then(onReady); return; }
  _runsPromise = (async () => {
    try {
      const { journeys = [] } = await api('/api/journeys');
      const j = journeys.find(x => x.lastRun) || journeys[0];
      if (!j) { _runs = { journey: null, runs: [] }; return; }
      const { runs = [] } = await api(`/api/journeys/${encodeURIComponent(j.name)}/runs?limit=20`);
      // Newest-first from the API → oldest-first for sparklines.
      _runs = {
        journey: j.name,
        runs: runs.slice().reverse().map(r => {
          // Raw run records carry grade.score; some summaries flatten it
          // to gradeScore — accept both shapes.
          const gradeScore = typeof r.gradeScore === 'number' ? r.gradeScore
            : typeof r.grade?.score === 'number' ? r.grade.score : null;
          return {
            gradeScore,
            alignmentPct: typeof r.drift?.alignmentPct === 'number' ? r.drift.alignmentPct : null,
            at: r.at || r.startedAt || null,
            outcome: r.outcome || null,
          };
        }),
      };
    } catch (_) {
      _runs = { journey: null, runs: [] };
    }
  })();
  _runsPromise.then(onReady);
}

export function runSeries(field) {
  const vals = (_runs?.runs || []).map(r => r[field]).filter(v => typeof v === 'number');
  return vals.length >= 2 ? vals : null;
}

// ---------- widgets ----------

export function sparklineSvg(values, { w = 96, h = 28 } = {}) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const span = (max - min) || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (w - 4) + 2;
    const y = h - 3 - ((v - min) / span) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(',');
  return `
    <svg class="mc-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true" preserveAspectRatio="none">
      <polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="currentColor"/>
    </svg>`;
}

// A mission-control stat tile. series/delta are optional; when run
// history is absent the tile says so instead of faking a trend.
export function kpiTile({ accent = 'cmp', label, value, unit = '', series = null, deltaText = '', note = '', warn = false }) {
  const spark = series ? sparklineSvg(series) : '';
  return `
    <div class="mc-tile is-${accent}${warn ? ' is-warn' : ''}">
      <div class="mc-tile-label">${escapeHtml(label)}</div>
      <div class="mc-tile-value">${value}<span class="mc-tile-unit">${escapeHtml(unit)}</span></div>
      <div class="mc-tile-trend">${spark}${deltaText ? `<span class="mc-tile-delta">${escapeHtml(deltaText)}</span>` : ''}</div>
      ${note ? `<div class="mc-tile-note">${escapeHtml(note)}</div>` : ''}
    </div>`;
}

export function deltaVsPrevious(series, unit = 'pp') {
  if (!series || series.length < 2) return '';
  const d = series[series.length - 1] - series[series.length - 2];
  if (!Number.isFinite(d)) return '';
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '▶';
  return `${arrow} ${Math.abs(d).toFixed(d % 1 ? 1 : 0)} ${unit} vs previous run`;
}

export function chip(status, text) {
  return `<span class="mc-chip is-${escapeHtml(status)}">${escapeHtml(text)}</span>`;
}

export function criterionChip(c) {
  const s = criterionScore(c);
  if (c.pass) return chip('pass', 'PASS');
  if (s > 0) return chip('partial', 'PARTIAL');
  return chip('fail', 'FAIL');
}

export function donutSvg(segs, centerText, { size = 104 } = {}) {
  const r = 40, cx = size / 2, cy = size / 2, sw = 16, C = 2 * Math.PI * r;
  const total = segs.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  const arcs = segs.filter(s => s.value > 0).map(s => {
    const len = (s.value / total) * C;
    const a = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    acc += len;
    return a;
  }).join('');
  const center = centerText
    ? `<text x="${cx}" y="${cy}" class="mc-donut-center" text-anchor="middle" dominant-baseline="central">${escapeHtml(String(centerText))}</text>` : '';
  return `<svg viewBox="0 0 ${size} ${size}" class="mc-donut" aria-hidden="true"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"/>${arcs}${center}</svg>`;
}

export function fmtUnits(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

// ---------- honesty blocks (non-negotiable, shared by both tabs) ----------

export function partialEvidenceBanner(model) {
  const ev = model.liveEvidence;
  if (!ev?.partial) return '';
  const aLabel = model.mode === 'drift' ? 'Declared, not live' : 'Beyond target';
  return `
    <div class="drift-partial-banner">
      <span class="drift-partial-key">⚠ PARTIAL LIVE EVIDENCE</span>
      ${ev.failed.length} of ${ev.attempted.length} probe${ev.failed.length === 1 ? '' : 's'} failed during the live draft
      (<code>${escapeHtml(ev.failed.join(', '))}</code>) — the live endpoint was likely mid-deploy or overloaded.
      Pack B may be missing whole surfaces, so <strong>"${escapeHtml(aLabel)}" is probably overstated</strong>.
      Redraft from MCP before acting on this drift.
    </div>`;
}

export function scaffoldOosNotes(model) {
  const bits = [];
  if (model.totals.scaffold) {
    bits.push(`<p class="drift-oos-note">${model.totals.scaffold} schema-required scaffold artefact${model.totals.scaffold === 1 ? '' : 's'} had no source evidence in the selected environment. Shown in the pack, excluded from drift badness.</p>`);
  }
  if (model.totals.outOfScope) {
    bits.push(`<p class="drift-oos-note">${model.totals.outOfScope} live artefact${model.totals.outOfScope === 1 ? '' : 's'} out of declared scope — members of families <strong>${escapeHtml(model.bName)}</strong> runs but your pack doesn't declare (the rest of the platform inventory). Shown for context, not counted as drift.</p>`);
  }
  return bits.join('');
}

export function verificationNote(model) {
  const t = model.diagnostic.trust;
  const warn = !t.hasMcpSource
    ? `<div class="diag-banner"><span class="diag-banner-key">WARN</span>
        Pack A carries no live signal. Drift &amp; freshness require an MCP-drafted or live-refreshed pack to verify.</div>`
    : '';
  return `${warn}
    <p class="mc-verification-note">Verification, not validation: this grade attests that declared artefacts
    are <em>verified against live state</em> — it does not claim the observability design itself is right.</p>`;
}

export function operabilityNote(model) {
  const op = model.diagnostic.operability || {};
  return escapeHtml(op.note || 'response readiness, not diagnostic capability — observed, displayed, never scored');
}

// Fix-kind chip vocabulary shared by the triage surfaces.
export function fixChip(fix) {
  const map = {
    deploy: ['deploy', 'DEPLOY'],
    retrofeed: ['retrofeed', 'RETROFEED'],
    adopt: ['retrofeed', 'ADOPT'],
    reconcile: ['reconcile', 'FIELD DECISION'],
    manual: ['manual', 'MANUAL'],
    'beyond-target': ['manual', 'BEYOND TARGET'],
  };
  const [cls, text] = map[fix] || ['manual', String(fix).toUpperCase()];
  return `<span class="mc-fix is-${cls}">${text}</span>`;
}

export function badnessClassChip(item) {
  if (item.kind === 'drifted') {
    const label = { decision: 'DECISION-BEARING', default: 'DEFAULT', cosmetic: 'COSMETIC' }[item.badnessClass] || 'DEFAULT';
    return chip(item.badnessClass === 'decision' ? 'fail' : item.badnessClass === 'cosmetic' ? 'info' : 'partial', label);
  }
  if (item.kind === 'onlyInA') return chip(item.badness >= 1 ? 'fail' : 'info', item.badness >= 1 ? 'MISSING LIVE' : 'EXTRA');
  return chip(item.badness >= 1 ? 'fail' : 'info', item.badness >= 1 ? 'MISSING' : 'SHADOW');
}
