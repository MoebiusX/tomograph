// tools/lib/promtest-gen.mjs
//
// T3 of docs/TEST_PLAN_COMPILER_VALIDITY.md — BEHAVIORAL fixtures for
// `promtool test rules`, generated FROM THE PACK ITSELF so they stay in
// lock-step with what the compiler emits. A rules file can be
// syntactically perfect (T1) and still encode an alert that can never
// fire; this tier proves the behaviour:
//
//   - healthy synthetic series (error rate 0)  → burn alerts DO NOT fire,
//     and the :ratio_5m recording rule evaluates to exactly 1;
//   - breach synthetic series (good rate 0)    → every burn alert FIRES
//     with the exact labels + annotations the compiler emitted, and
//     :error_ratio_5m evaluates to exactly 1.
//
// Expectations (labels, annotations, `for:`) are read from the COMPILED
// rules YAML, never re-derived — if the compiler changes its emission,
// the fixtures change with it and promtool re-judges the behaviour.
//
// Series synthesis: SLI legs are recognised when they have the shape
// `sum(rate(<selector>[<win>]))` (any aggregation-less wrapper of one
// selector) or a bare selector. Matchers are honoured by synthesising
// concrete label values: `=` copies the value, `!=` / `!~` / `=~` pick a
// satisfying literal. Legs outside this shape (scalars, multi-selector
// expressions) are SKIPPED with a reason — the caller asserts a coverage
// floor so the tier cannot silently evaporate.

import { parse as parseYaml } from './mini-yaml.mjs';

// ---------- selector recognition ----------

// One vector selector: metric{matchers}. Returns null when the leg isn't
// a single-selector shape we can honestly synthesise series for.
function recogniseLeg(raw) {
  const e = String(raw || '').trim();
  if (!e || /^\d+(\.\d+)?$/.test(e)) return null;             // scalar / empty
  // Strip a single sum(rate( ... [win])) (or avg/min/max) wrapper, or
  // accept a bare selector. Multiple selectors → unsupported.
  const m = /^(?:sum|avg|min|max)?\s*\(?\s*rate\s*\(\s*([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(\{[\s\S]*?\})?\s*\[[^\]]+\]\s*\)\s*\)?$/.exec(e)
    || /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(\{[\s\S]*?\})?$/.exec(e);
  if (!m) return null;
  const metric = m[1];
  const matchers = [];
  if (m[2]) {
    const body = m[2].slice(1, -1);
    // Split on commas not inside quotes.
    for (const part of body.match(/[a-zA-Z_][a-zA-Z0-9_]*\s*(=~|!~|!=|=)\s*"(?:[^"\\]|\\.)*"/g) || []) {
      const mm = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"$/.exec(part.trim());
      if (!mm) return null;
      matchers.push({ label: mm[1], op: mm[2], value: mm[3].replace(/\\(.)/g, '$1') });
    }
    // If the matcher block had content we failed to consume, bail honestly.
    const consumed = (body.match(/=~|!~|!=|=/g) || []).length;
    if (consumed !== matchers.length) return null;
  }
  return { metric, matchers };
}

// Pick a concrete label value satisfying one matcher (null = impossible
// for our candidate pool → leg unsupported).
const CANDIDATES = ['200', 'ok', 'a', 'GET', 'prod', 'x1'];
function satisfy(matcher) {
  const { op, value } = matcher;
  if (op === '=') return value;
  if (op === '!=') return CANDIDATES.find(c => c !== value) ?? null;
  let re;
  try { re = new RegExp(`^(?:${value})$`); } catch (_) { return null; }
  if (op === '=~') {
    // Literal alternations are the honest case (e.g. "GET|POST").
    const lit = value.split('|').find(v => /^[\w./-]+$/.test(v) && re.test(v));
    return lit ?? CANDIDATES.find(c => re.test(c)) ?? null;
  }
  // !~ — pick a candidate the pattern does NOT match.
  return CANDIDATES.find(c => !re.test(c)) ?? null;
}

// Violate one matcher (for the error-series complement of `good`).
function violate(matcher) {
  const { op, value } = matcher;
  if (op === '=') return CANDIDATES.find(c => c !== value) ?? null;
  if (op === '!=') return value;
  let re;
  try { re = new RegExp(`^(?:${value})$`); } catch (_) { return null; }
  if (op === '=~') return CANDIDATES.find(c => !re.test(c)) ?? null;
  // !~ — pick a value the pattern DOES match (e.g. "500" for "5..").
  return ['500', ...CANDIDATES].find(c => re.test(c)) ?? null;
}

function seriesString(metric, labelMap) {
  const labels = Object.entries(labelMap).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`).join(',');
  return labels ? `${metric}{${labels}}` : metric;
}

// Build the good-matching and error (total-only) series for a ratio SLI.
// Returns null with a reason when the legs aren't synthesisable.
function synthesiseSeries(sli) {
  const good = recogniseLeg(sli.good);
  const total = recogniseLeg(sli.total);
  if (!good) return { reason: 'good leg not a single-selector rate shape' };
  if (!total) return { reason: 'total leg not a single-selector rate shape' };
  if (good.metric !== total.metric) return { reason: 'good/total use different metrics' };

  const goodLabels = {};
  for (const m of good.matchers) {
    const v = satisfy(m);
    if (v === null) return { reason: `cannot satisfy matcher ${m.label}${m.op}"${m.value}"` };
    if (goodLabels[m.label] !== undefined && goodLabels[m.label] !== v) return { reason: `conflicting matchers on ${m.label}` };
    goodLabels[m.label] = v;
  }
  // The good series must also satisfy total's matchers.
  for (const m of total.matchers) {
    const have = goodLabels[m.label];
    if (have !== undefined) {
      const ok = m.op === '=' ? have === m.value
        : m.op === '!=' ? have !== m.value
        : (() => { try { const re = new RegExp(`^(?:${m.value})$`); return m.op === '=~' ? re.test(have) : !re.test(have); } catch (_) { return false; } })();
      if (!ok) return { reason: `good series violates total matcher ${m.label}${m.op}"${m.value}"` };
    } else {
      const v = satisfy(m);
      if (v === null) return { reason: `cannot satisfy total matcher ${m.label}${m.op}"${m.value}"` };
      goodLabels[m.label] = v;
    }
  }

  // Error series: satisfies total, violates the good-only discriminator.
  const errorLabels = {};
  for (const m of total.matchers) {
    const v = satisfy(m);
    if (v === null) return { reason: `cannot satisfy total matcher ${m.label}${m.op}"${m.value}"` };
    errorLabels[m.label] = v;
  }
  const discriminators = good.matchers.filter(g =>
    !total.matchers.some(t => t.label === g.label && t.op === g.op && t.value === g.value));
  if (!discriminators.length) return { reason: 'good and total are identical — no error dimension to synthesise' };
  const d = discriminators[0];
  const bad = violate(d);
  if (bad === null) return { reason: `cannot violate discriminator ${d.label}${d.op}"${d.value}"` };
  errorLabels[d.label] = bad;

  return {
    metric: good.metric,
    goodSeries: seriesString(good.metric, goodLabels),
    errorSeries: seriesString(good.metric, errorLabels),
  };
}

// ---------- fixture generation ----------

function durationMinutes(d) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(String(d || '').trim());
  if (!m) return 5;
  const n = Number(m[1]);
  return { ms: n / 60000, s: n / 60, m: n, h: n * 60, d: n * 1440, w: n * 10080 }[m[2]];
}

function yamlQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function expMap(indent, obj) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return `${indent}{}\n`;
  return keys.map(k => `${indent}${k}: ${yamlQuote(obj[k])}`).join('\n') + '\n';
}

// Generate one promtool test file per ratio SLO with burn alerts.
// `compiledYaml` is the per-SLO rules artifact (compileSloPrometheusRules
// output) and `rulesFilename` its on-disk name (same directory).
export function generatePromtoolTest({ canonical, slo, sli, compiledYaml, rulesFilename }) {
  const synth = synthesiseSeries(sli);
  if (synth.reason) return { skipped: synth.reason };

  const doc = parseYaml(String(compiledYaml).replace(/^(\s*#[^\n]*\n)+/, ''));
  const groups = doc?.groups || [];
  const recording = groups.flatMap(g => g.rules || []).filter(r => r.record);
  const alerts = groups.flatMap(g => g.rules || []).filter(r => r.alert);
  if (!alerts.length) return { skipped: 'no burn alerts compiled for this SLO' };
  const ratioRule = recording.find(r => /:ratio_/.test(r.record));
  const errRatioRule = recording.find(r => /:error_ratio_/.test(r.record));

  // Burn thresholds ≥ 1 can never fire on a 0..1 error ratio — skip
  // honestly rather than asserting an impossible firing.
  const maxForMin = Math.max(...alerts.map(a => durationMinutes(a.for)), 5);
  const evalAt = `${Math.ceil(maxForMin + 65)}m`;

  const recordedLabels = (rule) => {
    const base = { __name__: rule.record, ...(rule.labels || {}) };
    return '{' + Object.entries(base).map(([k, v]) => `${k}="${v}"`).join(', ') + '}';
  };

  // 14h of 1m samples: covers a 6h long window + for + margin.
  const STEPS = 840;
  let out = '';
  out += `# Behavioral fixtures for SLO ${slo.id} — generated by tools/lib/promtest-gen.mjs (T3).\n`;
  out += `# Healthy: error rate 0 → no burn alert, ratio exactly 1. Breach: good rate 0 → every alert fires.\n`;
  out += `rule_files:\n  - ${rulesFilename}\n`;
  out += `evaluation_interval: 1m\n`;
  out += `tests:\n`;

  // ---- healthy ----
  out += `  - interval: 1m\n    input_series:\n`;
  out += `      - series: ${yamlQuote(synth.goodSeries)}\n        values: '0+60x${STEPS}'\n`;
  out += `      - series: ${yamlQuote(synth.errorSeries)}\n        values: '0x${STEPS}'\n`;
  if (ratioRule) {
    out += `    promql_expr_test:\n`;
    out += `      - expr: ${yamlQuote(ratioRule.record)}\n        eval_time: 30m\n        exp_samples:\n`;
    out += `          - labels: ${yamlQuote(recordedLabels(ratioRule))}\n            value: 1\n`;
  }
  out += `    alert_rule_test:\n`;
  for (const a of alerts) {
    out += `      - eval_time: ${evalAt}\n        alertname: ${a.alert}\n        exp_alerts: []\n`;
  }

  // ---- breach ----
  out += `  - interval: 1m\n    input_series:\n`;
  out += `      - series: ${yamlQuote(synth.goodSeries)}\n        values: '0x${STEPS}'\n`;
  out += `      - series: ${yamlQuote(synth.errorSeries)}\n        values: '0+60x${STEPS}'\n`;
  if (errRatioRule) {
    out += `    promql_expr_test:\n`;
    out += `      - expr: ${yamlQuote(errRatioRule.record)}\n        eval_time: 30m\n        exp_samples:\n`;
    out += `          - labels: ${yamlQuote(recordedLabels(errRatioRule))}\n            value: 1\n`;
  }
  out += `    alert_rule_test:\n`;
  for (const a of alerts) {
    // Alerts inherit the labels of the series their expr selects. Burn
    // alerts aggregate raw series with sum() (no labels survive), but
    // the forecast alert queries a RECORDING rule whose series carries
    // the labels that rule attached — merge them in (the alert's own
    // labels override, per Prometheus semantics).
    const inherited = {};
    for (const rec of recording) {
      if (rec.record && String(a.expr || '').includes(rec.record)) Object.assign(inherited, rec.labels || {});
    }
    out += `      - eval_time: ${evalAt}\n        alertname: ${a.alert}\n`;
    out += `        exp_alerts:\n          - exp_labels:\n`;
    out += expMap('              ', { alertname: a.alert, ...inherited, ...(a.labels || {}) });
    out += `            exp_annotations:\n`;
    out += expMap('              ', a.annotations || {});
  }

  return { yaml: out, alerts: alerts.map(a => a.alert) };
}
