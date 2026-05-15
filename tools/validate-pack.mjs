#!/usr/bin/env node
/**
 * tools/validate-pack.mjs
 *
 * Validate one or more pack JSON files against schema/pack.schema.json.
 *
 * Usage:
 *   node tools/validate-pack.mjs packs/*.json
 *
 * Exit codes:
 *   0  all valid
 *   1  one or more invalid (errors printed to stderr)
 *
 * Implements a minimal subset of JSON Schema sufficient for the pack
 * shape — keeps the repo dependency-free.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'schema', 'pack.schema.json'), 'utf8')
);

// ----- tiny schema-walker (subset: type, required, properties, items, enum, pattern, additionalProperties, $defs, $ref) -----

function check(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) {
    const ref = schema.$ref.replace('#/$defs/', '');
    schema = SCHEMA.$defs?.[ref];
    if (!schema) return errors.push(`${path}: unresolved $ref to ${ref}`);
  }
  if (schema.type) {
    const t = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    // JSON Schema: integer is a subset of number, but the JSON wire type is just 'number'.
    // Accept a JS number for both 'number' and 'integer' (we check integrality separately).
    const matches = expected.some(e => {
      if (e === t) return true;
      if (e === 'integer' && t === 'number' && Number.isInteger(value)) return true;
      if (e === 'number'  && t === 'number') return true;
      return false;
    });
    if (!matches) {
      errors.push(`${path}: expected ${expected.join('|')}, got ${t}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: not in enum ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: does not match pattern /${schema.pattern}/`);
  }
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength ${schema.minLength}`);
  }
  if (schema.required && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const k of schema.required) {
      if (!(k in value)) errors.push(`${path}: missing required key '${k}'`);
    }
  }
  if (schema.properties && typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties[k]) {
        check(v, schema.properties[k], `${path}.${k}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unknown property '${k}'`);
      }
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((v, i) => check(v, schema.items, `${path}[${i}]`, errors));
  }
}

function validateOne(path) {
  if (!existsSync(path)) return { path, errors: [`file not found: ${path}`] };
  let json;
  try { json = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { return { path, errors: [`invalid JSON: ${e.message}`] }; }
  const errors = [];
  check(json, SCHEMA, '$', errors);
  return { path, errors };
}

const files = process.argv.slice(2);
if (!files.length) {
  process.stderr.write('Usage: node tools/validate-pack.mjs <pack1.json> [pack2.json …]\n');
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
    process.stdout.write(`✓ ${path}\n`);
  }
}
process.exit(bad ? 1 : 0);
