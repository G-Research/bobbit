// Exits 0 if the reconciliation fix is present, 1 if not.
// Used by both reproducing-test (expect: failure on unfixed code)
// and implementation (expect: success on fixed code) gates.
const fs = require('fs');
const src = fs.readFileSync('src/ui/tools/renderers/GateVerificationLive.ts', 'utf8');
if (src.includes('_fetchAndReconcile') && src.includes('gateway.token')) {
  console.log('PASS: reconciliation fix with auth headers is present');
  process.exit(0);
} else {
  console.log('FAIL: reconciliation fix is missing');
  process.exit(1);
}
