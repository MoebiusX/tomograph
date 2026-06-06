#!/usr/bin/env node
// ============================================================
// tools/crawl-repo.mjs — CLI for Path A of pack creation.
//
// Walks a service repo on disk, builds an in-memory file map,
// feeds it to the shared crawler library, and emits a draft
// canonical pack to stdout. The summary report goes to stderr.
//
// Usage:
//   node tools/crawl-repo.mjs <path> [--name foo] [--env prod] [--criticality tier-2]
// ============================================================

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { crawlToYaml } from './lib/crawler.mjs';

const SCAN_EXT = /\.(ya?ml|json)$/i;
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.cache', '.next', '.terraform']);

async function walk(root) {
  const out = new Map();
  async function visit(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.observability') continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        await visit(abs);
      } else if (ent.isFile() && SCAN_EXT.test(ent.name)) {
        // Cap per-file size at 5 MB so a stray big binary won't OOM us.
        try {
          const st = await stat(abs);
          if (st.size > 5 * 1024 * 1024) continue;
          const rel = relative(root, abs).replace(/\\/g, '/');
          out.set(rel, await readFile(abs, 'utf8'));
        } catch (_) { /* unreadable; skip */ }
      }
    }
  }
  await visit(root);
  return out;
}

function parseArgs(argv) {
  const out = { repoPath: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') && !out.repoPath) { out.repoPath = a; continue; }
    if (a === '--name')        out.repoName = argv[++i];
    else if (a === '--env')         out.environment = argv[++i];
    else if (a === '--criticality') out.criticality = argv[++i];
    else if (a === '--binding')     out.binding = argv[++i];
    else if (a === '--owners')      out.owners = argv[++i].split(',');
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.repoPath) {
    process.stderr.write('usage: crawl-repo.mjs <path> [--name foo] [--env prod] [--criticality tier-2]\n');
    process.exit(2);
  }
  const st = await stat(opts.repoPath).catch(() => null);
  if (!st || !st.isDirectory()) {
    process.stderr.write(`not a directory: ${opts.repoPath}\n`);
    process.exit(2);
  }
  if (!opts.repoName) opts.repoName = basename(opts.repoPath.replace(/[\\/]$/, ''));

  const files = await walk(opts.repoPath);
  const { yaml, summary, evidence } = crawlToYaml(files, opts);

  process.stdout.write(yaml);

  // Summary on stderr — doesn't pollute the YAML when piped.
  process.stderr.write([
    '',
    `# crawler summary`,
    `#   files scanned    : ${summary.files.scanned}`,
    `#   files classified : ${summary.files.classified}`,
    `#   by kind          : ${JSON.stringify(summary.files.byKind)}`,
    `#   backends         : ${summary.discovered.backends}`,
    `#   recording rules  : ${summary.discovered.recordingRules}`,
    `#   burn-rate alerts : ${summary.discovered.burnRateAlerts}`,
    `#   dashboards       : ${summary.discovered.dashboards}`,
    `#   alerting routes  : ${summary.discovered.alertingRoutes}`,
    `#   pipelines        : ${summary.discovered.pipelines}`,
    `#   tier inferred    : ${summary.inferred.tier}`,
    `#   warnings         : ${summary.warnings.length}`,
    ...summary.warnings.map(w => `#     · ${w}`),
    `#   evidence entries : ${Object.keys(evidence).length}`,
    '',
  ].join('\n'));
}

main().catch(e => {
  process.stderr.write(`crawler failed: ${e.stack || e.message}\n`);
  process.exit(1);
});
