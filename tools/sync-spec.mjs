#!/usr/bin/env node
/**
 * tools/sync-spec.mjs
 *
 * Refreshes the vendored copy of the ObservabilityPack spec under
 * vendor/observability-pack-spec/. Pulls the four canonical files from
 * MoebiusX/otel-observability-pack@main via `gh api`, rewrites them in place,
 * recomputes sha256 checksums, and updates VERSIONS.json.
 *
 * Usage:
 *   node tools/sync-spec.mjs              # sync to current main HEAD
 *   node tools/sync-spec.mjs --ref <sha>  # sync to a specific ref or sha
 *   node tools/sync-spec.mjs --check      # verify on-disk checksums match VERSIONS.json; exit 1 on drift
 *
 * Exit codes:
 *   0  success / no drift
 *   1  hard failure or drift detected (with --check)
 *
 * Requires: Node 18+, `gh` CLI authenticated.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VENDOR = join(ROOT, 'vendor', 'observability-pack-spec');
const MANIFEST = join(VENDOR, 'VERSIONS.json');
const UPSTREAM_REPO = 'MoebiusX/otel-observability-pack';

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const refIdx = args.indexOf('--ref');
const refOverride = refIdx !== -1 ? args[refIdx + 1] : null;

function gh(...ghArgs) {
  const r = spawnSync('gh', ghArgs, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`gh ${ghArgs.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function relFromVendor(p) {
  return p.replace(VENDOR + '\\', '').replace(VENDOR + '/', '').replaceAll('\\', '/');
}

function loadManifest() {
  if (!existsSync(MANIFEST)) {
    throw new Error(`manifest not found: ${MANIFEST} — run sync without --check first`);
  }
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

function check() {
  const m = loadManifest();
  let drift = 0;
  for (const [vendorRel, meta] of Object.entries(m.files)) {
    const onDisk = join(VENDOR, vendorRel);
    if (!existsSync(onDisk)) {
      process.stderr.write(`✗ ${vendorRel}: file missing\n`);
      drift++;
      continue;
    }
    const buf = readFileSync(onDisk);
    const got = sha256(buf);
    if (got !== meta.sha256) {
      process.stderr.write(`✗ ${vendorRel}: sha256 drift\n    expected ${meta.sha256}\n    got      ${got}\n`);
      drift++;
    } else if (buf.length !== meta.bytes) {
      process.stderr.write(`✗ ${vendorRel}: byte count drift (expected ${meta.bytes}, got ${buf.length})\n`);
      drift++;
    } else {
      process.stdout.write(`✓ ${vendorRel}\n`);
    }
  }
  if (drift) {
    process.stderr.write(`\n${drift} drift finding(s). Re-run \`node tools/sync-spec.mjs\` to refresh.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nclean: ${Object.keys(m.files).length} file(s) match VERSIONS.json (commit ${m.upstream.commit.slice(0, 8)})\n`);
}

function sync() {
  const m = existsSync(MANIFEST) ? loadManifest() : { schema: '1.2', upstream: {}, files: {} };
  const ref = refOverride || 'main';
  const commitSha = gh('api', `repos/${UPSTREAM_REPO}/commits/${ref}`, '--jq', '.sha');
  process.stdout.write(`[sync-spec] upstream ${UPSTREAM_REPO}@${ref} -> ${commitSha.slice(0, 8)}\n`);

  const updated = {};
  for (const [vendorRel, meta] of Object.entries(m.files)) {
    const onDisk = join(VENDOR, vendorRel);
    const url = gh(
      'api',
      `repos/${UPSTREAM_REPO}/contents/${meta.sourcePath}?ref=${commitSha}`,
      '--jq', '.download_url',
    );
    const raw = gh('api', url);
    const buf = Buffer.from(raw, 'utf8');
    mkdirSync(dirname(onDisk), { recursive: true });
    writeFileSync(onDisk, buf);
    const got = sha256(buf);
    updated[vendorRel] = { sourcePath: meta.sourcePath, sha256: got, bytes: buf.length };
    const changed = got !== meta.sha256 ? 'CHANGED' : 'unchanged';
    process.stdout.write(`  ${changed.padEnd(9)} ${vendorRel} (${buf.length} bytes)\n`);
  }

  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next = {
    schema: m.schema,
    upstream: { repo: UPSTREAM_REPO, ref, commit: commitSha },
    fetchedAt,
    files: updated,
  };
  writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + '\n');
  process.stdout.write(`[sync-spec] wrote ${relFromVendor(MANIFEST)} (commit ${commitSha.slice(0, 8)}, ${fetchedAt})\n`);
}

try {
  if (CHECK_ONLY) check();
  else sync();
} catch (e) {
  process.stderr.write(`[sync-spec] FATAL: ${e.message}\n`);
  process.exit(1);
}
