// Verify the gate verification reconciliation fix is present
const fs = require('fs');
const src = fs.readFileSync('src/ui/tools/renderers/GateVerificationLive.ts', 'utf8');
if (!src.includes('_fetchAndReconcile')) {
  console.log('BUG: no reconciliation method found');
  process.exit(1);
}
if (!src.includes('gateway.token')) {
  console.log('BUG: no auth header in fetch calls');
  process.exit(1);
}
console.log('FIX PRESENT: _fetchAndReconcile with auth headers');
