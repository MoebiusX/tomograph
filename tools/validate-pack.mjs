#!/usr/bin/env node
/**
 * tools/validate-pack.mjs
 *
 * Validate ObservabilityPack manifests against the vendored canonical
 * spec v1.2 schema (vendor/observability-pack-spec/v1.2/...).
 *
 * Studio v0.3 supports the canonical v1.2 manifest shape only:
 *   apiVersion: observability.platform/v1
 *   kind: ObservabilityPack
 *
 * Pre-1.2 packs are rejected up front with a pointer to the spec. The
 * pre-1.2 studio display schema is gone; use the canonical schema for
 * everything.
 *
 * Usage:
 *   node tools/validate-pack.mjs <pack.yaml|pack.json> [...]
 *
 * Exit codes:
 *   0  all valid
 *   1  one or more invalid (errors to stderr)
 *   2  invocation error
 *
 * Zero npm deps. YAML parsing handled by tools/lib/mini-yaml.mjs.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(
  __dirname, '..',
  'vendor', 'observability-pack-spec', 'v1.2',
  'observability-pack.schema.json',
);
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

const REQUIRED_API_VERSION = 'observability.platform/v1';
const REQUIRED_KIND = 'ObservabilityPack';
const SPEC_VERSION = '1.2';

// ---------- pack loader ----------

function loadPack(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const text = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return JSON.parse(text);
  if (ext === '.yaml' || ext === '.yml') return parseYaml(text);
  // unknown extension: assume YAML (the canonical format), fall back to JSON
  try { return parseYaml(text); }
  catch (_) { return JSON.parse(text); }
}

// ---------- JSON Schema 2020-12 walker (subset) ----------
//
// Implements the keywords used by the canonical schema:
//   type, enum, const, pattern, minLength, maxLength,
//   minimum, maximum, exclusiveMinimum, exclusiveMaximum,
//   minItems, maxItems, contains, items,
//   required, properties, patternProperties, additionalProperties,
//   propertyNames, minProperties, maxProperties,
//   allOf, oneOf, anyOf, not, if/then/else,
//   $ref (local $defs only), format (uri | date-time).

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchType(expected, actual, value) {
  if (expected === actual) return true;
  if (expected === 'integer' && actual === 'number' && Number.isInteger(value)) return true;
  if (expected === 'number' && actual === 'number') return true;
  return false;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/$defs/')) throw new Error(`unsupported $ref: ${ref}`);
  const name = ref.slice('#/$defs/'.length);
  const target = root.$defs?.[name];
  if (!target) throw new Error(`unresolved $ref: ${ref}`);
  return target;
}

// RFC 3986 (loose) — `scheme://authority/path...`
const URI_RE = /^[a-z][a-z0-9+.-]*:\S+$/i;
// ISO 8601, e.g. 2026-06-05T20:23:01Z or with offset and fractional seconds
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function validate(value, schema, path, errors, root) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) schema = resolveRef(schema.$ref, root);

  // type
  if (schema.type !== undefined) {
    const t = typeOf(value);
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(e => matchType(e, t, value))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${t}`);
      return; // skip remaining rules — they'd just compound on a type mismatch
    }
  }

  // const / enum
  if ('const' in schema && !deepEqual(value, schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum && !schema.enum.some(e => deepEqual(e, value))) {
    errors.push(`${path}: not in enum ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }

  // strings
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern /${schema.pattern}/`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.format === 'uri' && !URI_RE.test(value)) {
      errors.push(`${path}: not a valid uri`);
    }
    if (schema.format === 'date-time' && !DATE_TIME_RE.test(value)) {
      errors.push(`${path}: not a valid date-time`);
    }
  }

  // numbers
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push(`${path}: ${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
    }
  }

  // arrays
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: ${value.length} items < minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: ${value.length} items > maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`, errors, root));
    }
    if (schema.contains) {
      const ok = value.some((v, i) => {
        const sub = [];
        validate(v, schema.contains, `${path}[${i}]`, sub, root);
        return sub.length === 0;
      });
      if (!ok) errors.push(`${path}: contains schema not satisfied by any item`);
    }
  }

  // objects
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.required) {
      for (const k of schema.required) {
        if (!(k in value)) errors.push(`${path}: missing required key '${k}'`);
      }
    }
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      errors.push(`${path}: ${keys.length} props < minProperties ${schema.minProperties}`);
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      errors.push(`${path}: ${keys.length} props > maxProperties ${schema.maxProperties}`);
    }
    if (schema.propertyNames) {
      for (const k of keys) {
        validate(k, schema.propertyNames, `${path}.(propertyName ${JSON.stringify(k)})`, errors, root);
      }
    }
    const props = schema.properties || {};
    const patternProps = schema.patternProperties;
    const addProps = schema.additionalProperties;
    for (const k of keys) {
      let matched = false;
      const childPath = `${path}.${k}`;
      if (props[k]) {
        validate(value[k], props[k], childPath, errors, root);
        matched = true;
      }
      if (patternProps) {
        for (const [pat, sub] of Object.entries(patternProps)) {
          if (new RegExp(pat).test(k)) {
            validate(value[k], sub, childPath, errors, root);
            matched = true;
          }
        }
      }
      if (!matched) {
        if (addProps === false) {
          errors.push(`${path}: unknown property '${k}'`);
        } else if (addProps && typeof addProps === 'object') {
          validate(value[k], addProps, childPath, errors, root);
        }
      }
    }
  }

  // composition
  if (schema.allOf) {
    for (const sub of schema.allOf) validate(value, sub, path, errors, root);
  }
  if (schema.oneOf) {
    let passes = 0;
    for (const sub of schema.oneOf) {
      const se = [];
      validate(value, sub, path, se, root);
      if (se.length === 0) passes++;
    }
    if (passes === 0) errors.push(`${path}: matches none of oneOf branches`);
    else if (passes > 1) errors.push(`${path}: matches ${passes} oneOf branches (expected 1)`);
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some(sub => {
      const se = [];
      validate(value, sub, path, se, root);
      return se.length === 0;
    });
    if (!ok) errors.push(`${path}: matches none of anyOf branches`);
  }
  if (schema.not) {
    const se = [];
    validate(value, schema.not, path, se, root);
    if (se.length === 0) errors.push(`${path}: matches forbidden 'not' schema`);
  }
  if (schema.if) {
    const se = [];
    validate(value, schema.if, path, se, root);
    if (se.length === 0 && schema.then) validate(value, schema.then, path, errors, root);
    else if (se.length > 0 && schema.else) validate(value, schema.else, path, errors, root);
  }
}

// ---------- driver ----------

function validateOne(path) {
  const out = { path, errors: [] };
  let pack;
  try { pack = loadPack(path); }
  catch (e) { out.errors.push(e.message); return out; }

  // Gatekeeper: only canonical v1.2 manifests pass.
  if (pack?.apiVersion !== REQUIRED_API_VERSION || pack?.kind !== REQUIRED_KIND) {
    out.errors.push(
      `not a canonical ObservabilityPack v${SPEC_VERSION} manifest. ` +
      `Expected apiVersion: ${REQUIRED_API_VERSION}, kind: ${REQUIRED_KIND}. ` +
      `Got apiVersion: ${JSON.stringify(pack?.apiVersion)}, kind: ${JSON.stringify(pack?.kind)}. ` +
      `See vendor/observability-pack-spec/v${SPEC_VERSION}/spec.md for the canonical shape.`
    );
    return out;
  }

  validate(pack, SCHEMA, '$', out.errors, SCHEMA);
  return out;
}

const files = process.argv.slice(2);
if (!files.length) {
  process.stderr.write('Usage: node tools/validate-pack.mjs <pack.yaml|pack.json> [...]\n');
  process.exit(2);
}

let bad = 0;
for (const f of files) {
  const { path, errors } = validateOne(f);
  if (errors.length) {
    bad++;
    process.stderr.write(`✗ ${path}\n`);
    errors.forEach(e => process.stderr.write(`    ${e}\n`));
  } else {
    process.stdout.write(`✓ ${path}  [spec v${SPEC_VERSION}]\n`);
  }
}
process.exit(bad ? 1 : 0);
