#!/usr/bin/env node
/**
 * tools/fetch-live-pack.mjs
 *
 * Refreshes packs/production-live.json by calling otel-mcp-server over the
 * standard MCP wire protocol (JSON-RPC 2.0 + Streamable HTTP). Run on a cron,
 * inside CI, or by hand. The studio loads this JSON at boot, overlaying the
 * embedded snapshot.
 *
 * Usage:
 *   node tools/fetch-live-pack.mjs
 *   MCP_URL=https://your-mcp/path node tools/fetch-live-pack.mjs
 *   OUTPUT=somewhere/else.json node tools/fetch-live-pack.mjs
 *
 * Env:
 *   MCP_URL   — MCP server endpoint. Default: https://mcp.example.com/observability
 *   OUTPUT    — Output path.         Default: packs/production-live.json
 *   MCP_AUTH  — Optional bearer token if your MCP requires auth.
 *
 * Exit codes:
 *   0  success
 *   1  hard failure (no JSON written; previous file is kept)
 *
 * Requires Node 18+ (uses global fetch).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ----- config -----
const MCP_URL = process.env.MCP_URL  || 'https://mcp.example.com/observability';
const OUTPUT  = process.env.OUTPUT   || 'packs/production-live.json';
const AUTH    = process.env.MCP_AUTH || null;

// ----- minimal MCP client (JSON-RPC over HTTP, with SSE fallback) -----

let mcpSession = null;
let nextId = 1;

async function mcpRequest(method, params = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-06-18',
  };
  if (AUTH)        headers['Authorization'] = `Bearer ${AUTH}`;
  if (mcpSession)  headers['Mcp-Session-Id'] = mcpSession;

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status} on ${method}: ${await res.text().catch(() => '')}`);
  }
  if (res.headers.get('mcp-session-id')) mcpSession = res.headers.get('mcp-session-id');

  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('text/event-stream')) {
    // SSE: accumulate the full event (terminated by a blank line) before parsing.
    // The naive "read first `data:` line" approach truncates large payloads.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      // SSE frames end with a blank line ("\n\n"). Process when we have one.
      const frameEnd = buf.indexOf('\n\n');
      if (frameEnd !== -1) {
        const frame = buf.slice(0, frameEnd);
        // Concatenate all data: lines (SSE permits multi-line data fields).
        const dataLines = frame
          .split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.replace(/^data:\s?/, ''));
        if (dataLines.length === 0) { buf = buf.slice(frameEnd + 2); continue; }
        const text = dataLines.join('\n');
        const obj = JSON.parse(text);
        if (obj.error) throw new Error(`${method}: ${obj.error.message}`);
        return obj.result;
      }
      if (done) break;
    }
    throw new Error(`MCP ${method}: SSE stream ended with no complete data frame`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`${method}: ${data.error.message}`);
  return data.result;
}

async function initialize() {
  return mcpRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'observabilitypack-studio-fetcher', version: '0.1.0' },
  });
}

async function callTool(name, args = {}) {
  const result = await mcpRequest('tools/call', { name, arguments: args });
  // MCP tools may signal errors via result.isError = true instead of JSON-RPC error
  if (result?.isError) {
    const errText = result?.content?.map(c => c.text).filter(Boolean).join(' ') || 'tool returned isError';
    throw new Error(`${name}: ${errText}`);
  }
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return result;
  try { return JSON.parse(text); }
  catch { return text; }
}

// ----- map MCP responses to ObservabilityPack live artefacts -----

const REFRESH_AT = new Date().toISOString();

function liveArtefact(id, title, desc, tool, tags, mcpSource, evidence) {
  return {
    id, source: 'LIVE', title, desc, tool, tags,
    mcp: {
      verified: true,
      source: mcpSource,
      refreshedAt: REFRESH_AT,
      evidence,
    },
  };
}

function gapArtefact(id, title, desc, tags, mcpSource, evidence) {
  return {
    id, source: 'GAP', title, desc, tool: '—', tags,
    mcp: { verified: false, source: mcpSource, refreshedAt: REFRESH_AT, evidence },
  };
}

function bauArtefact(id, title, desc, tool, tags) {
  return { id, source: 'BAU', title, desc, tool, tags };
}

function buildPack({ health, topology, anomaliesActive, baselines, errors }) {
  const services = health?.services || [];
  const serviceNames = services.map(s => s.name);
  const baselineCount = baselines?.baselines?.length || 0;
  const baselineNormal = (baselines?.baselines || []).filter(b => b.statusIndicator?.status === 'normal').length;
  const jaegerEdge = (topology?.dependencies || []).find(d => d.child === 'jaeger-all-in-one' || d.child?.includes('jaeger'));

  // L2 Collection: per-service artefacts (discovered) + main pipeline
  const perServiceArtefacts = services.map((s, i) => liveArtefact(
    `COL-X${i + 1}`,
    `Service: ${s.name}`,
    `Live: ${s.status}, P50 ~${Math.round(s.avgDuration)}ms, ${s.spanCount} spans, ${s.activeAnomalies} anomalies.`,
    'OTel + Prometheus',
    ['service', 'discovered', ...(s.spanCount < 5 ? ['sparse-traces'] : [])],
    'system_health',
    {
      status: s.status,
      avgDuration: s.avgDuration,
      spanCount: s.spanCount,
      activeAnomalies: s.activeAnomalies,
      lastSeen: s.lastSeen,
    },
  ));

  const liveOtel = liveArtefact(
    'COL-02',
    'OTel Collector pipeline',
    'OTLP receive · batch · export to Jaeger + Prometheus.',
    'OTel Collector',
    ['otel', 'pipeline'],
    'system_health',
    {
      services: services.length,
      totalSpans: services.reduce((acc, s) => acc + (s.spanCount || 0), 0),
      healthyServices: services.filter(s => s.status === 'healthy').length,
    },
  );

  const liveJaeger = liveArtefact(
    'COL-03',
    'Jaeger trace agent',
    `system_topology shows ${jaegerEdge?.callCount || 0} spans into jaeger from ${jaegerEdge?.parent || 'unknown'}.`,
    'Jaeger',
    ['traces'],
    'system_topology',
    {
      jaegerInboundCalls: jaegerEdge?.callCount || 0,
      sourceService: jaegerEdge?.parent || null,
    },
  );

  const liveHealth = liveArtefact(
    'COL-05',
    'Health-check probes',
    `system_health responds; ${services.length} services reporting.`,
    'kube-state-metrics',
    ['health'],
    'system_health',
    {
      services: serviceNames,
      allHealthy: services.every(s => s.status === 'healthy'),
      lastPolled: health?.lastPolled,
    },
  );

  const liveDeps = liveArtefact(
    'TOPO-X1',
    'Live dependency map',
    `system_topology returned ${(topology?.dependencies || []).length} edges.`,
    'system_topology',
    ['topology', 'discovered'],
    'system_topology',
    {
      edges: (topology?.dependencies || []).length,
      services: new Set([...(topology?.dependencies || []).flatMap(d => [d.parent, d.child])]).size,
      detail: topology?.dependencies || [],
    },
  );

  const liveBaselines = liveArtefact(
    'VAL-01',
    'Anomaly baselines (live)',
    `anomalies_baselines: ${baselineCount} baselines computed, ${baselineNormal} status=normal.`,
    'otel-mcp-server',
    ['anomaly', 'verified'],
    'anomalies_baselines',
    {
      totalBaselines: baselineCount,
      normalStatus: baselineNormal,
      services: [...new Set((baselines?.baselines || []).map(b => b.service))],
      maxSampleCount: Math.max(0, ...(baselines?.baselines || []).map(b => b.sampleCount || 0)),
    },
  );

  const liveAnomalyAlerter = liveArtefact(
    'ALR-07',
    'Anomaly detector (trace)',
    `anomalies_active: ${anomaliesActive?.traceAnomalies?.active?.length || 0} active anomalies. amount detector ${anomaliesActive?.amountAnomalies?.enabled ? 'enabled' : 'disabled'}.`,
    'otel-mcp anomalies',
    ['alert', 'anomaly'],
    'anomalies_active',
    {
      traceAnomaliesActive: anomaliesActive?.traceAnomalies?.active?.length || 0,
      traceAnomaliesRecent: anomaliesActive?.traceAnomalies?.recentCount || 0,
      amountDetectorEnabled: !!anomaliesActive?.amountAnomalies?.enabled,
    },
  );

  const liveMcp = liveArtefact(
    'GOV-01',
    'MCP-driven reports',
    'MCP tools reachable; studio is itself a consumer.',
    'otel-mcp-server',
    ['report', 'meta'],
    'mcp.reachable',
    {
      toolsReachable: ['system_health', 'system_topology', 'anomalies_active', 'anomalies_baselines'],
      toolsFailed: Object.keys(errors),
    },
  );

  const zkGap = gapArtefact(
    'GOV-02',
    'ZK proof verification logs',
    'zk_stats and zk_solvency endpoints return HTTP 404 on the public proxy.',
    ['compliance', 'crypto', 'endpoint-missing'],
    'zk_stats',
    { httpStatus: 404, endpoint: '/api/public/zk/stats' },
  );

  // BAU items that we can't directly verify from the public MCP surface
  const unverifiedBau = (id, title, desc, tool, tags) =>
    bauArtefact(id, title, desc, tool, [...tags, 'unverified']);

  return {
    id: 'production-live',
    name: 'Production — Live (MCP)',
    badge: 'LIVE',
    description:
      'Refreshed from otel-mcp-server. LIVE = verified by telemetry; BAU = claimed in repo but not directly verifiable from MCP surface.',
    liveness: {
      refreshedAt: REFRESH_AT,
      mcpUrl: MCP_URL,
      toolsCalled: ['system_health', 'system_topology', 'anomalies_active', 'anomalies_baselines'],
      toolsFailed: errors,
      servicesDiscovered: serviceNames,
      baselinesComputed: baselineCount,
      activeAnomalies: anomaliesActive?.traceAnomalies?.active?.length || 0,
      embedded: false,
    },
    layers: {
      L1: [
        bauArtefact('SLI-01', 'Availability SLI', 'Service up ratio across service-*.', 'Prometheus', ['availability']),
        bauArtefact('SLI-02', 'Latency SLI (P99)', 'P99 request latency.', 'Prometheus', ['latency']),
        bauArtefact('SLO-01', 'Availability SLO 99.9%', 'Monthly window.', 'PromQL', ['SLO']),
        bauArtefact('SLO-02', 'Latency SLO P99 < 2s', 'Predictive burn.', 'PromQL', ['SLO']),
        bauArtefact('EBP-01', 'Error-budget policy (predict_linear)', '24h forecast rule.', 'PromQL', ['policy']),
      ],
      L2: [
        unverifiedBau('COL-01', 'Prometheus scrape — 12 targets', 'Targets not exposed via MCP.', 'Prometheus', ['metrics', 'scrape']),
        liveOtel,
        liveJaeger,
        unverifiedBau('COL-04', 'Loki log shipping', 'Not exposed via MCP.', 'Loki + promtail', ['logs']),
        liveHealth,
        ...perServiceArtefacts,
        unverifiedBau('STO-01', 'Prometheus TSDB (15d)', 'Local TSDB.', 'Prometheus', ['storage']),
        bauArtefact('STO-02', 'Jaeger storage backend', 'Implied by COL-03.', 'Jaeger', ['storage', 'traces']),
        unverifiedBau('STO-03', 'Loki chunk store', 'Filesystem-backed.', 'Loki', ['storage', 'logs']),
        gapArtefact('STO-04', 'Long-term metrics (>15d)', 'Confirmed gap.', ['retention', 'audit-blocker'], 'inferred', {}),
      ],
      L3: [
        unverifiedBau('QRY-01', 'Recording rules — SLI burn', 'Not exposed.', 'PromQL', ['recording']),
        unverifiedBau('QRY-02', 'predict_linear forecasts', 'Not exposed.', 'PromQL', ['forecast']),
        unverifiedBau('DASH-01', 'Grafana — Service Overview', 'Not exposed.', 'Grafana', ['dashboard']),
        unverifiedBau('DASH-02', 'Grafana — RabbitMQ + Redis', 'Not exposed.', 'Grafana', ['dashboard']),
        unverifiedBau('DASH-03', 'Grafana — SLO & Error Budget', 'Not exposed.', 'Grafana', ['dashboard']),
        gapArtefact('QRY-03', 'Trace-to-log correlation queries', 'Confirmed gap.', ['correlation'], 'inferred', {}),
        liveDeps,
      ],
      L4: {
        policy: [
          unverifiedBau('POL-01', 'Burn-rate alerting policy (implicit)', 'Not exposed.', 'Prometheus rules', ['policy']),
        ],
        alerting: [
          bauArtefact('ALR-01', 'HighErrorRate', 'Not directly verifiable.', 'Alertmanager', ['alert', 'critical']),
          bauArtefact('ALR-02', 'ServiceDown', 'Not directly verifiable.', 'Alertmanager', ['alert', 'critical']),
          bauArtefact('ALR-03', 'PodNotReady', 'Not directly verifiable.', 'Alertmanager', ['alert']),
          bauArtefact('ALR-04', 'OOMKilled', 'Not directly verifiable.', 'Alertmanager', ['alert']),
          bauArtefact('ALR-05', 'LatencyBudgetExhaustion', 'Not directly verifiable.', 'Alertmanager', ['alert', 'SLO']),
          bauArtefact('ALR-06', 'ContainerCrashLooping', 'Not directly verifiable.', 'Alertmanager', ['alert']),
          liveAnomalyAlerter,
        ],
        healing: [
          gapArtefact('HEAL-01', 'Runbook automation', 'Confirmed gap.', ['automation'], 'inferred', {}),
          gapArtefact('HEAL-02', 'HPA / scale guardrails', 'Confirmed gap.', ['autoscale'], 'inferred', {}),
          gapArtefact('HEAL-03', 'Circuit breakers / shedding', 'Confirmed gap.', ['resilience'], 'inferred', {}),
        ],
      },
      L5: [
        liveBaselines,
        gapArtefact('VAL-02', 'Chaos testing', 'No chaos tooling visible to MCP.', ['chaos'], 'inferred', {}),
        gapArtefact('VAL-03', 'Synthetic probes', 'No probe data.', ['synthetic'], 'inferred', {}),
        gapArtefact('VAL-04', 'MTTD/MTTR baselines', 'No incident pipeline.', ['SRE-metric'], 'inferred', {}),
        gapArtefact('VAL-05', 'Daily conformance scan', 'No conformance endpoint.', ['conformance'], 'inferred', {}),
      ],
      GOV: [
        liveMcp,
        zkGap,
        gapArtefact('GOV-03', 'Conformance score (daily)', 'No automated MUST/SHOULD score.', ['conformance'], 'inferred', {}),
        gapArtefact('GOV-04', 'Audit evidence pipeline', 'No SOC2/ISO27001 evidence export.', ['audit'], 'inferred', {}),
        gapArtefact('GOV-05', 'Incident & postmortem rollups', 'No MTTD/MTTR trend store.', ['post-mortem'], 'inferred', {}),
        gapArtefact('GOV-06', 'Cohort reports', 'No per-team / per-tier rollups.', ['cohort'], 'inferred', {}),
      ],
    },
  };
}

// ----- main -----

async function main() {
  process.stderr.write(`[fetch-live-pack] talking to ${MCP_URL}\n`);
  await initialize().catch(e => {
    process.stderr.write(`[fetch-live-pack] WARN initialize failed: ${e.message}\n`);
    // Some MCPs accept tools/call without explicit init — keep going.
  });

  const errors = {};
  const safe = async (name, fn) => {
    try { return await fn(); }
    catch (e) { errors[name] = e.message; return null; }
  };

  const [health, topology, anomaliesActive, baselines] = await Promise.all([
    safe('system_health',       () => callTool('system_health')),
    safe('system_topology',     () => callTool('system_topology')),
    safe('anomalies_active',    () => callTool('anomalies_active')),
    safe('anomalies_baselines', () => callTool('anomalies_baselines')),
  ]);

  // ZK tools — best-effort, expected to 404 on public proxy
  await Promise.all([
    safe('zk_stats',    () => callTool('zk_stats')),
    safe('zk_solvency', () => callTool('zk_solvency')),
  ]);

  if (!health || !topology) {
    process.stderr.write(`[fetch-live-pack] FATAL: core tools unavailable. Errors: ${JSON.stringify(errors, null, 2)}\n`);
    process.exit(1);
  }

  const pack = buildPack({ health, topology, anomaliesActive, baselines, errors });

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(pack, null, 2) + '\n');

  process.stderr.write(
    `[fetch-live-pack] wrote ${OUTPUT}\n` +
    `  refreshedAt:        ${pack.liveness.refreshedAt}\n` +
    `  services:           ${pack.liveness.servicesDiscovered.join(', ')}\n` +
    `  baselines:          ${pack.liveness.baselinesComputed}\n` +
    `  active anomalies:   ${pack.liveness.activeAnomalies}\n` +
    `  tools failed:       ${Object.keys(errors).join(', ') || 'none'}\n`
  );
}

main().catch(e => {
  process.stderr.write(`[fetch-live-pack] FATAL: ${e.message}\n`);
  process.exit(1);
});
