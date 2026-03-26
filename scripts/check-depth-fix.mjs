// Verifies magnifier-depth-busy keyframes have the correct z-index transitions
import { readFileSync } from 'fs';
const css = readFileSync('src/ui/app.css', 'utf8');
const m = css.match(/@keyframes magnifier-depth-busy \{[\s\S]*?\n\}/);
if (!m) { console.log('FAIL: keyframes not found'); process.exit(1); }
const block = m[0];
const has54 = /54%\s*\{[^}]*z-index:\s*1/.test(block);
const has60 = /60%\s*\{[^}]*z-index:\s*-1/.test(block);
const has98 = /98%[^{]*\{[^}]*z-index:\s*1/.test(block);
if (has54 && has60 && has98) { console.log('PASS: all depth fixes present'); process.exit(0); }
console.log('FAIL: missing fixes -', !has54?'no 54%':'', !has60?'no 60%':'', !has98?'no 98%':'');
process.exit(1);
