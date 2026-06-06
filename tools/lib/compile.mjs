// tools/lib/compile.mjs
//
// Canonical ObservabilityPack v1.2 → real, ingestable platform artefacts.
//
// The pack is the source of truth. This module compiles it into the
// native formats the platform actually runs on:
//
//   prometheus-rules   Prometheus recording + multi-window burn-rate alerts
//   otel-collector     OTel Collector config (receivers/processors/exporters)
//   alertmanager       Alertmanager route tree + receivers
//   grafana-dashboard  Grafana 11 dashboard JSON (one pack section per call)
//
// Pure ESM, browser-friendly. No Node APIs.
//
// The unifying contract:
//
//   compile(canonical, target, opts) → {
//     contentType: 'application/x-yaml' | 'application/json',
//     filename: '<service>.<target>.<ext>',
//     content: '<string>',
//   }
//
// Per-target functions are exported too so the UI can render previews
// without going through the dispatcher.

import { emit as emitYaml } from './mini-yaml.mjs';

// ============================================================
// Helpers — ref resolution, slug normalisation, expression building
// ============================================================

const RATE_WINDOW_RECORD = '5m';   // default record window for ratio SLIs
const DEFAULT_DATASOURCE_UID = '${DS_PROMETHEUS}';

function slug(s) {
  if (typeof s !== 'string') return 'pack';
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function nameOf(canonical) {
  return canonical?.metadata?.name || canonical?.metadata?.bindings?.service || 'pack';
}

function serviceSlug(canonical) {
  return slug(nameOf(canonical)).replace(/-/g, '_');
}

function findSli(canonical, sliId) {
  if (!sliId) return null;
  const id = String(sliId).replace(/^slis\./, '');
  return (canonical?.spec?.slis || []).find(x => x.id === id) || null;
}

function findSlo(canonical, sloId) {
  if (!sloId) return null;
  const id = String(sloId).replace(/^slos\./, '').replace(/^ref:/, '');
  return (canonical?.spec?.slos || []).find(x => x.id === id) || null;
}

// Materialise an SLI's value as PromQL — used in recording rules and as
// the substitution target for `ref:slis.X` in any expression.
function sliExpression(sli) {
  if (!sli) return null;
  if (sli.type === 'ratio') {
    if (!sli.good || !sli.total) return null;
    return `(\n  ${strip(sli.good)}\n) / (\n  ${strip(sli.total)}\n)`;
  }
  if (sli.type === 'threshold' || sli.type === 'distribution') {
    return strip(sli.query);
  }
  if (sli.type === 'custom') return strip(sli.expression);
  return null;
}

function strip(s) {
  if (s == null) return '';
  return String(s).replace(/\n\s*$/g, '').trim();
}

// Substitute `ref:slis.X` and `ref:slos.X` in an expression with their
// materialised PromQL. The recording-rule shorthand the spec encourages.
function resolveRefs(expr, canonical) {
  if (typeof expr !== 'string') return expr;
  return expr.replace(/ref:slis\.([a-z][a-z0-9_-]*)/g, (_, id) => {
    const e = sliExpression(findSli(canonical, id));
    return e ? `(${e})` : `ref:slis.${id}`;
  }).replace(/ref:slos\.([a-z][a-z0-9_-]*)/g, (_, id) => {
    // SLO recording-rule references resolve to the SLO's underlying SLI
    // ratio; the resolved expression is "the SLI value".
    const slo = findSlo(canonical, id);
    const sli = slo ? findSli(canonical, slo.sli) : null;
    const e = sliExpression(sli);
    return e ? `(${e})` : `ref:slos.${id}`;
  });
}

// Convert a duration like "5m", "1h", "6h", "1d" to its integer value in
// seconds. Used to drive `for:` durations and window arithmetic.
const DURATION_UNITS = { ns: 1e-9, us: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2628000, y: 31536000 };
function durationSeconds(d) {
  if (typeof d !== 'number' && typeof d !== 'string') return null;
  if (typeof d === 'number') return d;
  let total = 0;
  const re = /([0-9]+(?:\.[0-9]+)?)(ns|us|ms|s|m|h|d|w|mo|y)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    total += parseFloat(m[1]) * (DURATION_UNITS[m[2]] || 0);
  }
  return total || null;
}

// ============================================================
// 1) Prometheus rules — recording + burn-rate alerts
// ============================================================

export function compilePrometheusRules(canonical) {
  const svc = serviceSlug(canonical);
  const groups = [];

  // ----- recording rules -----
  // (a) Per-SLO ratio rule at the standard record window. This is the
  // "ground truth" series everything else hangs off.
  const recordingRules = [];
  for (const slo of canonical?.spec?.slos || []) {
    const sli = findSli(canonical, slo.sli);
    if (!sli) continue;
    const expr = sliExpression(sli);
    if (!expr) continue;
    if (sli.type === 'ratio') {
      // Materialise good/total/ratio so downstream alerts read the
      // recorded series, not the raw expression each evaluation.
      recordingRules.push({
        record: `${svc}:${sli.id}:good_${RATE_WINDOW_RECORD}`,
        expr: strip(sli.good),
        labels: { slo: slo.id, sli: sli.id, service: nameOf(canonical) },
      });
      recordingRules.push({
        record: `${svc}:${sli.id}:total_${RATE_WINDOW_RECORD}`,
        expr: strip(sli.total),
        labels: { slo: slo.id, sli: sli.id, service: nameOf(canonical) },
      });
      recordingRules.push({
        record: `${svc}:${sli.id}:ratio_${RATE_WINDOW_RECORD}`,
        expr: `${svc}:${sli.id}:good_${RATE_WINDOW_RECORD} / ${svc}:${sli.id}:total_${RATE_WINDOW_RECORD}`,
        labels: { slo: slo.id, sli: sli.id, service: nameOf(canonical) },
      });
      recordingRules.push({
        record: `${svc}:${sli.id}:error_ratio_${RATE_WINDOW_RECORD}`,
        expr: `1 - ${svc}:${sli.id}:ratio_${RATE_WINDOW_RECORD}`,
        labels: { slo: slo.id, sli: sli.id, service: nameOf(canonical) },
      });
    } else {
      recordingRules.push({
        record: `${svc}:${sli.id}:value_${RATE_WINDOW_RECORD}`,
        expr,
        labels: { slo: slo.id, sli: sli.id, service: nameOf(canonical) },
      });
    }
  }

  // (b) Author-declared recording rules — resolve symbolic refs.
  for (const rule of canonical?.spec?.queries?.recording_rules || []) {
    recordingRules.push({
      record: rule.name,
      expr: resolveRefs(rule.expr, canonical),
      ...(rule.interval ? { } : {}),
      ...(rule.labels ? { labels: rule.labels } : {}),
    });
  }

  if (recordingRules.length) {
    groups.push({
      name: `${svc}_recording`,
      interval: '30s',
      rules: recordingRules,
    });
  }

  // ----- burn-rate alerts -----
  // The pack expresses these declaratively as (slo, [{short, long, factor,
  // severity}]). We emit one alert per window: multi-window correlation
  // (short AND long both burning at factor×budget) per the Google SRE
  // burn-rate playbook.
  for (const ba of canonical?.spec?.policy?.burn_rate_alerts || []) {
    const slo = findSlo(canonical, ba.slo);
    if (!slo) continue;
    const sli = findSli(canonical, slo.sli);
    if (!sli || sli.type !== 'ratio') continue;
    const budget = 1 - slo.objective;
    if (!(budget > 0)) continue;

    const rules = [];
    for (const w of ba.windows || []) {
      const short = w.short, long = w.long;
      const factor = w.factor || 1;
      const sev = w.severity || 'SEV3';
      const alertName = `${slo.id}_burn_${factor}x_${short}_${long}`.replace(/[^a-zA-Z0-9_]/g, '_');
      const recordBase = `${svc}:${sli.id}`;
      const shortErr = `(1 - sum(rate(${strip(sli.good)}[${short}])) / sum(rate(${strip(sli.total)}[${short}])))`;
      const longErr  = `(1 - sum(rate(${strip(sli.good)}[${long}])) / sum(rate(${strip(sli.total)}[${long}])))`;
      const threshold = (factor * budget).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
      rules.push({
        alert: alertName,
        expr: `(${shortErr} > ${threshold}) and (${longErr} > ${threshold})`,
        for: shortFor(short),
        labels: {
          severity: sev,
          slo: slo.id,
          sli: sli.id,
          service: nameOf(canonical),
          burn_rate: String(factor),
          window_short: short,
          window_long: long,
        },
        annotations: {
          summary: `Burn rate ${factor}× on ${slo.id}`,
          description: `Both the ${short} and ${long} error rates exceed ${factor}× of the ${(budget * 100).toFixed(3)}% error budget for ${slo.id}.`,
          slo_objective: `${(slo.objective * 100).toFixed(3)}%`,
          slo_window: slo.window,
          runbook: '(supply runbook URL)',
        },
      });
    }

    if (rules.length) {
      groups.push({
        name: `${svc}_${slo.id}_burn`,
        interval: '30s',
        rules,
      });
    }
  }

  // ----- forecast alerts -----
  // The spec carves a separate `forecasts` block; we emit them as
  // alerting rules using `predict_linear` (the standard PromQL forecasting
  // primitive). They're advisory by default; the on_projected_breach
  // field rides into annotations so Alertmanager can route accordingly.
  const forecastRules = [];
  for (const f of canonical?.spec?.policy?.forecasts || []) {
    const slo = findSlo(canonical, f.slo);
    if (!slo) continue;
    const sli = findSli(canonical, slo.sli);
    if (!sli || sli.type !== 'ratio') continue;
    const horizonSec = durationSeconds(f.horizon || '7d') || (7 * 86400);
    const budget = (1 - slo.objective).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    forecastRules.push({
      alert: `${slo.id}_forecast_breach`,
      expr: `predict_linear(${svc}:${sli.id}:error_ratio_${RATE_WINDOW_RECORD}[1h], ${horizonSec}) > ${budget}`,
      for: '15m',
      labels: { severity: 'SEV3', slo: slo.id, kind: 'forecast', service: nameOf(canonical) },
      annotations: {
        summary: `${slo.id} projected to breach within ${f.horizon || '7d'}`,
        method: f.method || 'linear',
        on_projected_breach: f.on_projected_breach || 'open_ticket',
      },
    });
  }
  if (forecastRules.length) {
    groups.push({ name: `${svc}_forecast`, interval: '5m', rules: forecastRules });
  }

  const out = {
    // A header comment marks provenance so a Promtool-validated rules
    // file is also traceable back to the canonical pack that emitted it.
    groups,
  };

  return banner('Prometheus rules', canonical) + emitYaml(out);
}

function shortFor(d) {
  // 2 minutes is a reasonable default for `for:` on a 5m short-window
  // burn-rate alert. Otherwise pin it to short / 2 if we can parse.
  const s = durationSeconds(d);
  if (!s) return '2m';
  if (s <= 300) return '2m';
  if (s <= 1800) return '5m';
  return '10m';
}

// ============================================================
// 2) Alertmanager routes + receivers
// ============================================================

const CHANNEL_TO_RECEIVER = {
  msteams:  'msteams_configs',
  voice:    'pagerduty_configs',
  whatsapp: 'webhook_configs',
  email:    'email_configs',
  webhook:  'webhook_configs',
};

export function compileAlertmanager(canonical) {
  const routes = canonical?.spec?.alerting?.routes || [];
  const suppress = canonical?.spec?.alerting?.suppress || [];
  const svc = nameOf(canonical);

  const receivers = [];
  const childRoutes = [];

  routes.forEach((route, i) => {
    const recName = `${slug(svc)}-${(route.severity || 'sev').toLowerCase()}`;
    const recCfg = { name: recName };
    for (const ch of route.channels || []) {
      const kind = Object.keys(ch)[0];
      const target = ch[kind];
      const key = CHANNEL_TO_RECEIVER[kind] || 'webhook_configs';
      recCfg[key] = recCfg[key] || [];
      if (kind === 'msteams')      recCfg[key].push({ webhook_url: `# secret: msteams_${slug(target)}`, send_resolved: true, room: target });
      else if (kind === 'voice')   recCfg[key].push({ service_key: `# secret: pagerduty_${slug(target.replace(/^.*:\/\//, ''))}`, target });
      else if (kind === 'whatsapp')recCfg[key].push({ url: `# secret: whatsapp_${slug(target)}`, target });
      else if (kind === 'email')   recCfg[key].push({ to: target, send_resolved: true });
      else if (kind === 'webhook') recCfg[key].push({ url: target, send_resolved: true });
    }
    receivers.push(recCfg);

    const match = {
      severity: route.severity,
      service: svc,
      ...(route.match || {}),
    };
    childRoutes.push({
      receiver: recName,
      group_by: ['slo', 'severity', 'alertname'],
      group_wait: '30s',
      group_interval: '5m',
      repeat_interval: route.severity === 'SEV1' ? '1h' : '4h',
      matchers: Object.entries(match).filter(([_, v]) => !!v).map(([k, v]) => `${k}="${v}"`),
    });
  });

  // Default "null" receiver for unmatched alerts so the config doesn't
  // claim a route to nowhere.
  if (!receivers.find(r => r.name === 'null')) {
    receivers.unshift({ name: 'null' });
  }

  const inhibit_rules = suppress.includes('maintenance_windows') ? [
    {
      source_matchers: ['maintenance="true"'],
      target_matchers: [`service="${svc}"`],
      equal: ['service'],
    },
  ] : undefined;

  const out = {
    global: { resolve_timeout: '5m' },
    route: {
      receiver: 'null',
      group_by: ['alertname', 'severity'],
      group_wait: '15s',
      group_interval: '5m',
      repeat_interval: '12h',
      routes: childRoutes,
    },
    receivers,
    ...(inhibit_rules ? { inhibit_rules } : {}),
  };
  return banner('Alertmanager config', canonical) + emitYaml(out);
}

// ============================================================
// 3) OTel Collector — receivers + processors + exporters + service.pipelines
// ============================================================

export function compileOtelCollector(canonical) {
  const p = canonical?.spec?.pipelines || {};
  const otel = canonical?.spec?.otel || {};

  // Receivers
  const receivers = {};
  for (const r of p.receivers || []) {
    const name = r.name;
    if (name === 'otlp') {
      receivers.otlp = {
        protocols: {
          grpc: { endpoint: r.endpoint || '0.0.0.0:4317' },
          http: { endpoint: '0.0.0.0:4318' },
        },
      };
    } else if (name === 'prometheus' && r.scrape_configs) {
      receivers.prometheus = { config: { scrape_configs: r.scrape_configs } };
    } else {
      // Round-trip whatever else the pack declares.
      const { name: _n, ...rest } = r;
      receivers[name] = Object.keys(rest).length ? rest : {};
    }
  }

  // Processors — inject the OTel-block-derived resource processor first
  // so service.name etc. land on every signal.
  const processors = {};
  const required = otel.resource_attributes?.required || [];
  if (required.length) {
    processors.resource = {
      attributes: required.map(k => ({ key: k, action: 'upsert', from_context: 'auto.populate' })),
    };
  }
  if (otel.sdk?.sampling?.policy?.startsWith('parentbased_') && otel.sdk?.sampling?.ratio != null) {
    processors.probabilistic_sampler = {
      sampling_percentage: Math.round(otel.sdk.sampling.ratio * 100),
    };
  }
  for (const proc of p.processors || []) {
    const { name, ...rest } = proc;
    processors[name] = Object.keys(rest).length ? rest : {};
  }

  // Exporters
  const exporters = {};
  const exporterNames = { metrics: '', logs: '', traces: '' };
  for (const sig of ['metrics', 'logs', 'traces']) {
    const e = p.exporters?.[sig];
    if (!e) continue;
    const exporterName = e.kind;
    exporterNames[sig] = exporterName;
    const { kind, ...rest } = e;
    exporters[exporterName] = Object.assign(exporters[exporterName] || {}, rest);
  }

  // service.pipelines
  const pipelineNames = Object.keys(receivers);
  const processorNames = Object.keys(processors);
  const service = {
    telemetry: {
      logs: { level: 'info', development: false },
      metrics: { address: '0.0.0.0:8888' },
    },
    pipelines: {},
  };
  for (const sig of ['metrics', 'logs', 'traces']) {
    if (!exporterNames[sig]) continue;
    service.pipelines[sig] = {
      receivers: pipelineNames,
      processors: processorNames,
      exporters: [exporterNames[sig]],
    };
  }

  const out = {
    receivers,
    processors,
    exporters,
    service,
  };
  return banner('OTel Collector', canonical) + emitYaml(out);
}

// ============================================================
// 4) Grafana 11 dashboard JSON — one per dashboards[] entry
// ============================================================

export function compileGrafanaDashboard(canonical, dashboardId) {
  const dash = (canonical?.spec?.dashboards || []).find(d => d.id === dashboardId);
  if (!dash) throw new Error(`dashboard not found: ${dashboardId}`);
  const svc = nameOf(canonical);
  const svcS = serviceSlug(canonical);

  const dsMetrics = { type: 'prometheus', uid: DEFAULT_DATASOURCE_UID };
  const panels = [];
  let panelId = 0;
  let row = 0;
  const cols = 2;
  const w = 12, h = 8;

  const bindings = dash.panel_bindings || [];
  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i];
    const target = b.binds_to || '';
    const isSli = /^slis\./.test(target);
    const isSlo = /^slos\./.test(target);
    const sli = isSli ? findSli(canonical, target) : (isSlo ? findSli(canonical, findSlo(canonical, target)?.sli) : null);
    const slo = isSlo ? findSlo(canonical, target) : null;
    const sliId = sli?.id;

    panelId++;
    const x = (i % cols) * w;
    const y = Math.floor(i / cols) * h;

    const panel = {
      id: panelId,
      title: b.panel || target,
      type: 'timeseries',
      datasource: dsMetrics,
      gridPos: { x, y, w, h },
      targets: [{
        refId: 'A',
        datasource: dsMetrics,
        expr: sli && sli.type === 'ratio'
          ? `${svcS}:${sliId}:ratio_${RATE_WINDOW_RECORD}`
          : (sli ? sliExpression(sli) : `# unresolved: ${target}`),
        legendFormat: sliId || target,
      }],
      fieldConfig: {
        defaults: {
          ...(sli && sli.type === 'ratio'
            ? { unit: 'percentunit', min: 0, max: 1 }
            : { unit: sli?.unit === 'seconds' ? 's' : 'short' }),
          custom: { drawStyle: 'line', fillOpacity: 12, lineWidth: 2, pointSize: 3 },
        },
        overrides: [],
      },
      options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    };

    // SLO panels get the objective rendered as a threshold line.
    if (slo) {
      panel.fieldConfig.defaults.thresholds = {
        mode: 'absolute',
        steps: [
          { color: 'red',   value: null },
          { color: 'green', value: slo.objective },
        ],
      };
      panel.fieldConfig.defaults.custom.thresholdsStyle = { mode: 'line' };
    }

    panels.push(panel);
  }

  // Always lead with a "SLO status" stat row when the dashboard binds at
  // least one SLO — it's the at-a-glance the on-call wants first.
  const sloBindings = bindings.filter(b => /^slos\./.test(b.binds_to));
  if (sloBindings.length) {
    const statPanels = sloBindings.map((b, i) => {
      const slo = findSlo(canonical, b.binds_to);
      const sli = slo ? findSli(canonical, slo.sli) : null;
      panelId++;
      return {
        id: panelId,
        title: slo?.id || b.binds_to,
        type: 'stat',
        datasource: dsMetrics,
        gridPos: { x: (i % 4) * 6, y: 0, w: 6, h: 4 },
        targets: [{
          refId: 'A',
          datasource: dsMetrics,
          expr: sli && sli.type === 'ratio' ? `${svcS}:${sli.id}:ratio_${RATE_WINDOW_RECORD}` : '',
          legendFormat: slo?.id,
        }],
        fieldConfig: {
          defaults: {
            unit: 'percentunit', decimals: 2,
            thresholds: {
              mode: 'absolute',
              steps: [
                { color: 'red',   value: null },
                { color: 'orange', value: (slo?.objective || 0.99) - 0.005 },
                { color: 'green', value: slo?.objective || 0.99 },
              ],
            },
          },
        },
        options: { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'background', graphMode: 'area' },
      };
    });
    // Shift the rest of the panels down by 4 rows.
    for (const p of panels) p.gridPos.y += 4;
    panels.unshift(...statPanels);
  }

  const out = {
    title: dash.id,
    uid: `obs-pack-${svcS}-${slug(dash.id)}`,
    description: `Compiled from ${nameOf(canonical)} pack. Do not hand-edit — re-emit from the pack.`,
    tags: ['observability-pack', svcS],
    timezone: 'browser',
    schemaVersion: dash.provider?.schemaVersion ?? 39,
    version: 1,
    refresh: '30s',
    time: { from: 'now-6h', to: 'now' },
    panels,
    templating: { list: [] },
    annotations: { list: [{ datasource: dsMetrics, enable: true, name: 'Annotations & Alerts', target: { matchAny: false, tags: [], type: 'dashboard' } }] },
  };
  return JSON.stringify(out, null, 2);
}

// ============================================================
// Banner — small provenance comment at the top of YAML outputs.
// ============================================================

function banner(target, canonical) {
  return (
    `# ${target} compiled from ObservabilityPack v1.2\n` +
    `# Pack: ${nameOf(canonical)} · version ${canonical?.metadata?.version || '?'}\n` +
    `# Source of truth — DO NOT hand-edit. Re-emit from the pack.\n` +
    `# Generated by tools/lib/compile.mjs\n`
  );
}

// ============================================================
// Dispatcher
// ============================================================

export const TARGETS = {
  'prometheus-rules': {
    label: 'Prometheus rules',
    description: 'Recording + multi-window burn-rate alerting rules. Ingestible by Prometheus or Mimir ruler.',
    contentType: 'application/x-yaml',
    extension: 'yaml',
    suggestedFile: (canonical) => `${serviceSlug(canonical)}.rules.yaml`,
    compile: (canonical) => compilePrometheusRules(canonical),
  },
  'otel-collector': {
    label: 'OTel Collector',
    description: 'OpenTelemetry Collector config (receivers / processors / exporters / service.pipelines).',
    contentType: 'application/x-yaml',
    extension: 'yaml',
    suggestedFile: (canonical) => `${serviceSlug(canonical)}.otel-collector.yaml`,
    compile: (canonical) => compileOtelCollector(canonical),
  },
  'alertmanager': {
    label: 'Alertmanager',
    description: 'Route tree + receivers per severity. Inhibit rules from suppress contexts.',
    contentType: 'application/x-yaml',
    extension: 'yaml',
    suggestedFile: (canonical) => `${serviceSlug(canonical)}.alertmanager.yaml`,
    compile: (canonical) => compileAlertmanager(canonical),
  },
  'grafana-dashboard': {
    label: 'Grafana dashboard',
    description: 'Grafana 11 dashboard JSON. One per `spec.dashboards[]` entry; pass the dashboard id as an arg.',
    contentType: 'application/json',
    extension: 'json',
    suggestedFile: (canonical, opts) => `${serviceSlug(canonical)}.${slug(opts?.dashboardId || 'dashboard')}.json`,
    compile: (canonical, opts) => compileGrafanaDashboard(canonical, opts?.dashboardId || canonical?.spec?.dashboards?.[0]?.id),
  },
};

export function compile(canonical, target, opts = {}) {
  const t = TARGETS[target];
  if (!t) throw new Error(`unknown compile target: ${target}. Try one of: ${Object.keys(TARGETS).join(', ')}`);
  return {
    target,
    contentType: t.contentType,
    filename: t.suggestedFile(canonical, opts),
    content: t.compile(canonical, opts),
  };
}

export function listTargets() {
  return Object.entries(TARGETS).map(([id, t]) => ({
    id,
    label: t.label,
    description: t.description,
    contentType: t.contentType,
    extension: t.extension,
  }));
}
