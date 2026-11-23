'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'plugins');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const config = (key) => JSON.parse(read(`${key}/source.json`));
const withoutExports = (file) => {
  const script = read(file);
  const exportLine = /module\.exports\s*=\s*\{[^\n]+\};\s*$/;
  assert.match(script, exportLine, `${file} must export its helpers on the final line`);
  return script.replace(exportLine, '');
};

function writeBundle(key, source) {
  const file = path.join(root, key, `${key}-native.cjs`);
  fs.writeFileSync(file, source);
  const info = require(file).getInfo();
  const { function: _actions, ...summary } = info;
  const manifest = key === 'modu' ? summary : info;
  fs.writeFileSync(path.join(root, key, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${info.name} ${info.version}`);
}

const moduEntry = read('modu/entry.cjs');
const moduConfigStart = moduEntry.indexOf('config.detailPath');
assert.ok(moduConfigStart >= 0, 'Missing Modu detail configuration');
writeBundle('modu', [
  withoutExports('video-common/cms-core.cjs'),
  `const config = ${JSON.stringify(config('modu'))};`,
  moduEntry.slice(moduConfigStart),
].join('\n'));

writeBundle('omofun', [
  withoutExports('video-common/public-html.cjs'),
  withoutExports('video-common/public-player-url.cjs'),
  `const omoConfig=${JSON.stringify(config('omofun'))};`,
  read('omofun/entry.cjs'),
].join('\n'));
