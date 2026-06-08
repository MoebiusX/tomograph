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
import { inferSlisFromRecordingRules, ruleNameToSloId } from './sli-inference.mjs';

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
 *                          'otel-collector' | 'docker-compose' | 'helm-chart' |
 *                          'helm-template' | 'unknown'
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

  // Helm template — Go-template scaffolding ({{ include ... }}, {{ .Values.x }})
  // breaks plain YAML parsing, so these files would otherwise be misclassified
  // or silently dropped. Route them to walkHelmTemplate, which lifts the
  // observability payloads embedded in rendered ConfigMaps (Prometheus rules,
  // dashboards, …). Checked before the filename heuristics because a templated
  // `configmap-alertmanager.yaml` is a Helm template first, an Alertmanager
  // config second.
  if (looksLikeHelm(content)) return 'helm-template';

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
        case 'helm-template':    walkHelmTemplate(f, { backends, recordingRules, burnRateAlerts, alertingRoutes, dashboards, pipelines }, evidence, summary); break;
        // Chart.yaml itself carries no observability contracts — the payloads
        // live in the templated manifests (handled as 'helm-template'). We
        // record the chart only as a signal that this is a Helm-packaged repo.
        case 'helm-chart':       summary.discovered.helmCharts = (summary.discovered.helmCharts || 0) + 1; break;
      }
    } catch (e) {
      summary.warnings.push(`Failed to parse ${f.relPath}: ${e.message}`);
    }
  }

  // ----- infer SLIs/SLOs (decompiler ⇄ compiler symmetry) -----
  // PRIMARY source: recording rules. compile.mjs materialises every SLI in
  // spec.slis as `<svc>:<sli>:<op>` recording rules, so reading those names
  // back is the exact inverse — and it is the SAME derivation the live
  // system reconstruction uses (tools/fetch-live-pack.mjs). A pack that is
  // compiled, deployed, then crawled (or drafted from its live MCP) now
  // describes its L1 contracts in one shared vocabulary, so diff.mjs can
  // actually match them instead of reporting false drift.
  const sliMap = new Map();
  const sloMap = new Map();
  for (const { sli, slo } of inferSlisFromRecordingRules(recordingRules)) {
    if (!sliMap.has(sli.id)) { sliMap.set(sli.id, sli); summary.inferred.slis++; }
    if (!sloMap.has(slo.id)) { sloMap.set(slo.id, slo); summary.inferred.slos++; }
  }

  // Burn-rate alerts target an SLO. The compiler only ever emits alerts
  // FROM an SLO, so the faithful inverse treats recording rules as the
  // authoritative L1 source and reverses an alert into a contract only when
  // it is genuinely an SLO burn-rate alert:
  //   1. it references a recorded ratio series we already turned into an
  //      SLO (the exact inverse of compile.mjs) — link it; or
  //   2. no recording-rule SLIs were discovered at all (a tier-3 repo) — in
  //      that case fall back to the legacy alert-name synthesis so the pack
  //      still has at least one contract.
  // Operational alerts (CPU, disk, pod, queue-down, …) in a repo that DOES
  // define recorded SLIs are NOT SLOs; they're dropped from the burn-rate
  // policy rather than manufacturing junk L1 contracts that can never match
  // the live system.
  const haveRecordedSlis = sliMap.size > 0;
  for (const alert of burnRateAlerts) {
    const linked = linkAlertToRecordedSlo(alert, sloMap);
    if (linked) { alert.slo = linked; continue; }

    if (haveRecordedSlis) { alert._drop = true; continue; }

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
      summary.inferred.slos++;
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
    }
  }

  // Drop operational (non-SLO) alerts, then fold the remaining burn-rate
  // alerts that now share a recording-rule SLO into one entry per SLO,
  // unioning their windows so the emitted policy stays valid.
  const droppedOps = burnRateAlerts.filter(a => a._drop).length;
  if (droppedOps) {
    summary.warnings.push(`Excluded ${droppedOps} operational alert(s) from burn-rate policy — not SLO burn-rate alerts (no recorded-ratio reference). They remain available as alerting signals.`);
  }
  for (let i = burnRateAlerts.length - 1; i >= 0; i--) {
    if (burnRateAlerts[i]._drop) burnRateAlerts.splice(i, 1);
  }
  dedupeBurnRateAlerts(burnRateAlerts);


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
      policy: { burn_rate_alerts: burnRateAlerts.map(({ slo, windows }) => ({ slo, windows })) },
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
// Helm chart introspection
// ============================================================

// Does this file carry Go/Helm template scaffolding? We deliberately key off
// the unambiguous Helm signals \u2014 the `include`/`template`/`tpl`/`define`/`block`
// functions and the built-in `.Values` / `.Release` / `.Chart` / `.Capabilities`
// / `.Files` objects. This is intentionally narrower than "contains `{{`": bare
// `{{ $labels.x }}` / `{{ $value }}` / `{{ range .Alerts }}` appear in ordinary
// Prometheus and Alertmanager annotation templating and must NOT be mistaken
// for Helm.
function looksLikeHelm(content) {
  return /\{\{-?\s*(include|template|tpl|define|block)\b/.test(content)
      || /\{\{[^{}]*\.(Values|Release|Chart|Capabilities|Files)\b/.test(content);
}

// Best-effort neutralisation of Go/Helm template syntax so the underlying YAML
// structure can be parsed. Pure control-flow / definition lines ({{- if }},
// {{- end }}, {{- range }}, comments, \u2026) are dropped; inline value injections
// ({{ .Values.x }}, {{ include "\u2026" . }}) collapse to a stable placeholder
// token. We are not rendering the chart \u2014 only recovering enough shape to read
// the embedded observability contracts back out.
function stripGoTemplate(content) {
  return content.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (/^\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}$/.test(t)) return null;            // comment
    if (/^\{\{-?\s*(if|else|end|range|with|define|block)\b.*?-?\}\}$/.test(t)) return null; // control flow
    return line
      .replace(/\{\{-?\s*"\{\{"\s*-?\}\}/g, '{')   // Helm literal-open escape: {{ "{{" }} -> {
      .replace(/\{\{-?\s*"\}\}"\s*-?\}\}/g, '}')   // Helm literal-close escape: {{ "}}" }} -> }
      .replace(/\{\{-?[\s\S]*?-?\}\}/g, 'helmvalue'); // inline value injection
  }).filter((l) => l !== null).join('\n');
}

// Lift the embedded file payloads out of a Kubernetes ConfigMap's `data:` map.
// Each `  <name>.<ext>: |` literal-block scalar (Prometheus rules, scrape
// configs, dashboards, \u2026) is captured verbatim and de-indented. The scan is
// purely indentation-driven, so the surrounding Helm/Go-template directives in
// the unrendered manifest don't get in the way.
function extractConfigMapData(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let dataIndent = -1;      // indentation of the active `data:` key, or -1
  let current = null;       // { key, indent, body: [] }

  const flush = () => {
    if (current && current.body.some((l) => l.trim())) {
      const widths = current.body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
      const base = widths.length ? Math.min(...widths) : 0;
      blocks.push({ key: current.key, body: current.body.map((l) => l.slice(base)).join('\n') });
    }
    current = null;
  };

  for (const line of lines) {
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();

    if (current) {
      // Literal-block body continues while indentation stays deeper than the
      // key (blank lines belong to the block too).
      if (trimmed === '' || indent > current.indent) { current.body.push(line); continue; }
      flush(); // fall through to re-classify the dedented line below
    }

    const dataM = /^(\s*)data:\s*$/.exec(line);
    if (dataM) { dataIndent = dataM[1].length; continue; }

    if (dataIndent >= 0) {
      if (trimmed !== '' && indent <= dataIndent) {
        dataIndent = -1;   // left the data block
      } else {
        const keyM = /^(\s*)([\w][\w.\-]*):\s*\|[-+0-9]*\s*$/.exec(line);
        if (keyM && keyM[1].length > dataIndent) {
          current = { key: keyM[2], indent: keyM[1].length, body: [] };
          continue;
        }
      }
    }
  }
  flush();
  return blocks;
}

// Content-only artefact sniff (no filename heuristics). Used for the Helm
// whole-document fallback, where template names like `deployment-alertmanager.yaml`
// would otherwise mislead the filename-based detector into parsing a Deployment
// as an Alertmanager config. We only route a templated document when its *shape*
// genuinely matches an observability artefact.
function sniffObservabilityKind(content) {
  let obj;
  try { obj = parseYaml(content); } catch (_) { return 'unknown'; }
  if (!obj || typeof obj !== 'object') return 'unknown';
  if (Array.isArray(obj.groups) && obj.groups.some(g => g.rules?.some(r => 'record' in r || 'alert' in r))) return 'prometheus-rules';
  if (obj.route && Array.isArray(obj.receivers)) return 'alertmanager';
  if (obj.receivers && obj.exporters && obj.service?.pipelines) return 'otel-collector';
  if (obj.services && typeof obj.services === 'object'
      && Object.values(obj.services).some(s => s?.image)) return 'docker-compose';
  return 'unknown';
}

// Introspect a Helm template. The valuable observability contracts in a chart
// are rendered into Kubernetes ConfigMaps (Prometheus recording/alerting rules,
// Grafana dashboards, Alertmanager routes, OTel pipelines). We extract those
// embedded payloads and route each through the same per-kind walker the raw
// artefact would use \u2014 so a rule shipped inside a chart is decompiled exactly
// like a rule shipped as a standalone file. If the template embeds nothing, we
// strip the scaffolding and treat the document itself as a single manifest.
function walkHelmTemplate(f, buckets, evidence, summary) {
  const { backends, recordingRules, burnRateAlerts, alertingRoutes, dashboards, pipelines } = buckets;
  const route = (kind, sub) => {
    switch (kind) {
      case 'prometheus-rules': walkPrometheusRules(sub, recordingRules, burnRateAlerts, evidence, summary); return true;
      case 'alertmanager':     walkAlertmanager(sub, alertingRoutes, evidence, summary); return true;
      case 'otel-collector':   walkOtelCollector(sub, pipelines, evidence, summary); return true;
      case 'grafana-dashboard':walkGrafanaDashboard(sub, dashboards, evidence, summary); return true;
      case 'docker-compose':   walkDockerCompose(sub, backends, evidence, summary); return true;
      default: return false;
    }
  };

  const blocks = extractConfigMapData(f.content);

  for (const { key, body } of blocks) {
    const clean = stripGoTemplate(body);
    const lk = key.toLowerCase();
    const sub = { relPath: `${f.relPath}#${key}`, content: clean };
    let kind = 'unknown';

    if (/rule/.test(lk) || /^groups:\s*$/m.test(clean))                              kind = 'prometheus-rules';
    else if (lk.endsWith('.json') || /"schemaVersion"\s*:/.test(clean))              kind = 'grafana-dashboard';
    else if (/^route:/m.test(clean) && /^receivers:/m.test(clean))                   kind = 'alertmanager';
    else if (/^receivers:/m.test(clean) && /^exporters:/m.test(clean) && /pipelines:/.test(clean)) kind = 'otel-collector';

    // A ConfigMap whose data key looks like an observability artefact but
    // can't be parsed is a genuine signal worth surfacing; ordinary
    // non-observability data keys (scripts, plain config) are simply skipped.
    try { route(kind, sub); }
    catch (e) { summary.warnings.push(`Failed to parse ${sub.relPath}: ${e.message}`); }
  }

  // No embedded ConfigMap payloads — the template may itself be a single
  // observability manifest. Route it only when its *shape* matches (filename
  // heuristics are unreliable for Helm template names like
  // `deployment-alertmanager.yaml`); stay silent otherwise, since the
  // overwhelming majority of chart templates are Deployments, Services,
  // Secrets, etc. that carry no observability contracts.
  if (blocks.length === 0) {
    const clean = stripGoTemplate(f.content);
    const kind = sniffObservabilityKind(clean);
    if (kind !== 'unknown') {
      try { route(kind, { relPath: f.relPath, content: clean }); } catch (_) { /* speculative */ }
    }
  }
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
            const expr = typeof rule.expr === 'string' ? rule.expr : String(rule.expr || '');
            burnRateAlerts.push({ slo: sloId, windows, expr, alertName });
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

// Map a burn-rate alert to a recording-rule-derived SLO by scanning its
// expression for any `ns:metric:op` recorded-series reference. Returns the
// matching SLO id present in `sloMap`, or null. This is the inverse of the
// compiler, which builds burn-rate alerts on top of the recorded ratios.
function linkAlertToRecordedSlo(alert, sloMap) {
  const expr = typeof alert?.expr === 'string' ? alert.expr : '';
  if (!expr) return null;
  const re = /[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z0-9_]+/g;
  let m;
  while ((m = re.exec(expr)) !== null) {
    const sloId = ruleNameToSloId(m[0]);
    if (sloId && sloMap.has(sloId)) return sloId;
  }
  return null;
}

// Collapse burn-rate alerts that now share an SLO (after linking) into one
// entry per SLO, unioning their windows (de-duplicated by short/long/factor)
// so spec.policy.burn_rate_alerts stays one-entry-per-SLO and valid.
function dedupeBurnRateAlerts(alerts) {
  const bySlo = new Map();
  for (const a of alerts) {
    if (!bySlo.has(a.slo)) { bySlo.set(a.slo, a); continue; }
    const tgt = bySlo.get(a.slo);
    const seen = new Set((tgt.windows || []).map(w => `${w.short}|${w.long}|${w.factor}`));
    for (const w of a.windows || []) {
      const k = `${w.short}|${w.long}|${w.factor}`;
      if (!seen.has(k)) { tgt.windows.push(w); seen.add(k); }
    }
    a._drop = true;
  }
  for (let i = alerts.length - 1; i >= 0; i--) {
    if (alerts[i]._drop) alerts.splice(i, 1);
  }
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
