// tools/lib/profiles.mjs
//
// PRODUCT + VERSION PROFILES
//
// The compiler used to be version-blind: it hardcoded one shape per target
// (schemaVersion 41, the `logging` exporter, a fixed telemetry block) and
// emitted it no matter what version the pack declared. That makes the output a
// heuristic, not a faithful artefact — a dashboard emitted for "Grafana 13"
// looked identical to one for "Grafana 10", which is wrong.
//
// A profile is the canon for ONE product at ONE version range. It encodes the
// knobs that genuinely differ across versions — the things that change what the
// running system accepts or does — and nothing cosmetic. The compiler resolves
// a profile from the version the pack declares (or an explicit override) and
// shapes every artefact through it.
//
// TRACTABILITY
//   We are honest about how faithfully each family can be modelled in pure JS
//   (this repo's hard constraint: browser-importable, deps = express only):
//
//     'native'   the version-determining shape is small and fully expressible
//                in JS — we implement it faithfully (e.g. Grafana dashboard
//                schemaVersion + datasource shape, OTel exporter renames,
//                Prometheus rule features).
//     'partial'  we model the high-impact knobs but the product's full schema
//                is larger than we encode; unmodelled fields pass through.
//     'vendored-go-needed'  faithful validation requires the product's own Go
//                schema/parser (promtool rulefmt, Grafana's dashboard-schema,
//                the Collector's config unmarshaller). We emit best-effort and
//                flag it; we do NOT claim canonical fidelity.
//
//   `profile.tractability` carries this marker so the UI and docs can show it.
//
// Pure ESM, no Node APIs — the studio imports this in the browser.

// ---------------------------------------------------------------------------
// Minimal semver-range matcher
//
// Enough to drive profile selection without pulling in `semver` (a Node-only
// dependency). Supports a declared version like "12", "12.3", "12.3.1",
// "v2.45.0", "0.96.0" and range predicates ">=", ">", "<=", "<", "=" plus a
// bare "major" shorthand. Ranges are ANDed space-separated terms, e.g.
// ">=12 <13".
// ---------------------------------------------------------------------------

export function parseVersion(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/^v/i, '');
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function satisfiesTerm(ver, term) {
  const t = term.trim();
  if (!t || t === '*') return true;
  const m = t.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!m) return false;
  const op = m[1] || '=';
  const target = parseVersion(m[2]);
  if (!target) return false;
  const c = cmp(ver, target);
  switch (op) {
    case '>=': return c >= 0;
    case '>':  return c > 0;
    case '<=': return c <= 0;
    case '<':  return c < 0;
    case '=':  // bare major/minor "=12" means same major (and minor if given)
      if (/^\d+$/.test(m[2].trim())) return ver[0] === target[0];
      if (/^\d+\.\d+$/.test(m[2].trim())) return ver[0] === target[0] && ver[1] === target[1];
      return c === 0;
    default:   return false;
  }
}

export function satisfies(version, range) {
  const ver = parseVersion(version);
  if (!ver) return false;
  return String(range).split(/\s+/).filter(Boolean).every((term) => satisfiesTerm(ver, term));
}

// ---------------------------------------------------------------------------
// Profile registry
//
// Each product lists version bands newest-first. `resolveProfile` returns the
// first band whose range matches the declared version; if none match (or no
// version is declared) it returns the band flagged `default: true`.
// ---------------------------------------------------------------------------

const REGISTRY = {
  // -------------------------------------------------------------------------
  // Grafana dashboards — the schemaVersion + panel/datasource shape are the
  // real version differentiators. (schemaVersion is Grafana's own dashboard
  // migration counter; it is NOT the product version.)
  // -------------------------------------------------------------------------
  grafana: {
    family: 'grafana-dashboard',
    tractability: 'native',
    bands: [
      {
        id: 'grafana-13', range: '>=13 <14', label: 'Grafana 13.x',
        knobs: {
          schemaVersion: 42,
          datasourceForm: 'object',     // { type, uid } — mandatory since v10
          panelTargetDatasource: true,  // every target carries its datasource
          thresholdsMode: 'absolute',
          legacyAngular: false,
        },
      },
      {
        id: 'grafana-12', range: '>=12 <13', label: 'Grafana 12.x', default: true,
        knobs: {
          schemaVersion: 41,
          datasourceForm: 'object',
          panelTargetDatasource: true,
          thresholdsMode: 'absolute',
          legacyAngular: false,
        },
      },
      {
        id: 'grafana-11', range: '>=11 <12', label: 'Grafana 11.x',
        knobs: {
          schemaVersion: 40,
          datasourceForm: 'object',
          panelTargetDatasource: true,
          thresholdsMode: 'absolute',
          legacyAngular: false,         // angular panels removed in v11
        },
      },
      {
        id: 'grafana-10', range: '>=10 <11', label: 'Grafana 10.x',
        knobs: {
          schemaVersion: 39,
          datasourceForm: 'object',     // object form became mandatory in v10
          panelTargetDatasource: true,
          thresholdsMode: 'absolute',
          legacyAngular: true,
        },
      },
      {
        id: 'grafana-9', range: '>=9 <10', label: 'Grafana 9.x',
        knobs: {
          schemaVersion: 37,
          datasourceForm: 'string',     // pre-v10 accepted the bare uid string
          panelTargetDatasource: false,
          thresholdsMode: 'absolute',
          legacyAngular: true,
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Grafana-managed alerting/recording rules (provisioning YAML). The rule
  // object shape evolved: `record` block for recording rules (Grafana 11+),
  // `keep_firing_for` and `notification_settings` (Grafana 10.4+/11+).
  // -------------------------------------------------------------------------
  'grafana-managed': {
    family: 'grafana-managed-rules',
    tractability: 'partial',
    bands: [
      {
        id: 'gma-12', range: '>=12 <14', label: 'Grafana 12–13 unified alerting', default: true,
        knobs: { apiVersion: 1, recordBlock: true, keepFiringFor: true, notificationSettings: true },
      },
      {
        id: 'gma-11', range: '>=11 <12', label: 'Grafana 11 unified alerting',
        knobs: { apiVersion: 1, recordBlock: true, keepFiringFor: true, notificationSettings: true },
      },
      {
        id: 'gma-10', range: '>=9 <11', label: 'Grafana 9–10 unified alerting',
        knobs: { apiVersion: 1, recordBlock: false, keepFiringFor: false, notificationSettings: false },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Prometheus rules. The rule-group format is stable; the genuine version
  // knob is `keep_firing_for` on alerting rules, added in Prometheus 2.42
  // (Jan 2023). Faithful validation needs promtool (Go) — vendored-go-needed.
  // -------------------------------------------------------------------------
  prometheus: {
    family: 'prometheus-rules',
    tractability: 'vendored-go-needed',
    bands: [
      {
        id: 'prom-3', range: '>=3 <4', label: 'Prometheus 3.x', default: true,
        knobs: { keepFiringFor: true, ruleQueryOffset: true },
      },
      {
        id: 'prom-2.42', range: '>=2.42 <3', label: 'Prometheus 2.42+',
        knobs: { keepFiringFor: true, ruleQueryOffset: false },
      },
      {
        id: 'prom-2', range: '>=2 <2.42', label: 'Prometheus 2.x (<2.42)',
        knobs: { keepFiringFor: false, ruleQueryOffset: false },
      },
    ],
  },

  // VictoriaMetrics vmalert consumes Prometheus rule format but does NOT
  // support `keep_firing_for` — a real, easy-to-get-wrong difference.
  victoriametrics: {
    family: 'prometheus-rules',
    tractability: 'vendored-go-needed',
    bands: [
      {
        id: 'vm', range: '*', label: 'VictoriaMetrics vmalert', default: true,
        knobs: { keepFiringFor: false, ruleQueryOffset: false },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // OTel Collector. Real version knobs: the `logging` exporter was renamed to
  // `debug` in v0.86 (the old name kept working with a warning, removed
  // later); `service.telemetry.metrics.address` was deprecated in favour of
  // `readers`. Full config validation needs the Collector's Go unmarshaller.
  // -------------------------------------------------------------------------
  'otel-collector': {
    family: 'otel-collector',
    tractability: 'partial',
    bands: [
      {
        id: 'otelcol-0.96+', range: '>=0.96', label: 'OTel Collector 0.96+', default: true,
        knobs: { debugExporter: true, telemetryMetricsReaders: true },
      },
      {
        id: 'otelcol-0.86', range: '>=0.86 <0.96', label: 'OTel Collector 0.86–0.95',
        knobs: { debugExporter: true, telemetryMetricsReaders: false },
      },
      {
        id: 'otelcol-pre-0.86', range: '<0.86', label: 'OTel Collector <0.86',
        knobs: { debugExporter: false, telemetryMetricsReaders: false },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Alertmanager. `msteamsv2_configs` was added in v0.28; `msteams_configs`
  // in v0.26. Route/receiver shape is otherwise stable.
  // -------------------------------------------------------------------------
  alertmanager: {
    family: 'alertmanager',
    tractability: 'partial',
    bands: [
      {
        id: 'am-0.28+', range: '>=0.28', label: 'Alertmanager 0.28+', default: true,
        knobs: { msteamsV2: true, msteams: true },
      },
      {
        id: 'am-0.26', range: '>=0.26 <0.28', label: 'Alertmanager 0.26–0.27',
        knobs: { msteamsV2: false, msteams: true },
      },
      {
        id: 'am-pre-0.26', range: '<0.26', label: 'Alertmanager <0.26',
        knobs: { msteamsV2: false, msteams: false },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

// Resolve the profile for a product at a declared version. Returns a frozen
// object { product, family, tractability, version, band, label, knobs,
// matched }. `matched` is false when no band matched the version and we fell
// back to the default band — the caller can surface that as "emitted for
// <default> because the declared version <v> isn't profiled."
export function resolveProfile(product, version) {
  const key = normalizeProduct(product);
  const entry = REGISTRY[key];
  if (!entry) {
    return Object.freeze({
      product: key, family: 'unknown', tractability: 'vendored-go-needed',
      version: version ?? null, band: null, label: `${product} (no profile)`,
      knobs: {}, matched: false,
    });
  }
  let band = null;
  if (version != null && parseVersion(version)) {
    band = entry.bands.find((b) => satisfies(version, b.range)) || null;
  }
  const matched = !!band;
  if (!band) band = entry.bands.find((b) => b.default) || entry.bands[0];
  return Object.freeze({
    product: key,
    family: entry.family,
    tractability: entry.tractability,
    version: version ?? null,
    band: band.id,
    label: band.label,
    knobs: Object.freeze({ ...band.knobs }),
    matched,
  });
}

// Map common product aliases / images to a registry key.
function normalizeProduct(product) {
  const p = String(product || '').toLowerCase();
  if (/grafana-managed|grafana_managed/.test(p)) return 'grafana-managed';
  if (/victoria|vmalert|vm-/.test(p)) return 'victoriametrics';
  if (/otel|opentelemetry|collector/.test(p)) return 'otel-collector';
  if (/alertmanager/.test(p)) return 'alertmanager';
  if (/grafana/.test(p)) return 'grafana';
  if (/prometheus|mimir|thanos/.test(p)) return 'prometheus';
  return p;
}

// Enumerate the registry for UIs/tests: every product and its version bands.
export function listProfiles() {
  return Object.entries(REGISTRY).map(([product, entry]) => ({
    product,
    family: entry.family,
    tractability: entry.tractability,
    bands: entry.bands.map((b) => ({ id: b.id, range: b.range, label: b.label, default: !!b.default })),
  }));
}
