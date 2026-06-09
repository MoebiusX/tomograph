// tools/lib/harness.mjs
//
// Shared assertion harness for the tools/ and server/ test scripts. Each
// suite is a plain Node script: ✓/✗ per assertion on stdout, exit 1 when any
// assertion failed. That contract keeps every suite runnable standalone
// (`node tools/test-x.mjs`) AND discoverable by `node --test`, which treats
// a non-zero child exit as a failing test file.
//
// Named harness.mjs (not test-harness.mjs) on purpose: the runner's
// `test-*` discovery pattern must not match it.

export function createHarness({ indent = '', truncate = 0 } = {}) {
  const failures = [];
  const fmt = (v) => {
    const s = JSON.stringify(v);
    return truncate && typeof s === 'string' && s.length > truncate ? s.slice(0, truncate) : s;
  };
  function assert(cond, label, got, want) {
    if (cond) { process.stdout.write(`${indent}✓ ${label}\n`); return; }
    const detail = got !== undefined ? `\n${indent}    got:  ${fmt(got)}\n${indent}    want: ${fmt(want)}` : '';
    failures.push(`${label}${detail}`);
    process.stdout.write(`${indent}✗ ${label}${detail}\n`);
  }
  function report(what, passMessage) {
    if (failures.length) {
      process.stderr.write(`\n${failures.length} ${what} assertion(s) failed.\n`);
      process.exit(1);
    }
    process.stdout.write(`\n${passMessage || `all ${what} assertions pass.`}\n`);
  }
  return { assert, failures, report };
}
