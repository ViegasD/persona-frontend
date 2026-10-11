const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const excluded = fs.readFileSync(path.resolve(__dirname, '..', '.dockerignore'), 'utf8').split(/\r?\n/);
for (const item of ['.git', '.env', '.env.*', '.cache', 'node_modules', 'scripts']) {
  assert.ok(excluded.includes(item), 'Static image must exclude ' + item);
}
console.log('PASS: private and test files excluded from static image');
