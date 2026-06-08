#!/usr/bin/env node
//
// tools/cli.mjs — the `packc` / `tomograph` entry point.
//
// A thin dispatcher: it reads the first positional argument as a command
// and either forwards to one of the existing single-purpose tools (so their
// behaviour stays identical whether run directly or via `packc`) or, for
// `compile`, calls tools/lib/compile.mjs programmatically.
//
//   packc validate <file...>          → tools/validate-pack.mjs
//   packc adapt    <file> [env]       → tools/adapt-spec-pack.mjs
//   packc x-ray    <repo-dir>         → tools/crawl-repo.mjs
//   packc compile  <file> [target]    → tools/lib/compile.mjs (programmatic)
//   packc serve                       → server/index.mjs (boots the studio)
//   tomograph                         → same as `serve`
//
// Both bin names point here. With no command, the `tomograph` bin boots the
// studio; everything else prints help. `serve` works under either name, so
// behaviour is identical across platforms even where the invoked bin name
// isn't recoverable (e.g. npm's Windows .cmd shims).

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const [, , command, ...rest] = process.argv;

// Run a project script in a child process, forwarding args + stdio and
// propagating its exit code. Keeps each tool's argv contract untouched.
function delegate(relPath, args) {
  const child = spawn(process.execPath, [resolve(ROOT, relPath), ...args], {
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error(`packc: failed to run ${relPath}: ${err.message}`);
    process.exit(1);
  });
}

async function runCompile(args) {
  const [file, target] = args;
  if (!file) {
    console.error('usage: packc compile <file> [target]');
    process.exit(2);
  }
  const { compile, listTargets } = await import('../tools/lib/compile.mjs');
  const text = readFileSync(resolve(process.cwd(), file), 'utf8');
  let canonical;
  if (file.endsWith('.json')) {
    canonical = JSON.parse(text);
  } else {
    const { parse: parseYaml } = await import('../tools/lib/mini-yaml.mjs');
    canonical = parseYaml(text);
  }

  if (!target) {
    console.error('No target given. Available compile targets:\n');
    for (const t of listTargets()) {
      console.error(`  ${t.id.padEnd(22)} ${t.label}`);
    }
    process.exit(2);
  }

  const out = compile(canonical, target);
  // The artefact text goes to stdout (pipe-friendly); the provenance line
  // goes to stderr so redirecting stdout yields a clean artefact file.
  const p = out.profile || {};
  console.error(
    `# ${out.filename}  (${out.contentType})  ` +
    `profile=${p.product || '?'}@${p.version || '?'}${p.matched === false ? ' [extrapolated]' : ''}`,
  );
  process.stdout.write(out.content);
  if (!out.content.endsWith('\n')) process.stdout.write('\n');
}

function printHelp() {
  console.log(`Tomograph — the Observability Compiler

Usage:
  packc validate <file...>        Validate pack(s) against spec v1.2
  packc adapt    <file> [env]     Adapt a pack into the layered projection
  packc x-ray    <repo-dir>       Crawl a repo into a draft pack
  packc compile  <file> [target]  Compile a pack into a backend artefact
  packc serve                     Boot the studio (Express server)
  tomograph                       Same as \`packc serve\`

Run a command with no/invalid args to see its own usage.`);
}

switch (command) {
  case 'validate':
    delegate('tools/validate-pack.mjs', rest);
    break;
  case 'adapt':
    delegate('tools/adapt-spec-pack.mjs', rest);
    break;
  case 'x-ray':
  case 'xray':
  case 'crawl':
    delegate('tools/crawl-repo.mjs', rest);
    break;
  case 'compile':
    await runCompile(rest);
    break;
  case 'serve':
  case 'studio':
    delegate('server/index.mjs', rest);
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  case '--version':
  case '-v': {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    console.log(pkg.version);
    break;
  }
  case undefined:
    // No subcommand: the `tomograph` bin boots the studio; `packc` shows help.
    if (basename(process.argv[1] || '').startsWith('tomograph')) {
      delegate('server/index.mjs', rest);
    } else {
      printHelp();
    }
    break;
  default:
    console.error(`packc: unknown command "${command}"\n`);
    printHelp();
    process.exit(2);
}
