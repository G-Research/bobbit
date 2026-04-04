const fs = require('fs');
const p = require('path');
const filepath = p.join(__dirname, 'src', 'ui', 'components', 'GitStatusWidget.ts');
let c = fs.readFileSync(filepath, 'utf8');
console.log('File length:', c.length);
const idx = c.indexOf('Terse pill indicator');
console.log('Found Terse at:', idx);
if (idx >= 0) {
    console.log('Snippet:', JSON.stringify(c.substring(idx, idx+80)));
}
