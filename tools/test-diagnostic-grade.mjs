import {
  POSTURE_LAYERS,
  POSTURE_MECHANISMS_PER_LAYER,
  computeDiagnosticGrade,
  computeWeightedDeltaRisk,
  diagnosticAuditStatus,
} from '../studio/diagnostic-grade.mjs';

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function closeTo(actual, expected, epsilon = 1e-9) {
  return Math.abs(actual - expected) <= epsilon;
}

function criterion(result, key) {
  return [...result.coverage.criteria, ...result.trust.criteria].find((item) => item.key === key);
}

function baseRepoPack() {
  return {
    id: 'krystaline',
    meta: {
      name: 'krystaline',
      annotations: {},
    },
    layers: {
      L1: [
        { id: 'SLI-latency', title: 'Latency SLI' },
        { id: 'SLO-latency', title: 'Latency SLO', spec: { objective: 0.99 } },
      ],
      L2: [
        {
          id: 'OTEL-node',
          title: 'OpenTelemetry SDK',
          spec: {
            signal: 'traces',
            sdk: { propagators: ['tracecontext'] },
            log_correlation: true,
          },
        },
        { id: 'MET-prometheus', title: 'Prometheus metrics', spec: { signal: 'metrics' } },
        { id: 'LOG-loki', title: 'Structured logs', spec: { signal: 'logs' } },
      ],
      L4: {
        healing: [{ id: 'HEAL-latency', title: 'Latency runbook' }],
      },
      L5: [
        { id: 'BASE-latency', title: 'MTTD/MTTR baseline' },
        { id: 'CHAOS-latency', title: 'Latency fault injection' },
      ],
    },
  };
}

function livePack(annotations = {}) {
  return {
    id: 'production-live',
    meta: {
      name: 'production-live',
      annotations,
    },
    layers: {
      L1: [{ id: 'LIVE-latency', source: 'Verified' }],
    },
  };
}

function fullPosture() {
  const cells = {};
  for (const layer of POSTURE_LAYERS) {
    for (const mechanism of POSTURE_MECHANISMS_PER_LAYER) {
      cells[`${layer.key}:${mechanism.key}`] = [
        { id: `${layer.key}-${mechanism.key}`, title: `${layer.label} ${mechanism.label}` },
      ];
    }
  }
  return { cells };
}

function traceabilityDiff(integrityMean) {
  const integrityPct = Math.round(integrityMean * 100);
  return {
    layers: {},
    traceabilityGraph: {
      rollup: {
        declaredTotal: 10,
        integrityMean,
        integrityPct,
        intact: Math.round(integrityMean * 10),
        partial: 10 - Math.round(integrityMean * 10),
        broken: 0,
        undeclared: 0,
      },
      branches: [{ confidence: 'derived' }],
    },
  };
}

const nowMs = Date.parse('2026-06-09T12:00:00Z');

{
  const exactlyEightyFive = diagnosticAuditStatus(6.8, 8);
  assert(exactlyEightyFive.status === 'FAIL', 'exactly 85% must fail because the gate is strictly >85%', exactlyEightyFive);
  assert(closeTo(exactlyEightyFive.scorePctExact, 85), '85% boundary score should be exact', exactlyEightyFive);

  const overEightyFive = diagnosticAuditStatus(6.81, 8);
  assert(overEightyFive.status === 'PASS', 'scores above 85% should pass', overEightyFive);
}

{
  const result = computeDiagnosticGrade(
    baseRepoPack(),
    livePack({ 'mcp.refreshedAt': '2026-06-09T11:00:00Z' }),
    fullPosture(),
    'production-live',
    traceabilityDiff(0.9),
    { nowMs },
  );

  assert(result.overall.audit.status === 'PASS', 'high traceability integrity plus fresh live evidence should pass', result.overall);
  assert(result.overall.verdict.word === 'Diagnostic-grade', 'passing verdict should be diagnostic-grade', result.overall.verdict);
  assert(result.coverage.passed === 5, 'all five coverage clauses should pass', result.coverage);
  assert(closeTo(result.trust.passed, 2.9), 'trust score should include fractional drift fidelity', result.trust);
  assert(criterion(result, 'drift-free').pass === true, '0.90 traceability integrity should satisfy drift-free');
  assert(closeTo(criterion(result, 'drift-free').score, 0.9), 'drift-free score should equal integrity mean');
}

{
  const result = computeDiagnosticGrade(
    baseRepoPack(),
    livePack(),
    fullPosture(),
    'production-live',
    traceabilityDiff(0.8),
    { nowMs },
  );

  assert(closeTo(result.overall.passed, 6.8), 'boundary setup should score exactly 6.8/8', result.overall);
  assert(result.overall.audit.status === 'FAIL', 'exactly 85% should not pass the diagnostic-grade audit', result.overall.audit);
  assert(result.overall.verdict.word === 'Almost diagnostic-grade', '85% boundary should remain almost diagnostic-grade', result.overall.verdict);
  assert(criterion(result, 'fresh').pass === false, 'missing refreshedAt should fail freshness');
}

{
  const weighted = computeWeightedDeltaRisk({
    mode: 'drift',
    aligned: 10,
    driftedEntries: [
      { deltas: [{ field: 'expr' }] },
      { deltas: [{ field: 'title' }] },
      { deltas: [{ field: 'unknown_field' }] },
      { a: { source: 'Scaffold' }, deltas: [{ field: 'expr' }] },
    ],
    onlyInA: 2,
    onlyInB: 4,
  });

  assert(weighted.driftedBreakdown.decision === 1, 'decision-bearing drift should be counted separately', weighted);
  assert(weighted.driftedBreakdown.cosmetic === 1, 'cosmetic drift should be counted separately', weighted);
  assert(weighted.driftedBreakdown.default === 1, 'default drift should be counted separately', weighted);
  assert(closeTo(weighted.driftedUnits, 1.6), 'drifted badness should apply 1.0 + 0.1 + 0.5 weights', weighted);
  assert(closeTo(weighted.onlyInAUnits, 2), 'declared-not-live should carry 1.0 weight in drift mode', weighted);
  assert(closeTo(weighted.onlyInBUnits, 0.6), 'live-not-declared should carry 0.15 weight in drift mode', weighted);
  assert(closeTo(weighted.totalBadness, 4.2), 'total weighted badness should exclude scaffold entries', weighted);
}

{
  const result = computeDiagnosticGrade(
    baseRepoPack(),
    livePack({
      'mcp.refreshedAt': '2026-06-09T11:00:00Z',
      'mcp.probesAttempted': 'a,b,c,d,e,f,g,h,i,j',
      'mcp.probesSucceeded': 'a,b,c,d,e,f,g',
      'mcp.probesEmpty': 'h,i',
      'mcp.probesFailed': 'j',
    }),
    fullPosture(),
    'production-live',
    null,
    { nowMs },
  );

  assert(criterion(result, 'drift-free').pass === true, '30% empty/failed probes should still pass fallback drift tolerance');
  assert(closeTo(criterion(result, 'drift-free').score, 0.7), 'probe fallback should award 1 - drift ratio');
}

{
  const result = computeDiagnosticGrade(
    baseRepoPack(),
    livePack({
      'mcp.refreshedAt': '2026-06-09T11:00:00Z',
      'mcp.probesAttempted': 'a,b,c,d,e,f,g,h,i,j',
      'mcp.probesSucceeded': 'a,b,c,d,e,f',
      'mcp.probesEmpty': 'g,h',
      'mcp.probesFailed': 'i,j',
    }),
    fullPosture(),
    'production-live',
    null,
    { nowMs },
  );

  assert(criterion(result, 'drift-free').pass === false, '40% empty/failed probes should fail fallback drift tolerance');
  assert(closeTo(criterion(result, 'drift-free').score, 0.6), 'failed probe fallback should still award fractional evidence credit');
}

console.log('all diagnostic-grade assertions pass.');
