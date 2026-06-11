#!/usr/bin/env node
/**
 * tools/test-backend-validate.mjs
 *
 * T1 of docs/TEST_PLAN_COMPILER_VALIDITY.md — every artifact the
 * compiler emits is validated by ITS OWN BACKEND'S validator, not by
 * shape assertions:
 *
 *   rules / prometheus      → promtool check rules
 *   alertmanager            → amtool check-config
 *   pipelines               → otelcol-contrib validate --config
 *
 * (rules/grafana-managed and dashboards need a live Grafana — T2,
 * separate suite. mimirtool and dashboard-linter arrive with P3.)
 *
 * Validators come from .tools/bin (run `npm run fetch-validators`),
 * with PATH as a fallback. A missing validator SKIPS its checks with
 * one loud line per tool — except under --strict (CI), where missing
 * tooling is a failure. Compiled artifacts are written to
 * .tools/tmp/backend-validate/ and kept after the run for debugging.
 *
 * Fixture matrix: the canonical spec example, every examples/*.pack.yaml,
 * adversarial micro-packs under tools/fixtures/compile/, plus an
 * in-memory 60-SLO scale pack. Rule: any pack the studio can load is a
 * pack the compiler must emit valid artifacts for.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { compileCatalog, compileArtifact } from './lib/compile.mjs';
import { createHarness } from './lib/harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BIN_DIR = join(ROOT, '.tools', 'bin');
const OUT_DIR = join(ROOT, '.tools', 'tmp', 'backend-validate');
const EXE = process.platform === 'win32' ? '.exe' : '';
const STRICT = process.argv.includes('--strict');

const { assert, failures, report } = createHarness({ indent: '  ', truncate: 400 });

// ---------- locate validators ----------

function resolveBin(name) {
  const pinned = join(BIN_DIR, name + EXE);
  if (existsSync(pinned)) return pinned;
  // PATH fallback — useful when a dev already has the tool installed.
  const probe = spawnSync(name, ['--version'], { encoding: 'utf8' });
  if (!probe.error) return name;
  return null;
}

const VALIDATORS = {
  promtool: resolveBin('promtool'),
  amtool: resolveBin('amtool'),
  'otelcol-contrib': resolveBin('otelcol-contrib'),
};

for (const [name, path] of Object.entries(VALIDATORS)) {
  if (path) {
    let v = '';
    try { v = execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n')[0]; }
    catch (e) { v = (e.stdout || e.stderr || '').split('\n')[0]; } // amtool prints version to stderr
    process.stdout.write(`validator: ${name} → ${path} (${String(v).trim()})\n`);
  } else if (STRICT) {
    assert(false, `${name} available (--strict requires every validator; run npm run fetch-validators)`);
  } else {
    process.stdout.write(`validator: ${name} → SKIPPED (missing — run \`npm run fetch-validators\`; checks depending on it will not run)\n`);
  }
}

// ---------- fixture matrix ----------

const fixtureFiles = [
  { id: 'payment-service', path: 'vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml' },
  ...readdirSync(join(ROOT, 'examples')).filter(f => f.endsWith('.pack.yaml'))
    .map(f => ({ id: f.replace(/\.pack\.yaml$/, ''), path: `examples/${f}` })),
  ...(existsSync(join(ROOT, 'tools', 'fixtures', 'compile'))
    ? readdirSync(join(ROOT, 'tools', 'fixtures', 'compile')).filter(f => f.endsWith('.pack.yaml'))
      .map(f => ({ id: `edge:${f.replace(/\.pack\.yaml$/, '')}`, path: `tools/fixtures/compile/${f}` }))
    : []),
];

// In-memory scale pack: 60 SLOs cloned from the skeleton — exercises
// large rule files and many per-SLO items without a bulky fixture file.
function makeScalePack() {
  const base = parseYaml(readFileSync(join(ROOT, 'examples', 'demo-skeleton.pack.yaml'), 'utf8'));
  const pack = JSON.parse(JSON.stringify(base));
  pack.metadata.name = 'edge-scale-60';
  pack.metadata.bindings.service = 'edge-scale-60';
  const sli = pack.spec.slis[0];
  const slo = pack.spec.slos[0];
  pack.spec.slis = [];
  pack.spec.slos = [];
  for (let i = 0; i < 60; i++) {
    pack.spec.slis.push({ ...sli, id: `${sli.id}_${i}` });
    pack.spec.slos.push({ ...slo, id: `${slo.id}_${i}`, sli: `${sli.id}_${i}` });
  }
  // The skeleton's declared recording rule refs the original SLI id,
  // which no longer exists after the clone — repoint it at clone #0 so
  // the ref resolves (a dangling ref is a fixture bug, not a finding).
  for (const rr of pack.spec.queries?.recording_rules || []) {
    rr.expr = String(rr.expr).replace(`ref:slis.${sli.id}`, `ref:slis.${sli.id}_0`);
  }
  return pack;
}

// ---------- runners ----------

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

let written = 0;
function emit(packId, art) {
  const dir = join(OUT_DIR, packId.replace(/[^a-z0-9_.-]/gi, '_'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, art.filename);
  writeFileSync(file, art.content);
  written++;
  return file;
}

function run(bin, args, { configFile } = {}) {
  // Packs legitimately declare deploy-time `${VAR}` / `${env:VAR}`
  // substitutions (the collector's confmap expands them at load). An
  // unset var expands to an empty value and fails validation for the
  // wrong reason — supply a dummy value per placeholder so we validate
  // STRUCTURE while keeping the emission faithful to the pack.
  const env = { ...process.env };
  if (configFile) {
    const text = readFileSync(configFile, 'utf8');
    for (const m of text.matchAll(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      if (env[m[1]] === undefined) env[m[1]] = 'validation-placeholder';
    }
  }
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000, env });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, out, status: r.status };
}

function validatePack(fixture, canonical) {
  process.stdout.write(`\n[${fixture.id}]${fixture.path ? ` ${fixture.path}` : ' (generated in-memory)'}\n`);
  let catalog;
  try { catalog = compileCatalog(canonical); }
  catch (e) {
    assert(false, `compileCatalog does not throw`, e.message);
    return;
  }

  for (const group of catalog.groups || []) {
    // ---- rules / prometheus → promtool check rules (every item) ----
    if (group.id === 'rules' && group.flavors.some(f => f.id === 'prometheus')) {
      for (const item of group.items) {
        const art = compileArtifact(canonical, { group: 'rules', flavor: 'prometheus', artifact: item.id });
        const file = emit(fixture.id, art);
        if (!VALIDATORS.promtool) continue;
        const r = run(VALIDATORS.promtool, ['check', 'rules', file]);
        assert(r.ok, `promtool check rules · ${item.id} (${art.filename})`, r.out, 'exit 0');
      }
    }
    // ---- alertmanager → amtool check-config ----
    if (group.id === 'alertmanager') {
      const art = compileArtifact(canonical, { group: 'alertmanager', flavor: 'alertmanager-yaml', artifact: 'all' });
      const file = emit(fixture.id, art);
      if (VALIDATORS.amtool) {
        const r = run(VALIDATORS.amtool, ['check-config', file]);
        assert(r.ok, `amtool check-config (${art.filename})`, r.out, 'exit 0');
      }
    }
    // ---- pipelines → otelcol-contrib validate ----
    if (group.id === 'pipelines') {
      const art = compileArtifact(canonical, { group: 'pipelines', flavor: 'collector-yaml', artifact: 'all' });
      const file = emit(fixture.id, art);
      if (VALIDATORS['otelcol-contrib']) {
        const r = run(VALIDATORS['otelcol-contrib'], ['validate', `--config=${file}`], { configFile: file });
        assert(r.ok, `otelcol-contrib validate (${art.filename})`, r.out, 'exit 0');
      }
    }
  }
}

// ---------- main ----------

for (const fixture of fixtureFiles) {
  let canonical;
  try { canonical = parseYaml(readFileSync(join(ROOT, fixture.path), 'utf8')); }
  catch (e) {
    assert(false, `${fixture.id}: fixture parses`, e.message);
    continue;
  }
  try { validatePack(fixture, canonical); }
  catch (e) {
    failures.push(`${fixture.id}: threw ${e.message}`);
    process.stdout.write(`  ✗ ${fixture.id}: threw ${e.message}\n`);
  }
}
try { validatePack({ id: 'edge:scale-60' }, makeScalePack()); }
catch (e) {
  failures.push(`edge:scale-60: threw ${e.message}`);
  process.stdout.write(`  ✗ edge:scale-60: threw ${e.message}\n`);
}

process.stdout.write(`\n${written} artifact(s) emitted under ${OUT_DIR} (kept for debugging)\n`);
report('backend-validate');
