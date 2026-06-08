#!/usr/bin/env node
/**
 * tools/test-packs.mjs
 *
 * Round-trip + conformance suite for every archived canonical pack
 * (examples/*.pack.yaml). For each pack:
 *   1. Parse the YAML.
 *   2. Validate against the vendored v1.2 schema.
 *   3. Adapt via the layered adapter.
 *   4. Compute conformance scoring.
 *   5. Assert per-pack expected ranges (where declared).
 *
 * Pack-specific expectations live in PACK_EXPECTATIONS below. Packs not
 * listed there only need to pass schema validation and adapt without
 * throwing — useful for the cron-managed production-live snapshot whose
 * exact conformance varies with the MCP it was fetched from.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import { evaluateConformance } from './lib/conformance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PACKS_DIR = resolve(ROOT, 'examples');
// Catalogue reference packs were moved out of examples/ into reference-packs/
// (surfaced via the studio's Advanced → References view). Validate both
// directories so the shipped reference packs stay schema-conformant.
const REFERENCE_DIR = resolve(ROOT, 'reference-packs');
const SCHEMA = JSON.parse(readFileSync(
  resolve(ROOT, 'vendor', 'observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json'),
  'utf8'
));

// Hand-curated assertion bands for the bundled packs we ship.
const PACK_EXPECTATIONS = {
  'demo-skeleton.pack.yaml': {
    tier: 'tier-3',
    conformant: true,
    mustMin: 100,
    description: 'Smallest valid pack — all tier-3 MUSTs must pass.',
  },
  'production-curated.pack.yaml': {
    tier: 'tier-2',
    conformant: false,
    mustMin: 70,
    mustMax: 95,
    description: 'Partial BAU baseline — must pass most but not all tier-2 MUSTs.',
  },
  'target-advanced.pack.yaml': {
    tier: 'tier-1',
    conformant: true,
    mustMin: 100,
    shouldMin: 80,
    description: 'Aspirational tier-1 reference — 100% MUST conformance.',
  },
};

const failures = [];
function assert(cond, label, got, want) {
  if (cond) { process.stdout.write(`  ✓ ${label}\n`); return; }
  const detail = got !== undefined ? `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}` : '';
  failures.push(`${label}${detail}`);
  process.stdout.write(`  ✗ ${label}${detail}\n`);
}

if (!existsSync(PACKS_DIR)) {
  process.stderr.write(`examples directory missing: ${PACKS_DIR}\n`);
  process.exit(1);
}

const collectPacks = (dir) => (existsSync(dir) ? readdirSync(dir) : [])
  .filter(f => f.endsWith('.pack.yaml') || f.endsWith('.pack.yml'))
  .sort()
  .map(file => ({ dir, file }));

const packFiles = [...collectPacks(PACKS_DIR), ...collectPacks(REFERENCE_DIR)];

if (!packFiles.length) {
  process.stderr.write('no examples/*.pack.yaml or reference-packs/*.pack.yaml files found\n');
  process.exit(1);
}

process.stdout.write(`Found ${packFiles.length} pack(s):\n`);

for (const { dir, file } of packFiles) {
  process.stdout.write(`\n[${file}]\n`);
  const path = join(dir, file);
  let canonical;
  try {
    canonical = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    failures.push(`${file}: YAML parse failed: ${e.message}`);
    process.stdout.write(`  ✗ YAML parse failed: ${e.message}\n`);
    continue;
  }

  // schema
  const errs = validateCanonical(canonical, SCHEMA);
  assert(errs.length === 0, 'schema validates', errs, []);
  if (errs.length) continue;

  // adapter
  let layered;
  try {
    layered = adapt(canonical);
  } catch (e) {
    failures.push(`${file}: adapter threw: ${e.message}`);
    process.stdout.write(`  ✗ adapter threw: ${e.message}\n`);
    continue;
  }
  assert(!!layered.layers?.L1, 'adapter produced L1');
  assert(!!layered.layers?.L2, 'adapter produced L2');

  // conformance
  const report = evaluateConformance(canonical);
  process.stdout.write(`  tier=${report.declaredTier} · ` +
    `must=${report.must.passed}/${report.must.total} (${report.mustPercent}%) · ` +
    `should=${report.should.passed}/${report.should.total} · ` +
    `combined=${report.scorePercent}%\n`);

  const exp = PACK_EXPECTATIONS[file];
  if (!exp) {
    process.stdout.write(`  · no pack-specific expectations declared\n`);
    continue;
  }

  if (exp.tier)         assert(report.declaredTier === exp.tier, `tier = ${exp.tier}`, report.declaredTier, exp.tier);
  if ('conformant' in exp) assert(report.conformant === exp.conformant, `conformant = ${exp.conformant}`, report.conformant, exp.conformant);
  if (exp.mustMin != null) assert(report.mustPercent >= exp.mustMin, `MUST% >= ${exp.mustMin}`, report.mustPercent, `>= ${exp.mustMin}`);
  if (exp.mustMax != null) assert(report.mustPercent <= exp.mustMax, `MUST% <= ${exp.mustMax}`, report.mustPercent, `<= ${exp.mustMax}`);
  if (exp.shouldMin != null) assert(
    report.should.total === 0 || (report.should.passed / report.should.total) * 100 >= exp.shouldMin,
    `SHOULD% >= ${exp.shouldMin}`,
    report.should.total === 0 ? 'no SHOULDs' : Math.round((report.should.passed / report.should.total) * 100),
    `>= ${exp.shouldMin}`,
  );
}

if (failures.length) {
  process.stderr.write(`\n${failures.length} pack assertion(s) failed.\n`);
  process.exit(1);
}
process.stdout.write(`\nall ${packFiles.length} pack(s) pass.\n`);
