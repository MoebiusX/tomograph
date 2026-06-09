// Pure diagnostic-grade scoring for the Diagnose view.
//
// Keep this module DOM-free so the clinical verdict can be unit-tested
// directly. compare-view.mjs is responsible for rendering only.

export const POSTURE_LAYERS = [
  { key: 'infra',    label: 'Infrastructure', hint: 'nodes · pods · disk · network' },
  { key: 'platform', label: 'Platform',       hint: 'db · cache · queue · gateway' },
  { key: 'app',      label: 'Application',    hint: 'service · API · job · business logic' },
  { key: 'ux',       label: 'User Experience',hint: 'frontend · journey · business outcome' },
];

export const POSTURE_MECHANISMS_PER_LAYER = [
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

export const DELTA_BADNESS = {
  declaredNotLive: 1.0,
  driftedDefault: 0.5,
  driftedDecisionBearing: 1.0,
  driftedCosmetic: 0.1,
  liveNotDeclared: 0.15,
};

// Trust threshold derived from decision cost, not a round-number vote:
// badness/aligned <= 0.176 means roughly one high-cost false reassurance
// per six confirmed controls. Fidelity = aligned / (aligned + badness).
export const DRIFT_BADNESS_PER_ALIGNED_TRUST_CEILING = 0.176;
export const DRIFT_FIDELITY_TRUST_THRESHOLD = 1 / (1 + DRIFT_BADNESS_PER_ALIGNED_TRUST_CEILING);
export const DRIFT_HEALTH_PASS_PCT = Math.round(DRIFT_FIDELITY_TRUST_THRESHOLD * 100);
export const DIAGNOSTIC_PASS_SCORE_THRESHOLD = 85;

const DECISION_BEARING_DELTA_RE = /(objective|target|threshold|window|duration|severity|burn|budget|expr|query|promql|expression|condition|sli|slo|metric|record|route|receiver|channel|contact|notification|pager|trigger|pipeline|exporter|backend|signal|good|total|mttd|mttr)/i;
const COSMETIC_DELTA_RE = /(title|label|labels|legend|display|layout|grid|position|folder|tag|tags|description|desc|summary|annotation|annotations|unit|color|schema|uid|source|provider)/i;
const CONTRACT_PACK_IDS = new Set(['target-advanced']);
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const DRIFT_FAIL_TOLERANCE = 0.30;

export function compareModeFor(packB, compareBId) {
  const bId = String(compareBId || packB?.id || '').toLowerCase();
  const src = inferPackSource(packB);
  const isLiveLike = /(^|[-_])(live|deployed|prod|runtime)([-_]|$)/.test(bId) || src === 'Live';
  if (isLiveLike) return 'drift';
  return 'gap';
}

export function isScaffoldArtefact(artefact) {
  return artefact?.source === 'Scaffold';
}

export function isScaffoldDiffEntry(entry) {
  return isScaffoldArtefact(entry?.artefact) || isScaffoldArtefact(entry?.a) || isScaffoldArtefact(entry?.b);
}

export function driftedEntryBadness(entry) {
  const fields = (entry?.deltas || []).map((d) => String(d.field || '')).filter(Boolean);
  if (fields.some((field) => DECISION_BEARING_DELTA_RE.test(field))) {
    return { weight: DELTA_BADNESS.driftedDecisionBearing, className: 'decision' };
  }
  if (fields.length > 0 && fields.every((field) => COSMETIC_DELTA_RE.test(field))) {
    return { weight: DELTA_BADNESS.driftedCosmetic, className: 'cosmetic' };
  }
  return { weight: DELTA_BADNESS.driftedDefault, className: 'default' };
}

export function computeWeightedDeltaRisk({ mode, aligned, driftedEntries = [], drifted, onlyInA, onlyInB }) {
  const aWeight = mode === 'drift'
    ? DELTA_BADNESS.declaredNotLive
    : DELTA_BADNESS.liveNotDeclared;
  const bWeight = mode === 'drift'
    ? DELTA_BADNESS.liveNotDeclared
    : DELTA_BADNESS.declaredNotLive;
  const driftEntries = driftedEntries.length
    ? driftedEntries
    : Array.from({ length: drifted || 0 }, () => null);
  const driftedBreakdown = { decision: 0, default: 0, cosmetic: 0 };
  let driftedUnits = 0;
  for (const entry of driftEntries) {
    if (isScaffoldDiffEntry(entry)) continue;
    const cost = driftedEntryBadness(entry);
    driftedBreakdown[cost.className] += 1;
    driftedUnits += cost.weight;
  }
  const onlyInAUnits = onlyInA * aWeight;
  const onlyInBUnits = onlyInB * bWeight;
  const totalBadness = driftedUnits + onlyInAUnits + onlyInBUnits;
  const denominator = aligned + totalBadness;
  const health = denominator === 0 ? 1 : aligned / denominator;
  const healthPct = Math.round(health * 100);
  return {
    aWeight,
    bWeight,
    driftedUnits,
    driftedBreakdown,
    onlyInAUnits,
    onlyInBUnits,
    totalBadness,
    health,
    healthPct,
  };
}

export function criterionScore(c) {
  return typeof c?.score === 'number' ? Math.max(0, Math.min(1, c.score)) : (c?.pass ? 1 : 0);
}

export function diagnosticScorePercent(passed, total) {
  return total === 0 ? 0 : (passed / total) * 100;
}

export function diagnosticAuditStatus(passed, total) {
  const scorePctExact = diagnosticScorePercent(passed, total);
  const passes = scorePctExact > DIAGNOSTIC_PASS_SCORE_THRESHOLD;
  return {
    passes,
    status: passes ? 'PASS' : 'FAIL',
    scorePctExact,
    threshold: DIAGNOSTIC_PASS_SCORE_THRESHOLD,
  };
}

export function computeDiagnosticGrade(packA, packB, posture, catalogBId, diff, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const ann = packA?.meta?.annotations || packA?.metadata?.annotations || {};
  const L1 = packA?.layers?.L1 || [];
  const L2 = packA?.layers?.L2 || [];
  const L4 = packA?.layers?.L4 || {};
  const L5 = packA?.layers?.L5 || [];

  const signalsPresent = new Set();
  for (const b of L2) {
    const sig = String(b.spec?.signal || b.signal || '').toLowerCase();
    if (['metrics','logs','traces','profiles'].includes(sig)) signalsPresent.add(sig);
  }
  const allSignals = ['metrics','logs','traces','profiles'];
  const signalsCount = signalsPresent.size;
  const multiModal = signalsCount >= 3;

  const otel = L2.find(a => /^OTEL-/.test(a.id || ''));
  const propagators = otel?.spec?.sdk?.propagators || otel?.sdk?.propagators || [];
  const hasTraceContext = (Array.isArray(propagators) ? propagators : [])
    .some(p => /tracecontext/i.test(String(p)));
  const logCorrelationDeclared = !!(otel?.spec?.log_correlation === true || otel?.log_correlation === true);
  const correlated = hasTraceContext && (logCorrelationDeclared || signalsPresent.has('logs'));

  const hasBaselines = L5.some(a => /baseline/i.test(a.id || '') || /baseline/i.test(a.title || ''));
  const slos = L1.filter(a => /^SLO-/.test(a.id || ''));
  const slosWithObjective = slos.filter(a => {
    const obj = a.spec?.objective ?? a.objective;
    return typeof obj === 'number' && obj > 0 && obj <= 1;
  });
  const calibrated = hasBaselines && slosWithObjective.length > 0;

  let totalObserved = 0;
  for (const l of POSTURE_LAYERS) {
    let present = 0, evidence = 0;
    for (const m of POSTURE_MECHANISMS_PER_LAYER) {
      const arr = posture?.cells?.[`${l.key}:${m.key}`];
      if (arr && arr.length) {
        if (arr.every(a => a._evidence)) evidence++;
        else present++;
      }
    }
    totalObserved += (present + evidence) / POSTURE_MECHANISMS_PER_LAYER.length;
  }
  const avgObservedPct = Math.round((totalObserved / POSTURE_LAYERS.length) * 100);
  const comprehensive = avgObservedPct >= 50;

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
        : 'tracecontext propagator missing - logs/traces cannot be joined',
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
        : 'no runbooks linked - when an alert fires, oncall has no scripted response',
    },
  ];

  const annB = packB?.meta?.annotations || packB?.metadata?.annotations || {};
  const hasMcpAnnotations = (a) => !!a && Object.keys(a).some(k => k.startsWith('mcp.'));
  const liveAnn = hasMcpAnnotations(annB) ? annB : ann;

  const chaosCount = L5.filter(a => /^CHAOS-/.test(a.id || '')).length;
  const chaosValidated = chaosCount > 0;

  const probesAttempted = (liveAnn['mcp.probesAttempted']  || '').split(',').filter(Boolean);
  const probesSucceeded = (liveAnn['mcp.probesSucceeded']  || '').split(',').filter(Boolean);
  const probesEmpty     = (liveAnn['mcp.probesEmpty']      || '').split(',').filter(Boolean);
  const probesFailed    = (liveAnn['mcp.probesFailed']     || '').split(',').filter(Boolean);
  const hasMcpSource = probesAttempted.length > 0 || !!liveAnn['mcp.refreshedAt'];
  let driftFree, driftDetail, driftScore;
  const hasLiveDiff = !!diff?.layers && compareModeFor(packB, catalogBId) === 'drift';
  if (hasLiveDiff) {
    const branchRollup = diff.traceabilityGraph?.rollup;
    if (branchRollup && branchRollup.declaredTotal > 0) {
      driftScore = Math.max(0, Math.min(1, branchRollup.integrityMean ?? 0));
      driftFree = driftScore >= DRIFT_FIDELITY_TRUST_THRESHOLD;
      const confidence = (diff.traceabilityGraph?.branches || []).some(b => b.confidence === 'inferred')
        ? 'some inferred edges'
        : 'declared edges';
      driftDetail = driftFree
        ? `requirement-chain integrity ${branchRollup.integrityPct}% - ${branchRollup.intact}/${branchRollup.declaredTotal} declared commitment${branchRollup.declaredTotal === 1 ? '' : 's'} intact; ${branchRollup.partial} partial, ${branchRollup.broken} broken, ${branchRollup.undeclared} live-only; ${confidence}`
        : `requirement-chain integrity ${branchRollup.integrityPct}% (<${DRIFT_HEALTH_PASS_PCT}% trust threshold) - ${branchRollup.intact}/${branchRollup.declaredTotal} declared commitment${branchRollup.declaredTotal === 1 ? '' : 's'} intact; ${branchRollup.partial} partial, ${branchRollup.broken} broken, ${branchRollup.undeclared} live-only; ${confidence}`;
    } else {
      let alignedLive = 0;
      let declaredMissing = 0;
      let behaviorDrifted = 0;
      let liveShadow = 0;
      let scaffoldExcluded = 0;
      const driftedEntries = [];
      for (const bucket of Object.values(diff.layers || {})) {
        const concreteOnlyInA = (bucket.onlyInA || []).filter(e => !isScaffoldDiffEntry(e));
        const concreteOnlyInB = (bucket.onlyInB || []).filter(e => !isScaffoldDiffEntry(e));
        const concreteInBoth = (bucket.inBoth || []).filter(e => !isScaffoldDiffEntry(e));
        scaffoldExcluded += (bucket.onlyInA || []).filter(e => isScaffoldDiffEntry(e)).length
          + (bucket.onlyInB || []).filter(e => isScaffoldDiffEntry(e)).length
          + (bucket.inBoth || []).filter(e => isScaffoldDiffEntry(e)).length;
        declaredMissing += concreteOnlyInA.length;
        const bucketDrifted = concreteInBoth.filter(e => e.match === 'drifted');
        behaviorDrifted += bucketDrifted.length;
        driftedEntries.push(...bucketDrifted);
        alignedLive += concreteInBoth.filter(e => e.match !== 'drifted').length;
        liveShadow += concreteOnlyInB.length;
      }
      const weighted = computeWeightedDeltaRisk({
        mode: 'drift',
        aligned: alignedLive,
        driftedEntries,
        drifted: behaviorDrifted,
        onlyInA: declaredMissing,
        onlyInB: liveShadow,
      });
      driftScore = Math.max(0, Math.min(1, weighted.health));
      driftFree = weighted.health >= DRIFT_FIDELITY_TRUST_THRESHOLD;
      const fmtUnits = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
      const driftBreakdown = `${weighted.driftedBreakdown.decision} decision-bearing, ${weighted.driftedBreakdown.default} default, ${weighted.driftedBreakdown.cosmetic} cosmetic`;
      const scaffoldNote = scaffoldExcluded ? `; ${scaffoldExcluded} scaffold excluded` : '';
      driftDetail = driftFree
        ? `weighted live-fidelity ${weighted.healthPct}% - declared-not-live ${declaredMissing}x1.0, drifted ${behaviorDrifted} (${driftBreakdown}), live-not-declared ${liveShadow}x0.15; ${fmtUnits(weighted.totalBadness)} badness units${scaffoldNote}`
        : `weighted live-fidelity ${weighted.healthPct}% (<${DRIFT_HEALTH_PASS_PCT}% trust threshold); declared-not-live ${declaredMissing}x1.0, drifted ${behaviorDrifted} (${driftBreakdown}), live-not-declared ${liveShadow}x0.15; ${fmtUnits(weighted.totalBadness)} badness units${scaffoldNote}`;
    }
  } else if (!hasMcpSource) {
    driftFree = false;
    driftScore = 0;
    driftDetail = 'declared-only - no live signal to verify against (connect MCP or scan live)';
  } else if (probesAttempted.length === 0) {
    driftFree = true;
    driftScore = 1;
    driftDetail = 'live source connected - probe table not recorded';
  } else {
    const driftCount = probesEmpty.length + probesFailed.length;
    const driftRatio = driftCount / probesAttempted.length;
    driftFree = driftRatio <= DRIFT_FAIL_TOLERANCE;
    driftScore = Math.max(0, Math.min(1, 1 - driftRatio));
    const pct = Math.round(driftRatio * 100);
    driftDetail = driftFree
      ? `${probesSucceeded.length}/${probesAttempted.length} probes confirmed (${pct}% empty or failed, within ${Math.round(DRIFT_FAIL_TOLERANCE * 100)}% tolerance)`
      : `${driftCount}/${probesAttempted.length} probes empty or failed (${pct}%) - declared surface exceeds what live attests`;
  }

  const refreshedAtStr = liveAnn['mcp.refreshedAt'];
  let fresh, freshDetail;
  if (!refreshedAtStr) {
    fresh = false;
    freshDetail = 'no mcp.refreshedAt annotation - pack has never been verified against live state';
  } else {
    const refreshedAtMs = Date.parse(refreshedAtStr);
    if (!Number.isFinite(refreshedAtMs)) {
      fresh = false;
      freshDetail = `mcp.refreshedAt is unparseable (${refreshedAtStr})`;
    } else {
      const ageMs = nowMs - refreshedAtMs;
      const ageHrs = Math.round(ageMs / 3600000);
      fresh = ageMs <= FRESH_WINDOW_MS;
      freshDetail = fresh
        ? `last refreshed ${ageHrs}h ago - within 24h staleness window`
        : `last refreshed ${ageHrs}h ago - exceeds 24h staleness window, signals may have drifted`;
    }
  }

  const trustCriteria = [
    { key: 'chaos-validated', label: 'Chaos-validated', sub: 'recovery proven by fault injection',
      pass: chaosValidated,
      detail: chaosCount > 0
        ? `${chaosCount} chaos experiment${chaosCount === 1 ? '' : 's'} declared`
        : 'no chaos experiments - recovery procedures are theoretical',
    },
    { key: 'drift-free',      label: 'Drift-free',      sub: 'declarations match live state',
      pass: driftFree,
      score: driftScore,
      detail: driftDetail,
    },
    { key: 'fresh',           label: 'Fresh',           sub: 'recently verified against live',
      pass: fresh,
      detail: freshDetail,
    },
  ];

  const sumScore = (items) => items.reduce((n, c) => n + criterionScore(c), 0);
  const coveragePassed = sumScore(coverageCriteria);
  const trustPassed = sumScore(trustCriteria);
  const overallPassed = coveragePassed + trustPassed;
  const overallTotal = coverageCriteria.length + trustCriteria.length;
  const verdict =
    overallPassed >= 7 ? { word: 'Diagnostic-grade',          level: 'is-grade' } :
    overallPassed >= 5 ? { word: 'Almost diagnostic-grade',   level: 'is-almost' } :
    overallPassed >= 3 ? { word: 'Not yet diagnostic-grade',  level: 'is-not-yet' } :
                         { word: 'Far from diagnostic-grade', level: 'is-far' };
  const audit = diagnosticAuditStatus(overallPassed, overallTotal);

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
      audit,
      liveDriftFree: driftFree,
    },
    traceabilityGraph: diff?.traceabilityGraph || null,
  };
}

export function isObservabilityContractPack(pack, catalogId) {
  if (!pack) return false;
  const role = pack.meta?.annotations?.['studio.role'] || pack.metadata?.annotations?.['studio.role'];
  if (String(role || '').toLowerCase() === 'contract') return true;
  const slot = String(catalogId || '').toLowerCase();
  if (slot && CONTRACT_PACK_IDS.has(slot)) return true;
  if (slot && /(^|-)contract($|-)/i.test(slot)) return true;
  if (slot && /(^|-)ola($|-)/i.test(slot)) return true;
  const id = String(pack.id || pack.meta?.id || pack.metadata?.name || '').toLowerCase();
  if (CONTRACT_PACK_IDS.has(id)) return true;
  if (/(^|-)contract($|-)/i.test(id)) return true;
  if (/(^|-)ola($|-)/i.test(id)) return true;
  return false;
}

export function contractLabelFor(packB, catalogId) {
  if (!packB) return null;
  if (isObservabilityContractPack(packB, catalogId)) return 'Observability Contract';
  return packB?.meta?.name || packB?.metadata?.name || packB?.id || 'reference pack';
}

function inferPackSource(pack) {
  if (!pack) return 'Pack';
  const id = (pack.id || '').toLowerCase();
  if (id.includes('live')) return 'Live';
  if (id.includes('target')) return 'Target';
  if (id.includes('curated')) return 'Repo';
  if (id.includes('skeleton')) return 'Demo';
  const first = (pack?.layers?.L1 || [])[0];
  if (first?.source === 'Verified') return 'Live';
  return 'Repo';
}
