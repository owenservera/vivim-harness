import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTapSummary, verifyCliArgs } from '../../scripts/local-verify.mjs';

test('local verification parses complete Node TAP counters without guessing from exit code', () => {
  const report = [
    'TAP version 13', '# Subtest: smoke', 'ok 1 - smoke',
    '1..3', '# tests 3', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 1', '# todo 0',
  ].join('\n');
  assert.deepEqual(parseTapSummary(report), {
    tests: 3, pass: 2, fail: 0, cancelled: 0, skipped: 1, todo: 0, complete: true,
  });
  assert.deepEqual(parseTapSummary('non-TAP stdout'), { complete: false });
  assert.deepEqual(parseTapSummary('# tests 3\n# pass 2\n# fail 1'), {
    tests: 3, pass: 2, fail: 1, complete: false,
  });
});

test('local verifier uses an explicit receipt destination and refuses unknown arguments', () => {
  assert.deepEqual(verifyCliArgs([]), { fast: false, receipt: null });
  assert.equal(verifyCliArgs(['--fast']).fast, true);
  assert.ok(verifyCliArgs(['--receipt', 'receipts/check.json']).receipt.endsWith('check.json'));
  assert.throws(() => verifyCliArgs(['--unknown']), /Usage/);
  assert.throws(() => verifyCliArgs(['--receipt']), /Usage/);
});
