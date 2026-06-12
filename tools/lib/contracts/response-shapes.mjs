// tools/lib/contracts/response-shapes.mjs
//
// TOLERANT response-shape contracts for MCP capability payloads.
//
// Each shape declares the MINIMUM a response must carry for the probe's
// adapt() to produce something usable — the critical fields only. Extra
// fields, unknown keys, vendor additions: all ignored by design. The gate
// exists to catch REMOVALS and RENAMES of fields we depend on, not to pin
// vendors' full payloads — additive upstream changes must never break a
// fetch (docs/ARCHITECTURE_EVOLUTION.md §3.2).
//
// A shape row:
//   lists        candidate paths (dot-separated; '' = the response itself)
//                where the payload array may live, tried in order
//   objectKeysAt paths where a plain OBJECT also counts as a payload
//                (its keys are the values — e.g. metrics_metadata's data map)
//   itemAnyOf    for object items: groups of field paths; every group must
//                have at least ONE field present on each item. String items
//                pass automatically (adapters filter non-strings leniently).
//
// An EMPTY payload array is a PASS: "the backend says zero" is a legitimate,
// meaningful response (the fetcher's outcome:'empty' case) — shape checking
// guards structure, not population.
//
// Pure ESM, browser-safe: data tables + a small structural checker.

export const RESPONSE_SHAPES = Object.freeze({
  // Prometheus/VMAlert rule listings — recording_rules and alert_rules both
  // consume this. Rules may be nested in groups or flat.
  'rule-groups': {
    lists: ['groups', 'data.groups', 'rules'],
    nestedRules: true, // items in groups[] carry their own rules[] arrays
    itemAnyOf: [
      ['record', 'name', 'alert'],   // rule identity
      ['expr', 'query'],             // rule body
    ],
  },
  // Grafana dashboard search results (otel-mcp-server + community shapes).
  'dashboard-search': {
    lists: ['results', 'dashboards', 'items', ''],
    itemAnyOf: [
      ['uid', 'id'],                 // addressable identity
    ],
  },
  // Prometheus scrape targets (otel-mcp-server flat shape + /api/v1/targets).
  'scrape-targets': {
    lists: ['targets', 'activeTargets', 'data.activeTargets', ''],
    itemAnyOf: [
      ['job', 'labels.job'],         // the job identity the crawler keys on
    ],
  },
  // Metric-name enumerations (label values / inventories / metadata maps).
  'name-values': {
    lists: ['values', 'data', 'metrics', 'names', ''],
    objectKeysAt: ['data'],
    itemAnyOf: [],                   // items are strings
  },
});

const get = (obj, path) => path === ''
  ? obj
  : path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Validate a response against a shape. Returns { ok, reason, items } —
// `items` is the located payload length (0 is a legitimate pass).
export function validateResponseShape(shapeId, response) {
  const shape = RESPONSE_SHAPES[shapeId];
  if (!shape) throw new Error(`unknown response shape: ${shapeId}. Known: ${Object.keys(RESPONSE_SHAPES).join(', ')}`);
  if (response == null || typeof response !== 'object') {
    return { ok: false, reason: 'response is not an object', items: 0 };
  }

  // Locate the payload: first declared path that yields an array (or, for
  // objectKeysAt paths, a plain object whose keys are the values).
  let payload = null;
  for (const path of shape.lists) {
    const v = get(response, path);
    if (Array.isArray(v)) { payload = v; break; }
    if (v && typeof v === 'object' && (shape.objectKeysAt || []).includes(path)) {
      payload = Object.keys(v); break;
    }
  }
  if (payload === null) {
    return { ok: false, reason: `no payload array at any of: ${shape.lists.map(p => p || '<root>').join(', ')}`, items: 0 };
  }

  // Flatten group nesting when the shape declares it (rules inside groups).
  const items = shape.nestedRules
    ? payload.flatMap(g => Array.isArray(g?.rules) ? g.rules : [g])
    : payload;

  // Critical-field check on object items only; string items pass (adapters
  // filter non-strings leniently). Extras are never inspected.
  for (const [i, item] of items.entries()) {
    if (item == null || typeof item !== 'object') continue;
    for (const group of shape.itemAnyOf) {
      if (!group.some(f => get(item, f) !== undefined)) {
        return { ok: false, reason: `item ${i} missing all of: ${group.join(' | ')}`, items: items.length };
      }
    }
  }
  return { ok: true, reason: null, items: items.length };
}
