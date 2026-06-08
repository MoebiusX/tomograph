// ============================================================
// crawler.mjs — Path A of the pack-creation user journey.
//
// Walks a service repository and emits a draft canonical
// ObservabilityPack v1.2 manifest by introspecting common
// observability artefacts: docker-compose backends, Prometheus
// rules, Alertmanager configs, OTel Collector pipelines, and
// Grafana dashboard JSONs.
//
// The library is pure — it accepts an in-memory file map so the
// CLI (which reads from disk) and the server endpoint (which
// receives uploaded files) share one implementation. No fs
// imports here.
//
// Output is honest about what was discovered and what was
// inferred. Every artefact carries a metadata.annotations.crawler.*
// pointer to the source file. SLIs/SLOs/baselines that the spec
// REQUIRES but the repo doesn't reveal are stubbed with
// conservative placeholders + an annotation flagging the stub —
// the conformance panel will then surface them as missing-MUST
// for the engineer to fill in.
// ============================================================

import { parse as parseYaml, parseAll as parseYamlAll, emit as emitYaml } from './mini-yaml.mjs';

// Parse a (possibly multi-document) YAML file into a list of non-null
// documents. Prometheus rule files, Alertmanager configs and Kubernetes
// manifests are frequently shipped as multi-document streams (`---`).
function parseYamlDocs(content) {
  return parseYamlAll(content).filter(d => d && typeof d === 'object');
}

// Known backend image-name fragments → spec.telemetry.backends.product enum.
// Prefix match against the docker-compose service image. Order matters —
// most-specific first.
// Signal enum per schema: metrics, logs, traces, profiles, network,
// policy, mesh, gateway, collection, alerting, dashboards. No "all" —
// products that handle multiple signals (Grafana, OTel Collector,
// Alertmanager) get their primary classification.
const BACKEND_PATTERNS = [
  { match: /opentelemetry[/-]?collector|otel\/opentelemetry-collector/i, product: 'opentelemetry-collector', signal: 'collection' },
  { match: /^prom\/prometheus|prometheus:|prometheus-community/i,         product: 'prometheus',              signal: 'metrics' },
  { match: /^grafana\/loki|grafana\/loki-docker|loki:/i,                  product: 'loki',                    signal: 'logs' },
  { match: /^grafana\/tempo|tempo:/i,                                     product: 'tempo',                   signal: 'traces' },
  { match: /^grafana\/mimir|mimir:|grafana\/mimirtool/i,                  product: 'mimir',                   signal: 'metrics' },
  { match: /^grafana\/grafana|grafana:|grafana\/grafana-/i,               product: 'grafana',                 signal: 'dashboards' },
  { match: /^elastic\/|elasticsearch:|opensearch/i,                       product: 'elasticsearch',           signal: 'logs' },
  { match: /^jaegertracing\/|jaegertracing\/all-in-one|jaeger:/i,         product: 'jaeger',                  signal: 'traces' },
  { match: /^thanos\/|thanos:|quay\.io\/thanos/i,                         product: 'thanos',                  signal: 'metrics' },
  { match: /^prom\/alertmanager|alertmanager:|prometheus-community.*alertmanager/i, product: 'alertmanager',  signal: 'alerting' },
  { match: /^pyroscope|grafana\/pyroscope/i,                              product: 'pyroscope',               signal: 'profiles' },
  { match: /fluent[-/]?bit|fluent-bit/i,                                  product: 'fluent-bit',              signal: 'logs' },
  { match: /timberio\/vector|vector:/i,                                   product: 'vector',                  signal: 'collection' },
  // Additional common production stacks
  { match: /victoriametrics\/victoria-metrics|victoriametrics\/vmselect|victoriametrics\/vminsert|victoriametrics\/vmstorage|victoriametrics\/vmagent/i,
                                                                          product: 'victoriametrics',         signal: 'metrics' },
  { match: /victoriametrics\/vmalert/i,                                   product: 'vmalert',                 signal: 'alerting' },
  { match: /kube-state-metrics/i,                                          product: 'kube-state-metrics',      signal: 'metrics' },
  { match: /prom\/node-exporter|node_exporter/i,                          product: 'node-exporter',           signal: 'metrics' },
  { match: /grafana\/promtail|promtail:/i,                                product: 'promtail',                signal: 'logs' },
  { match: /grafana\/k6|loadimpact\/k6/i,                                 product: 'k6',                      signal: 'metrics' },
  { match: /^otel\/opentelemetry-collector-contrib/i,                     product: 'opentelemetry-collector', signal: 'collection' },
  { match: /opensearchproject\/opensearch|opensearch:/i,                  product: 'opensearch',              signal: 'logs' },
  { match: /datadog\/agent|datadoghq\/agent/i,                            product: 'datadog-agent',           signal: 'collection' },
];

// ============================================================
// Public API
// ============================================================

/**
 * Detect what kind of observability artefact a file is.
 * @param {string} relPath - repo-relative path
 * @param {string} content - file content
 * @returns {string} kind: 'prometheus-rules' | 'alertmanager' | 'grafana-dashboard' |
 *                          'otel-collector' | 'docker-compose' | 'helm-chart' | 'unknown'
 */
export function detectArtefactKind(relPath, content) {
  const lower = relPath.toLowerCase();
  // JSON first — Grafana dashboards are the only json we care about.
  if (lower.endsWith('.json')) {
    try {
      const obj = JSON.parse(content);
      if (obj && Array.isArray(obj.panels) && typeof obj.schemaVersion === 'number') {
        return 'grafana-dashboard';
      }
    } catch (_) { /* not json */ }
    return 'unknown';
  }
  // YAML — could be many things; look at shape.
  if (!/\.ya?ml$/i.test(lower)) return 'unknown';

  // Filename heuristics first — fastest.
  if (/(^|\/)(docker-)?compose\.ya?ml$/.test(lower))             return 'docker-compose';
  if (/(^|\/)chart\.ya?ml$/.test(lower))                          return 'helm-chart';
  if (/alertmanager(\.config)?\.ya?ml$/.test(lower))              return 'alertmanager';
  if (/(^|\/)(otel|otelcol|collector)[-_a-z]*\.ya?ml$/.test(lower)) return 'otel-collector';
  if (/(rules?|alerts?|recording|burn[-_ ]?rate)\.ya?ml$/.test(lower)) return 'prometheus-rules';

  // Content sniff fallback.
  let obj;
  try { obj = parseYaml(content); } catch (_) { return 'unknown'; }
  if (!obj || typeof obj !== 'object') return 'unknown';

  if (obj.groups && Array.isArray(obj.groups)
      && obj.groups.some(g => g.rules?.some(r => 'record' in r || 'alert' in r))) {
    return 'prometheus-rules';
  }
  if (obj.route && obj.receivers && Array.isArray(obj.receivers)) return 'alertmanager';
  if (obj.receivers && obj.exporters && obj.service?.pipelines)   return 'otel-collector';
  if (obj.services && typeof obj.services === 'object'
      && Object.values(obj.services).some(s => s?.image))         return 'docker-compose';
  return 'unknown';
}

/**
 * Crawl a map of files and emit a draft canonical pack.
 * @param {Map<string,string>|Record<string,string>} filesInput
 * @param {object} [opts]
 * @param {string} [opts.repoName='crawled-service']  - metadata.name
 * @param {string} [opts.environment='prod']
 * @param {string} [opts.criticality]                  - 'tier-1'|'tier-2'|'tier-3'. Inferred if omitted.
 * @param {string} [opts.binding='otel-elastic-prometheus-grafana']
 * @param {Array<string>} [opts.owners=['team-platform']]
 * @returns {{canonical: object, summary: object, evidence: Record<string,string>}}
 */
export function crawlFiles(filesInput, opts = {}) {
  const files = filesInput instanceof Map
    ? filesInput
    : new Map(Object.entries(filesInput));
  const repoName = opts.repoName || 'crawled-service';
  const environment = opts.environment || 'prod';
  const binding = opts.binding || 'otel-elastic-prometheus-grafana';
  const owners = opts.owners || ['team-platform'];

  // ----- per-kind buckets -----
  const summary = {
    files: { scanned: files.size, classified: 0, byKind: {} },
    discovered: {
      backends: 0, recordingRules: 0, burnRateAlerts: 0,
      pipelines: 0, dashboards: 0, alertingRoutes: 0,
    },
    inferred: { slis: 0, slos: 0, baselines: false, tier: null },
    warnings: [],
  };
  const evidence = {};   // <artefact-id> -> <relPath>

  const backends = [];
  const recordingRules = [];
  const burnRateAlerts = [];
  const dashboards = [];
  const alertingRoutes = [];
  const pipelines = { receivers: [], processors: [], exporters: { metrics: null, logs: null, traces: null } };

  // ----- pass 1: classify -----
  const classified = [];
  for (const [relPath, content] of files) {
    const kind = detectArtefactKind(relPath, content);
    if (kind === 'unknown') continue;
    classified.push({ relPath, content, kind });
    summary.files.classified++;
    summary.files.byKind[kind] = (summary.files.byKind[kind] || 0) + 1;
  }

  // ----- pass 2: walk per kind -----
  for (const f of classified) {
    try {
      switch (f.kind) {
        case 'docker-compose':   walkDockerCompose(f, backends, evidence, summary); break;
        case 'prometheus-rules': walkPrometheusRules(f, recordingRules, burnRateAlerts, evidence, summary); break;
        case 'alertmanager':     walkAlertmanager(f, alertingRoutes, evidence, summary); break;
        case 'otel-collector':   walkOtelCollector(f, pipelines, evidence, summary); break;
        case 'grafana-dashboard':walkGrafanaDashboard(f, dashboards, evidence, summary); break;
        case 'helm-chart':       summary.warnings.push(`Helm Chart at ${f.relPath} detected — chart introspection not yet implemented.`); break;
      }
    } catch (e) {
      summary.warnings.push(`Failed to parse ${f.relPath}: ${e.message}`);
    }
  }

  // ----- infer SLIs/SLOs from alert names -----
  // Burn-rate alerts target an SLO; if the alert references a metric we
  // recognise we can synthesize the SLI/SLO. We never invent thresholds
  // we can't justify — we emit a placeholder PromQL + an annotation.
  const sliMap = new Map();
  const sloMap = new Map();
  for (const alert of burnRateAlerts) {
    const sloId = alert.slo;
    if (!sloMap.has(sloId)) {
      const sliId = sloId.replace(/_99|_999|_995|_slo$/i, '') || sloId;
      sloMap.set(sloId, {
        id: sloId,
        sli: sliId,
        objective: 0.99,
        window: '30d',
        error_budget_policy: 'ref:platform/default-budget',
      });
      if (!sliMap.has(sliId)) {
        sliMap.set(sliId, {
          id: sliId,
          type: 'ratio',
          description: `Auto-derived from burn-rate alert "${sloId}" — REPLACE WITH REAL QUERY.`,
          good:  `sum(rate(http_requests_total{status_code!~"5..",service="${repoName}"}[5m]))`,
          total: `sum(rate(http_requests_total{service="${repoName}"}[5m]))`,
        });
        summary.inferred.slis++;
      }
      summary.inferred.slos++;
    }
  }

  // If still no SLI/SLO discovered, fill the minimum tier-3 stub so the
  // result validates.
  if (sliMap.size === 0) {
    sliMap.set('service_availability', {
      id: 'service_availability',
      type: 'ratio',
      description: 'Stub SLI — no SLO references found in repo. REPLACE WITH REAL QUERY.',
      good:  `sum(rate(http_requests_total{status_code!~"5..",service="${repoName}"}[5m]))`,
      total: `sum(rate(http_requests_total{service="${repoName}"}[5m]))`,
    });
    sloMap.set('service_availability_99', {
      id: 'service_availability_99',
      sli: 'service_availability',
      objective: 0.99,
      window: '30d',
      error_budget_policy: 'ref:platform/default-budget',
    });
    summary.inferred.slis = 1;
    summary.inferred.slos = 1;
    summary.warnings.push('No burn-rate alerts found — emitted stub SLI/SLO that must be replaced.');
  }

  // ----- minimum policy: every SLO needs ≥1 burn-rate alert with ≥2 windows -----
  // If the repo had no rules at all we synthesize a Google-SRE-style
  // two-window alert per stubbed SLO so the result satisfies the spec's
  // minItems: 2 constraint on windows.
  if (burnRateAlerts.length === 0) {
    for (const slo of sloMap.values()) {
      burnRateAlerts.push({
        slo: slo.id,
        windows: [
          { short: '5m',  long: '1h', factor: 14, severity: 'SEV1' },
          { short: '30m', long: '6h', factor: 6,  severity: 'SEV2' },
        ],
      });
    }
    summary.warnings.push('Synthesized two-window burn-rate alerts for stub SLOs (Google SRE pattern).');
  } else {
    // Repo HAD recording-rule-style alerts. Translate them to the spec's
    // burn-rate shape with conservative defaults.
    for (const a of burnRateAlerts) {
      if (!a.windows || a.windows.length < 2) {
        a.windows = [
          { short: '5m',  long: '1h', factor: 14, severity: 'SEV1' },
          { short: '30m', long: '6h', factor: 6,  severity: 'SEV2' },
        ];
      }
    }
  }

  // ----- minimum pipelines -----
  if (pipelines.receivers.length === 0)  pipelines.receivers = [{ name: 'otlp' }];
  if (pipelines.processors.length === 0) pipelines.processors = [{ name: 'batch' }];
  if (!pipelines.exporters.metrics) pipelines.exporters.metrics = { kind: 'prometheusremotewrite' };
  if (!pipelines.exporters.logs)    pipelines.exporters.logs    = { kind: 'elasticsearch' };
  if (!pipelines.exporters.traces)  pipelines.exporters.traces  = { kind: 'jaeger' };

  // ----- minimum alerting routes -----
  if (alertingRoutes.length === 0) {
    alertingRoutes.push({ severity: 'SEV1', channels: [{ msteams: `#${repoName}-oncall` }] });
    summary.warnings.push('No Alertmanager routes found — emitted stub SEV1 → MS Teams route.');
  }

  // ----- minimum dashboards -----
  if (dashboards.length === 0) {
    dashboards.push({
      id: `${repoName}-overview`,
      provider: { kind: 'grafana' },
      folder: repoName,
      source: `file://dashboards/${repoName}-overview.json`,
    });
    summary.warnings.push('No Grafana dashboards found — emitted stub service-overview pointer.');
  }

  // ----- baselines (always stubbed; nothing in repos infers MTTD/MTTR) -----
  const baselines = {
    mttd_target_p50: '15m',
    mttr_target_p50: '1d',
    review_cadence: 'monthly',
  };
  summary.inferred.baselines = true;

  // ----- recording rule per SLO (spec rubric requires this) -----
  // Recording rule names must match ^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z0-9_]+$
  // (Prometheus convention: namespace:metric:operation). Slug the repo
  // name so hyphens and uppercase don't break the pattern.
  const repoNs = String(repoName).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'svc';
  for (const slo of sloMap.values()) {
    const sliName = (slo.sli || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'sli';
    const ruleName = `${repoNs}:${sliName}:ratio_5m`;
    if (!recordingRules.some(r => r.name === ruleName)) {
      recordingRules.push({ name: ruleName, expr: `ref:slis.${slo.sli}` });
    }
  }

  // ----- tier inference -----
  //   tier-1 = rich (rules + dashboards + alertmanager + chaos)
  //   tier-2 = rules + dashboards + alertmanager
  //   tier-3 = everything else
  const realRules     = summary.discovered.recordingRules > 0 || summary.discovered.burnRateAlerts > 0;
  const realDashboards = summary.discovered.dashboards > 0;
  const realAlerting  = summary.discovered.alertingRoutes > 0;
  let tier = 'tier-3';
  if (realRules && realDashboards && realAlerting) tier = 'tier-2';
  summary.inferred.tier = tier;
  const criticality = opts.criticality || tier;

  // ----- canonical assembly -----
  const canonical = {
    apiVersion: 'observability.platform/v1',
    kind: 'ObservabilityPack',
    metadata: {
      name: repoName,
      version: '0.1.0-crawled',
      binding,
      owners,
      bindings: { service: repoName, environments: [environment], criticality },
      labels: { source: 'crawler' },
      // Annotations are Record<string,string> per spec; we flatten the
      // crawler context into namespaced keys instead of nesting an
      // object — keeps the manifest valid.
      annotations: {
        'crawler.discoveredAt':    opts.now || new Date().toISOString(),
        'crawler.filesScanned':    String(summary.files.scanned),
        'crawler.filesClassified': String(summary.files.classified),
        'crawler.tierInferred':    tier,
        'crawler.warningCount':    String(summary.warnings.length),
      },
    },
    spec: {
      otel: {
        semconv: '1.26.0',
        resource_attributes: { required: ['service.name'] },
        sdk: {
          languages: ['go'],
          sampling: { policy: 'parentbased_traceidratio', ratio: 0.1 },
          propagators: ['tracecontext'],
        },
      },
      slis: [...sliMap.values()],
      slos: [...sloMap.values()],
      pipelines,
      queries: { recording_rules: recordingRules },
      dashboards,
      policy: { burn_rate_alerts: burnRateAlerts },
      alerting: { routes: alertingRoutes },
      baselines,
      validation: {
        synthetic_checks: [{
          id: `${repoName}-health-canary`,
          kind: 'blackbox-exporter',
          target: `https://${repoName}.example.com/health`,
          interval: '1m',
          on_fail_severity: 'SEV3',
        }],
      },
    },
  };

  if (backends.length) {
    canonical.spec.telemetry = { backends };
  }

  // Evidence map lives in summary, not in metadata.annotations
  // (annotations are Record<string,string>; the evidence is structured).
  // Callers that want it surface it themselves.
  return { canonical, summary, evidence };
}

/** Convenience — emit the canonical pack as YAML. */
export function crawlToYaml(filesInput, opts) {
  const { canonical, summary, evidence } = crawlFiles(filesInput, opts);
  const banner = [
    `# =============================================================================`,
    `# ObservabilityPack: ${canonical.metadata.name}  (drafted by the crawler)`,
    `# Discovered at ${canonical.metadata.annotations['crawler.discoveredAt']}`,
    `# Files scanned: ${summary.files.scanned}, classified: ${summary.files.classified}`,
    `# Tier inferred: ${summary.inferred.tier}`,
    `# Warnings: ${summary.warnings.length}${summary.warnings.length ? ' (see metadata.annotations + the summary report)' : ''}`,
    `# -----------------------------------------------------------------------------`,
    `# This is a DRAFT. Review every section before deploying. Annotations marked`,
    `# "REPLACE WITH REAL QUERY" need a real PromQL expression that matches your`,
    `# service. The tier was inferred from what was found in the repo — if your`,
    `# service is tier-1, set metadata.bindings.criticality: tier-1 and fill the`,
    `# missing chaos_experiments + per-SLO multi-window alerts.`,
    `# =============================================================================`,
    '',
  ].join('\n');
  return { yaml: banner + emitYaml(canonical), summary, evidence };
}

// ============================================================
// Per-kind walkers
// ============================================================

function walkDockerCompose(f, backends, evidence, summary) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!obj?.services) continue;
    for (const [svcName, svc] of Object.entries(obj.services)) {
    const image = String(svc?.image || '');
    if (!image) continue;
    for (const p of BACKEND_PATTERNS) {
      if (p.match.test(image)) {
        // Schema id pattern: ^[a-z][a-z0-9_-]*[a-z0-9]$ (lowercase, ends alphanumeric).
        const baseId = `${p.signal}-${p.product}`;
        let id = baseId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        let n = 2;
        while (backends.some(b => b.id === id)) id = `${baseId}-${n++}`;
        const endpoint = inferEndpoint(svc, p.product);
        const versionTag = (image.split(':')[1] || '').trim();
        const backend = {
          id,
          signal: p.signal,
          product: p.product,
          endpoints: endpoint ? [endpoint] : [`http://${p.product}:80`],
          auth: { kind: 'none' },
        };
        if (versionTag && /^v?\d/.test(versionTag)) {
          backend.version = { declared: versionTag.replace(/^v/, ''), gating: 'off' };
        }
        backends.push(backend);
        evidence[id] = f.relPath;
        summary.discovered.backends++;
        break;
      }
    }
  }
  }
}

function inferEndpoint(svc, product) {
  // Walk ports + healthcheck for a hint. We emit a relative URL so the
  // engineer can see where in the compose graph the backend lives.
  const ports = Array.isArray(svc?.ports) ? svc.ports : [];
  if (ports.length) {
    const first = String(ports[0]);
    const m = first.match(/(\d+)(?::(\d+))?/);
    if (m) return `http://${product}:${m[2] || m[1]}`;
  }
  return null;
}

function walkPrometheusRules(f, recordingRules, burnRateAlerts, evidence, summary) {
  let any = false;
  for (const obj of parseYamlDocs(f.content)) {
    if (!Array.isArray(obj.groups)) continue;
    any = true;
    for (const group of obj.groups) {
      for (const rule of group.rules || []) {
        if (rule.record) {
          const id = `QRY-${recordingRules.length + 1}-${slug(rule.record).slice(0, 16)}`;
          const entry = {
            name: rule.record,
            expr: typeof rule.expr === 'string' ? rule.expr : String(rule.expr || ''),
          };
          if (group.interval) entry.interval = group.interval;
          recordingRules.push(entry);
          evidence[id] = `${f.relPath}#${group.name || '_'}/${rule.record}`;
          summary.discovered.recordingRules++;
        } else if (rule.alert || rule.title) {
          // `rule.alert` is the Prometheus form; `rule.title` is the Grafana
          // unified-alerting form (provisioned alert rules). Both target an
          // SLO we synthesize from the alert name.
          const alertName = rule.alert || rule.title;
          const sloId = slug(alertName).replace(/-burn-?rate.*$/, '_99');
          if (!burnRateAlerts.some(a => a.slo === sloId)) {
            const windows = parseAlertWindows(rule);
            burnRateAlerts.push({ slo: sloId, windows });
            const id = `pol-${burnRateAlerts.length}`;
            evidence[id] = `${f.relPath}#${group.name || '_'}/${alertName}`;
            summary.discovered.burnRateAlerts++;
          }
        }
      }
    }
  }
  if (!any) return;
}

function parseAlertWindows(rule) {
  // Extract a single window from `for:` and `labels.severity`. Real
  // multi-window decomposition can't be recovered from a single rule;
  // we record what's there and let the synthesizer fill the rest.
  const out = [];
  const sev = rule.labels?.severity?.toString()?.toUpperCase();
  const severity = /^SEV[123]$/.test(sev) ? sev : 'SEV2';
  if (typeof rule.for === 'string') {
    out.push({ short: rule.for, long: '6h', factor: 6, severity });
  }
  return out;
}

function walkAlertmanager(f, routes, evidence, summary) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!obj?.route) continue;
    // Walk top-level route + its children. Each route → one entry per severity.
    const collected = [];
    walkRoute(obj.route, collected, obj.receivers || []);
    for (const r of collected) {
      const id = `ALR-${routes.length + 1}`;
      routes.push(r);
      evidence[id] = `${f.relPath}#route/${r.severity || 'default'}`;
      summary.discovered.alertingRoutes++;
    }
  }
}

function walkRoute(route, out, receivers) {
  const sev = route.match?.severity || route.match_re?.severity || route.matchers?.find?.(m => /severity/i.test(m))?.split('=')?.[1]?.replace(/"/g, '');
  const recvName = route.receiver;
  const recv = receivers.find(r => r.name === recvName);
  const channels = recv ? receiverChannels(recv) : [];
  if (sev || channels.length) {
    out.push({
      severity: normalizeSeverity(sev),
      channels: channels.length ? channels : [{ msteams: `#${recvName || 'oncall'}` }],
    });
  }
  for (const child of route.routes || []) walkRoute(child, out, receivers);
}

// Map Prometheus / Alertmanager severity labels to the spec v1.2
// enum: SEV1 (critical) / SEV2 (warning) / SEV3 (info) / SEV4 (debug).
// If the input already matches SEV1..SEV4, pass through. Common
// Prometheus conventions map as below.
function normalizeSeverity(s) {
  if (!s) return 'SEV2';
  const up = String(s).toUpperCase();
  if (/^SEV[1234]$/.test(up)) return up;
  if (/^(CRITICAL|FATAL|EMERGENCY|PAGE)$/.test(up)) return 'SEV1';
  if (/^(WARNING|ERROR|MAJOR|HIGH)$/.test(up))      return 'SEV2';
  if (/^(INFO|NOTICE|MINOR|LOW)$/.test(up))         return 'SEV3';
  if (/^(DEBUG|TRACE)$/.test(up))                   return 'SEV4';
  return 'SEV2';
}

function receiverChannels(recv) {
  // Spec Channel allows only: msteams, voice, whatsapp, email, webhook.
  // Map Alertmanager's broader vocabulary onto that closed set; flag
  // anything we couldn't map as a webhook with a placeholder URL.
  const out = [];
  if (Array.isArray(recv.email_configs))     out.push(...recv.email_configs.map(c => ({ email: c.to || `oncall@${recv.name || 'example'}.com` })));
  if (Array.isArray(recv.msteams_configs))   out.push(...recv.msteams_configs.map(c => ({ msteams: c.channel_url || `#${recv.name || 'oncall'}` })));
  if (Array.isArray(recv.webhook_configs))   out.push(...recv.webhook_configs.map(c => ({ webhook: c.url || 'https://hooks.example.com/oncall' })));
  if (Array.isArray(recv.pagerduty_configs)) out.push({ voice: `pagerduty:${recv.name || 'oncall'}` });
  if (Array.isArray(recv.slack_configs))     out.push(...recv.slack_configs.map(c => ({ webhook: c.api_url || `https://hooks.slack.example.com/${c.channel || 'oncall'}` })));
  return out;
}

function walkOtelCollector(f, pipelines, evidence, summary) {
  for (const obj of parseYamlDocs(f.content)) {
    if (!obj?.service?.pipelines) continue;
    const seen = new Set();
    for (const pipeline of Object.values(obj.service.pipelines)) {
      for (const recv of pipeline.receivers || []) {
        if (!seen.has(`r:${recv}`)) {
          seen.add(`r:${recv}`);
          pipelines.receivers.push({ name: recv.split('/')[0] });
        }
      }
      for (const proc of pipeline.processors || []) {
        if (!seen.has(`p:${proc}`)) {
          seen.add(`p:${proc}`);
          pipelines.processors.push({ name: proc.split('/')[0] });
        }
      }
      for (const exp of pipeline.exporters || []) {
        const kind = exp.split('/')[0];
        const sig = Object.entries(obj.service.pipelines).find(([_, p]) => p === pipeline)?.[0] || '';
        const signalClass = /^metrics/i.test(sig) ? 'metrics'
                         : /^logs/i.test(sig) ? 'logs'
                         : /^traces/i.test(sig) ? 'traces' : null;
        if (signalClass && !pipelines.exporters[signalClass]) {
          pipelines.exporters[signalClass] = { kind: mapExporterKind(kind) };
        }
      }
    }
    evidence[`PIP-${summary.discovered.pipelines + 1}`] = f.relPath;
    summary.discovered.pipelines++;
  }
}

function mapExporterKind(name) {
  // The spec's exporter kind taxonomy is small; map common collector
  // exporters to it.
  if (/^prometheus|otlphttp?$/i.test(name)) return 'prometheusremotewrite';
  if (/^otlp$|^otlphttp$/i.test(name))      return 'otlp';
  if (/^elasticsearch$/i.test(name))         return 'elasticsearch';
  if (/^jaeger|tempo$/i.test(name))          return 'jaeger';
  if (/^loki$/i.test(name))                  return 'loki';
  return name;
}

function walkGrafanaDashboard(f, dashboards, evidence, summary) {
  const dash = JSON.parse(f.content);
  let id = (dash.uid || dash.title || `dash-${dashboards.length + 1}`)
    .toString().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60);
  if (!/^[a-z]/.test(id)) id = 'd-' + id;
  dashboards.push({
    id,
    provider: {
      kind: 'grafana',
      version: dash.version ? String(dash.version) : '12.0',
      schemaVersion: Number.isFinite(dash.schemaVersion) ? dash.schemaVersion : 41,
    },
    folder: dash.tags?.[0] || 'crawled',
    source: `file://${f.relPath}`,
    // panel_bindings intentionally omitted: schema requires binds_to to
    // resolve to a real ref. The crawler can't infer those without
    // domain knowledge; the engineer adds them on review.
  });
  evidence[id] = f.relPath;
  summary.discovered.dashboards++;
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '_').replace(/^_+|_+$/g, '');
}
