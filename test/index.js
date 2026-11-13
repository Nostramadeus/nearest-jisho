// Entry for `node --test test/`. Node 24 treats the argument as a file path, and a folder resolves to
// this index.js, which loads every *.test.mjs file in this folder.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

for (const f of readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) {
  import(pathToFileURL(join(__dirname, f)).href);
}
