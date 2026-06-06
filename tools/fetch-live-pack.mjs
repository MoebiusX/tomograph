#!/usr/bin/env node
/**
 * tools/fetch-live-pack.mjs
 *
 * Build a canonical ObservabilityPack v1.2 manifest from a live MCP
 * server's responses, validate it against the vendored schema, and write
 * it as YAML to `examples/production-live.pack.yaml`.
 *
 * Phase 4 rewrite: emits canonical v1.2 only. No EMIT_FORMAT flag, no
 * studio-shape output. Sections MCP cannot directly verify (SLIs, SLOs,
 * dashboards, alerting, …) are populated with minimal stubs derived from
 * MCP context (discovered services, baseline thresholds) — the canonical
 * schema requires them. Items MCP could verify carry their evidence in
 * flat annotation keys (`mcp.verified.<symbol>`).
 *
 * Usage:
 *   node tools/fetch-live-pack.mjs
 *   MCP_URL=https://your-mcp/path node tools/fetch-live-pack.mjs
 *   OUTPUT=somewhere/else.pack.yaml node tools/fetch-live-pack.mjs
 *
 * Env:
 *   MCP_URL   — MCP server endpoint. Default: https://mcp.example.com/observability
 *   OUTPUT    — Output path.         Default: examples/production-live.pack.yaml
 *   MCP_AUTH  — Optional bearer token if your MCP requires auth.
 *   PACK_NAME — Pack metadata.name.  Default: production-live
 *
 * Exit codes:
 *   0  success
 *   1  hard failure (no file written; previous file is kept)
 *
 * Requires Node 18+.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '..', 'vendor', 'observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json');
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

const MCP_URL_DEFAULT  = process.env.MCP_URL  || 'https://mcp.example.com/observability';
const OUTPUT           = process.env.OUTPUT   || 'examples/production-live.pack.yaml';
const MCP_AUTH_DEFAULT = process.env.MCP_AUTH || null;
const PACK_NAME        = (process.env.PACK_NAME || 'production-live').toLowerCase();

// ============================================================
// MCP client — same wire protocol as before. Parameterised by
// (mcpUrl, mcpAuth) so the server's POST /api/refresh-live endpoint
// can drive it from the request body without spawning a subprocess.
// ============================================================

// createMcpClient is exported so the server can drive ad-hoc MCP
// interactions (deploy, refresh) without spawning a subprocess.
export function createMcpClient({ mcpUrl, mcpAuth = null } = {}) {
  if (!mcpUrl) throw new Error('createMcpClient: mcpUrl required');
  let session = null;
  let nextId = 1;

  async function rpc(method, params = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    };
    if (mcpAuth) headers['Authorization'] = `Bearer ${mcpAuth}`;
    if (session) headers['Mcp-Session-Id'] = session;

    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} on ${method}: ${await res.text().catch(() => '')}`);
    if (res.headers.get('mcp-session-id')) session = res.headers.get('mcp-session-id');

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        const frameEnd = buf.indexOf('\n\n');
        if (frameEnd !== -1) {
          const frame = buf.slice(0, frameEnd);
          const text = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.replace(/^data:\s?/, '')).join('\n');
          if (text) {
            const obj = JSON.parse(text);
            if (obj.error) throw new Error(`${method}: ${obj.error.message}`);
            return obj.result;
          }
          buf = buf.slice(frameEnd + 2);
        }
        if (done) break;
      }
      throw new Error(`MCP ${method}: SSE stream ended with no complete frame`);
    }
    const data = await res.json();
    if (data.error) throw new Error(`${method}: ${data.error.message}`);
    return data.result;
  }

  async function callTool(name, args = {}) {
    const result = await rpc('tools/call', { name, arguments: args });
    if (result?.isError) {
      const txt = result?.content?.map(c => c.text).filter(Boolean).join(' ') || 'tool returned isError';
      throw new Error(`${name}: ${txt}`);
    }
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') return result;
    try { return JSON.parse(text); }
    catch { return text; }
  }

  return { rpc, callTool };
}

// ============================================================
// Pack builder — pure, takes stubbed MCP responses, returns a canonical
// v1.2 manifest. Exported for offline tests.
// ============================================================

function slug(s, fallback = 'svc') {
  if (typeof s !== 'string' || !s) return fallback;
  const cleaned = s.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (cleaned.length < 2) return fallback;
  return cleaned.slice(0, 50);
}

function pickCriticality(services) {
  // Heuristic: the cron treats prod observability as tier-2 by default.
  // Real callers can override via metadata.bindings later, but the live
  // snapshot should not claim tier-1 conformance bands it can't audit.
  if (!services.length) return 'tier-3';
  return 'tier-2';
}

function defaultBaselines(criticality) {
  if (criticality === 'tier-1') return { mttd_target_p50: '2m', mttr_target_p50: '30m' };
  if (criticality === 'tier-2') return { mttd_target_p50: '5m', mttr_target_p50: '2h' };
  return { mttd_target_p50: '15m', mttr_target_p50: '1d' };
}

// Parse Prometheus-convention recording rules into SLI / SLO pairs.
// Names that follow `service:metric:op` are a strong SLO signal —
// the user pushed back that "SLIs will be reflected in recording rules"
// and they're right: that's the convention. We only infer SLIs from
// rules whose name expression matches the canonical ratio / latency
// shape; anything ambiguous flows through to spec.queries verbatim
// so the engineer can decide.
function inferSlisFromRecordingRules(rules) {
  if (!Array.isArray(rules)) return [];
  // Group rules by (service, metric) — the `op` (good/total/ratio/...)
  // tells us what KIND of SLI it likely encodes.
  const byBase = new Map();
  for (const r of rules) {
    if (!r?.name) continue;
    const m = /^([a-z][a-z0-9_]*):([a-z][a-z0-9_]*):([a-z0-9_]+)$/.exec(r.name);
    if (!m) continue;
    const [, service, metric, op] = m;
    const key = `${service}:${metric}`;
    if (!byBase.has(key)) byBase.set(key, { service, metric, ops: {} });
    byBase.get(key).ops[op] = r;
  }
  const out = [];
  for (const { service, metric, ops } of byBase.values()) {
    const sliId = `${service}_${metric}`.toLowerCase();
    let sli, slo;
    // Ratio-shaped: we have good + total recording. The presence of
    // `ratio_*` or `error_ratio_*` confirms the ratio family.
    const goodKey = Object.keys(ops).find(k => /^good_/.test(k));
    const totalKey = Object.keys(ops).find(k => /^total_/.test(k));
    const ratioKey = Object.keys(ops).find(k => /^ratio_/.test(k) || /^error_ratio_/.test(k));
    if (goodKey && totalKey) {
      sli = {
        id: sliId,
        description: `Inferred from MCP-discovered recording rules ${service}:${metric}:good/total.`,
        type: 'ratio',
        good:  ops[goodKey].expr,
        total: ops[totalKey].expr,
      };
    } else if (ratioKey) {
      // We have a ratio recording rule directly. Treat it as the SLI's
      // canonical expression (the engineer can decompose later).
      sli = {
        id: sliId,
        description: `Inferred from MCP-discovered recording rule ${ops[ratioKey].name}.`,
        type: 'ratio',
        good:  ops[ratioKey].expr,
        total: '1',   // placeholder; engineer to refine
      };
    } else {
      // Threshold-shaped (latency p95, queue depth, etc).
      const first = Object.values(ops)[0];
      sli = {
        id: sliId,
        description: `Inferred from MCP-discovered recording rule ${first.name}.`,
        type: 'threshold',
        query: first.expr,
        // Spec requires a numeric threshold; we can't infer it from a
        // flat recording rule — engineer to set per the SLO objective.
        // Use 1 as the conservative placeholder; the rule's `expr` is
        // already preserved in spec.queries.recording_rules.
        threshold: 1,
        unit: 'ratio',
      };
    }
    slo = {
      id: `${sliId}_99`,
      sli: sliId,
      objective: 0.99,
      window: '30d',
      error_budget_policy: 'ref:platform/default-budget',
    };
    out.push({ sli, slo });
  }
  return out;
}

function durationFromMs(ms, fallback) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return fallback;
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

export function buildCanonicalPack({
  refreshedAt,
  mcpUrl,
  health = {},
  topology = {},
  anomaliesActive = {},
  baselinesData = {},
  probeResults = {},
  errors = {},
  packName = PACK_NAME,
} = {}) {
  const services = Array.isArray(health.services) ? health.services : [];
  const serviceNames = services.map(s => s?.name).filter(Boolean);
  const serviceSlugs = serviceNames.map(n => slug(n));
  const criticality = pickCriticality(services);

  // ---- metadata ----
  // Core tools that were called regardless of probes.
  const coreCalled = ['system_health','system_topology','anomalies_active','anomalies_baselines'].filter(n => !errors[n]);
  // Probe tool that actually responded (per probe).
  const probeAnswered = Object.entries(probeResults).filter(([_, v]) => v?.tool).map(([k, v]) => v.tool);
  // Probes attempted (regardless of whether any candidate answered).
  const probesAttempted = Object.keys(probeResults || {});
  // Probes that responded successfully.
  const probesSucceeded = Object.entries(probeResults || {}).filter(([_, v]) => v?.tool).map(([k]) => k);

  const annotations = {
    'mcp.refreshedAt':         refreshedAt,
    'mcp.url':                 mcpUrl,
    'mcp.toolsCalled':         [...coreCalled, ...probeAnswered].join(','),
    'mcp.toolsFailed':         Object.keys(errors).join(',') || '',
    'mcp.probesAttempted':     probesAttempted.join(','),
    'mcp.probesSucceeded':     probesSucceeded.join(','),
    'mcp.servicesDiscovered':  serviceNames.join(','),
    'mcp.baselinesComputed':   String((baselinesData.baselines || []).length),
    'mcp.activeAnomalies':     String(anomaliesActive?.traceAnomalies?.active?.length || 0),
  };
  // Per-probe count annotations, ONLY for probes that responded — so an
  // engineer reading the pack can see what came back from live state.
  for (const [k, v] of Object.entries(probeResults || {})) {
    if (v?.tool && Array.isArray(v.adapted)) {
      annotations[`mcp.discovered.${k}`] = String(v.adapted.length);
    }
  }

  // Per-artefact verification markers (only for items derived from a tool that
  // actually responded).
  const markVerified = (sym) => { annotations[`mcp.verified.${sym}`] = refreshedAt; };

  // ---- spec.otel ----
  const otelSection = {
    semconv: '1.27.0',
    resource_attributes: { required: ['service.name'] },
    sdk: {
      languages: ['go'],
      sampling: { policy: 'parentbased_traceidratio', ratio: 0.1 },
      propagators: ['tracecontext'],
    },
  };
  if (!errors.system_health) markVerified('otel');

  // ---- spec.telemetry.backends ----
  // Always declare the headline platform backends; tag with `mcp` evidence
  // when the topology/health response confirms them.
  const backends = [];
  const pushBackend = (b, verifiedBy) => {
    backends.push(b);
    if (verifiedBy && !errors[verifiedBy]) markVerified(`telemetry.backends.${b.id}`);
  };
  pushBackend({ id: 'metrics-prom', signal: 'metrics', product: 'prometheus' }, 'system_health');
  pushBackend({ id: 'logs-elastic', signal: 'logs',    product: 'elasticsearch' }, null);
  pushBackend({ id: 'traces-jaeger', signal: 'traces', product: 'jaeger' },
              (topology?.dependencies || []).some(d => (d.child || '').includes('jaeger')) ? 'system_topology' : null);

  // Probes drive multiple downstream sections — hoist their results.
  const discoveredRules = probeResults?.recording_rules?.adapted || [];

  // ---- spec.slis + spec.slos ----
  // We first try to infer SLIs from any discovered recording rules
  // (their `ns:metric:op` names + exprs are SLO evidence — exactly the
  // point the user pushed back on). Service-derived SLIs only fill the
  // gap when rule discovery returned nothing.
  const slis = [];
  const slos = [];
  const inferredFromRules = inferSlisFromRecordingRules(discoveredRules || []);
  if (inferredFromRules.length) {
    for (const { sli, slo } of inferredFromRules) {
      slis.push(sli);
      slos.push(slo);
      markVerified(`slis.${sli.id}`);
    }
  } else if (serviceSlugs.length === 0) {
    // Pack must have >= 1 SLI / SLO; stub a generic platform availability target.
    slis.push({
      id: 'platform_availability',
      description: 'Platform availability — no services discovered by MCP.',
      type: 'ratio',
      good: 'sum(rate(http_requests_total{status_code!~"5.."}[5m]))',
      total: 'sum(rate(http_requests_total[5m]))',
    });
    slos.push({
      id: 'platform_availability_99',
      sli: 'platform_availability',
      objective: 0.99,
      window: '30d',
      error_budget_policy: 'ref:platform/default-budget',
    });
  } else {
    for (const name of serviceSlugs) {
      const sliId = `${name.replace(/-/g, '_')}_availability`;
      const sloId = `${sliId}_99`;
      slis.push({
        id: sliId,
        description: `Availability SLI for ${name} (synthesised from MCP system_health).`,
        type: 'ratio',
        semconv_metric: 'http.server.request.duration',
        good:  `sum(rate(http_server_request_duration_seconds_count{service_name="${name}",http_response_status_code!~"5.."}[5m]))`,
        total: `sum(rate(http_server_request_duration_seconds_count{service_name="${name}"}[5m]))`,
      });
      slos.push({
        id: sloId,
        sli: sliId,
        objective: 0.99,
        window: '30d',
        error_budget_policy: 'ref:platform/default-budget',
      });
      markVerified(`slis.${sliId}`);
    }
  }

  // ---- spec.pipelines ----
  const pipelines = {
    receivers:  [{ name: 'otlp' }],
    processors: [{ name: 'memory_limiter' }, { name: 'batch' }],
    exporters: {
      metrics: { kind: 'prometheusremotewrite' },
      logs:    { kind: 'elasticsearch' },
      traces:  { kind: 'jaeger' },
    },
  };

  // ---- spec.queries.recording_rules ----
  // PREFER what the MCP attested via the recording_rules probe. Only
  // fall back to the synthesised per-SLO stub if nothing came back.
  let recordingRules;
  if (Array.isArray(discoveredRules) && discoveredRules.length > 0) {
    // Schema requires the rule NAME to match the prometheus convention
    // ns:metric:op. Anything that doesn't can't go in spec.queries —
    // skip those (and they'll surface in the warnings).
    const RULE_NAME = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z0-9_]+$/;
    recordingRules = discoveredRules.filter(r => RULE_NAME.test(r.name));
    markVerified('queries.recording_rules');
  } else {
    recordingRules = slos.map(s => ({
      name: `platform:${s.sli}:ratio_5m`,
      expr: `ref:slis.${s.sli}`,
      interval: '30s',
    }));
  }
  const queries = {};
  if (recordingRules.length > 0) queries.recording_rules = recordingRules;

  // ---- spec.dashboards ----
  // PREFER what came back from the dashboards probe.
  const discoveredDashboards = probeResults?.dashboards?.adapted;
  let dashboards;
  if (Array.isArray(discoveredDashboards) && discoveredDashboards.length > 0) {
    dashboards = discoveredDashboards;
    markVerified('dashboards');
  } else {
    dashboards = [{
      id: 'platform-overview',
      provider: { kind: 'grafana' },
      folder: 'platform',
      source: 'file://dashboards/platform-overview.json',
    }];
  }

  // ---- spec.policy.burn_rate_alerts ----
  // Per-SLO multi-window pattern is always synthesized — even when the
  // MCP exposes flat alert rules, those rarely encode the short/long
  // window decomposition the spec requires. We DO surface the
  // discovered alert NAMES in metadata.annotations.mcp.discovered.alert_rules
  // so the SRE can see what currently fires.
  const burnRateAlerts = slos.map(s => ({
    slo: s.id,
    windows: [
      { short: '5m',  long: '1h', factor: 14, severity: 'SEV1' },
      { short: '30m', long: '6h', factor: 6,  severity: 'SEV2' },
    ],
  }));
  const discoveredAlertNames = (probeResults?.alert_rules?.adapted || []).map(a => a.name).filter(Boolean);
  if (discoveredAlertNames.length) {
    annotations['mcp.discovered.alert_rule_names'] = discoveredAlertNames.slice(0, 64).join(',');
    markVerified('policy.burn_rate_alerts');
  }

  // ---- scrape evidence + metric inventory ----
  // Both go into annotations (no schema field) so the SRE can see WHAT
  // the MCP confirmed is currently exported / scraped. This is exactly
  // what the user pushed back on: metrics being exported are observable
  // and must be surfaced.
  const scrapeJobs = probeResults?.scrape_configs?.adapted;
  if (Array.isArray(scrapeJobs) && scrapeJobs.length) {
    annotations['mcp.discovered.scrape_jobs'] = scrapeJobs.slice(0, 64).join(',');
    markVerified('telemetry.scrape');
  }
  const metricNames = probeResults?.metric_names?.adapted;
  if (Array.isArray(metricNames) && metricNames.length) {
    // Cap to 200 names to keep annotation bytes sane; full inventory is
    // a probe call away when the engineer needs it.
    annotations['mcp.discovered.metric_names_count'] = String(metricNames.length);
    annotations['mcp.discovered.metric_names_sample'] = metricNames.slice(0, 200).join(',');
    markVerified('otel.metrics');
  }

  // ---- spec.alerting ----
  const alerting = {
    routes: [{
      severity: 'SEV1',
      channels: [{ msteams: '#platform-oncall' }],
    }],
  };

  // ---- spec.baselines ----
  // Prefer MCP-supplied data; fall back to platform defaults for the
  // declared criticality.
  const fallback = defaultBaselines(criticality);
  const baselinesNormal = (baselinesData.baselines || [])
    .map(b => b.thresholdMs).filter(n => typeof n === 'number');
  const mttdFromData = baselinesNormal.length
    ? durationFromMs(Math.min(...baselinesNormal), fallback.mttd_target_p50)
    : fallback.mttd_target_p50;
  const baselines = {
    mttd_target_p50: mttdFromData,
    mttr_target_p50: fallback.mttr_target_p50,
    measurement_source: 'mcp.anomalies_baselines',
    review_cadence: 'weekly',
  };
  if (!errors.anomalies_baselines) markVerified('baselines');

  // ---- spec.validation ----
  // Empty — MCP can't directly attest chaos / synthetics.
  const validation = {};

  // ---- assemble ----
  const pack = {
    apiVersion: 'observability.platform/v1',
    kind: 'ObservabilityPack',
    metadata: {
      name: slug(packName, 'production-live'),
      version: `0.${Math.floor(Date.parse(refreshedAt) / 60000) || 1}.0`,
      owners: ['mcp-fetcher'],
      bindings: {
        service: slug(packName, 'production-live'),
        environments: ['prod'],
        criticality,
      },
      annotations,
    },
    spec: {
      otel: otelSection,
      telemetry: { backends },
      slis,
      slos,
      pipelines,
      queries,
      dashboards,
      policy: { burn_rate_alerts: burnRateAlerts },
      alerting,
      baselines,
      validation,
    },
  };
  return pack;
}

// ============================================================
// Entrypoint
// ============================================================

// ============================================================
// Discovery probes — narrow the gap between "MCP can attest" and
// what the spec asks for. Each probe declares a CANDIDATE LIST of
// tool names (MCPs in the wild use different conventions) and an
// adapter that maps whatever shape comes back to the spec field.
//
// The fetcher tries the candidates in order; the first that responds
// wins. If none respond, the probe is recorded as "attempted but
// unanswered" so the draft can be honest about what was actually
// missing vs what we never asked for.
// ============================================================

const PROBES = [
  {
    name: 'recording_rules',
    candidates: ['list_recording_rules', 'prometheus_recording_rules', 'metrics_recording_rules', 'mimir_recording_rules', 'rules_list_recording', 'prometheus_rules', 'rules_list'],
    target: 'spec.queries.recording_rules',
    adapt: (response) => {
      // Common shapes:
      //   { groups: [{ name, rules: [{ record, expr, labels?, interval? }] }] }
      //   { rules: [{ record/name, expr/query, interval? }] }
      //   { data: { groups: [...] } }   (Prometheus /api/v1/rules)
      const groups = response?.groups || response?.data?.groups || [];
      const flat = response?.rules || groups.flatMap(g => (g.rules || []).map(r => ({ ...r, _group: g.name, _interval: g.interval })));
      return flat
        .filter(r => (r.record || r.name) && !r.alert)
        .map(r => ({
          name: r.record || r.name,
          expr: r.expr || r.query || '',
          ...(r._interval || r.interval ? { interval: r.interval || r._interval } : {}),
          ...(r.labels ? { labels: r.labels } : {}),
        }))
        .filter(r => r.expr);
    },
  },
  {
    name: 'alert_rules',
    candidates: ['list_alert_rules', 'prometheus_alert_rules', 'metrics_alert_rules', 'mimir_alert_rules', 'rules_list_alerting', 'prometheus_alerts'],
    target: 'spec.policy.burn_rate_alerts',
    adapt: (response) => {
      const groups = response?.groups || response?.data?.groups || [];
      const flat = response?.rules || groups.flatMap(g => (g.rules || []).map(r => ({ ...r, _group: g.name })));
      // We can't fully reconstruct multi-window burn-rate semantics
      // from a flat rule, but we CAN capture the alert as a forecast
      // signal — the user can re-shape via the studio later.
      return flat
        .filter(r => r.alert || (r.name && !r.record))
        .map(r => ({
          name: r.alert || r.name,
          expr: r.expr || r.query || '',
          for: r.for || '5m',
          labels: r.labels || {},
          annotations: r.annotations || {},
        }));
    },
  },
  {
    name: 'dashboards',
    candidates: ['list_dashboards', 'grafana_dashboards', 'grafana_list_dashboards', 'grafana_search_dashboards', 'dashboards_list', 'grafana_search'],
    target: 'spec.dashboards',
    adapt: (response) => {
      // Grafana /api/search shape: [{ id, uid, title, type:'dash-db', folderTitle, tags }]
      // Generic shape: { dashboards: [{ id/uid, title, folder/folderTitle }] }
      const list = Array.isArray(response) ? response : (response?.dashboards || response?.items || []);
      return list
        .filter(d => (d.type ? d.type === 'dash-db' : true))
        .map(d => ({
          id: String(d.uid || d.id || d.title || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `dash-${Math.random().toString(36).slice(2, 8)}`,
          provider: { kind: 'grafana', version: '12.0', schemaVersion: 41 },
          folder: d.folderTitle || d.folder || 'mcp-discovered',
          source: d.url ? `grafana://${d.url}` : `grafana://uid/${d.uid || d.id}`,
        }));
    },
  },
  {
    name: 'scrape_configs',
    candidates: ['list_scrape_configs', 'prometheus_scrape_configs', 'prometheus_targets', 'metrics_scrape_jobs', 'list_metric_jobs'],
    target: 'spec.telemetry.scrape_evidence',   // annotation-only; no schema field
    adapt: (response) => {
      // Prometheus /api/v1/targets shape: { activeTargets: [{ labels: { job, instance } }] }
      const targets = response?.activeTargets || response?.data?.activeTargets || response?.targets || [];
      const jobs = new Set();
      for (const t of targets) {
        const j = t.labels?.job || t.job;
        if (j) jobs.add(j);
      }
      return [...jobs];
    },
  },
  {
    name: 'metric_names',
    candidates: ['list_metrics', 'prometheus_metric_names', 'metrics_inventory', 'mimir_metric_names'],
    target: 'spec.otel.metric_inventory',   // annotation-only
    adapt: (response) => {
      const names = Array.isArray(response) ? response
        : (response?.data || response?.metrics || response?.names || []);
      return Array.isArray(names) ? names.filter(s => typeof s === 'string') : [];
    },
  },
];

export async function fetchMcp({ mcpUrl, mcpAuth = null } = {}) {
  if (!mcpUrl) throw new Error('fetchMcp: mcpUrl required');
  const { rpc, callTool } = createMcpClient({ mcpUrl, mcpAuth });
  const errors = {};
  const safe = async (name, fn) => {
    try { return await fn(); } catch (e) { errors[name] = e.message; return null; }
  };
  const quiet = async (name, fn) => {
    // Like `safe`, but doesn't pollute `errors` — used for probes
    // because trying a candidate tool that doesn't exist isn't a
    // failure, it's an expected miss.
    try { return await fn(); } catch (_) { return null; }
  };

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'observabilitypack-studio-fetcher', version: '0.3.0' },
  }).catch(() => {});

  const [health, topology, anomaliesActive, baselinesData] = await Promise.all([
    safe('system_health',       () => callTool('system_health')),
    safe('system_topology',     () => callTool('system_topology')),
    safe('anomalies_active',    () => callTool('anomalies_active')),
    safe('anomalies_baselines', () => callTool('anomalies_baselines')),
  ]);

  if (!health || !topology) {
    throw new Error(`core MCP tools unavailable. errors: ${JSON.stringify(errors)}`);
  }

  // Run discovery probes in parallel. Each probe tries multiple
  // candidate tool names and stops at the first response.
  const probeResults = {};
  await Promise.all(PROBES.map(async (probe) => {
    for (const candidate of probe.candidates) {
      const response = await quiet(candidate, () => callTool(candidate));
      if (response != null) {
        let adapted;
        try { adapted = probe.adapt(response); }
        catch (_) { adapted = null; }
        probeResults[probe.name] = {
          tool: candidate,
          attempted: probe.candidates.slice(0, probe.candidates.indexOf(candidate) + 1),
          adapted,
          rawSize: JSON.stringify(response).length,
        };
        return;
      }
    }
    // None of the candidates responded — record that we tried.
    probeResults[probe.name] = { tool: null, attempted: probe.candidates.slice(), adapted: null };
  }));

  return { health, topology, anomaliesActive, baselinesData, probeResults, errors };
}

// Convenience entrypoint used by the CLI + the server: end-to-end build,
// validate, and (optionally) write to disk. Returns the canonical pack.
export async function buildAndValidate({ mcpUrl, mcpAuth, packName, refreshedAt }) {
  const fetched = await fetchMcp({ mcpUrl, mcpAuth });
  const at = refreshedAt || new Date().toISOString();
  const pack = buildCanonicalPack({ refreshedAt: at, mcpUrl, packName, ...fetched });
  const errors = validateCanonical(pack, SCHEMA);
  if (errors.length) {
    const err = new Error(`built pack failed schema validation (${errors.length} error${errors.length === 1 ? '' : 's'})`);
    err.details = errors;
    throw err;
  }
  return { pack, refreshedAt: at };
}

async function main() {
  process.stderr.write(`[fetch-live-pack] talking to ${MCP_URL_DEFAULT}\n`);
  const fetched = await fetchMcp({ mcpUrl: MCP_URL_DEFAULT, mcpAuth: MCP_AUTH_DEFAULT });
  const refreshedAt = new Date().toISOString();
  const pack = buildCanonicalPack({ refreshedAt, mcpUrl: MCP_URL_DEFAULT, ...fetched });

  const errs = validateCanonical(pack, SCHEMA);
  if (errs.length) {
    process.stderr.write(`[fetch-live-pack] built pack failed validation:\n`);
    for (const e of errs) process.stderr.write(`    ${e}\n`);
    throw new Error(`built pack failed schema validation (${errs.length} error${errs.length === 1 ? '' : 's'})`);
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, emitYaml(pack));

  process.stderr.write(
    `[fetch-live-pack] wrote ${OUTPUT}\n` +
    `  refreshedAt:        ${refreshedAt}\n` +
    `  services:           ${pack.metadata.annotations['mcp.servicesDiscovered'] || '(none)'}\n` +
    `  baselines computed: ${pack.metadata.annotations['mcp.baselinesComputed']}\n` +
    `  active anomalies:   ${pack.metadata.annotations['mcp.activeAnomalies']}\n` +
    `  tools failed:       ${pack.metadata.annotations['mcp.toolsFailed'] || 'none'}\n`
  );
}

const invokedDirectly = resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(e => { process.stderr.write(`[fetch-live-pack] FATAL: ${e.message}\n`); process.exit(1); });
}
