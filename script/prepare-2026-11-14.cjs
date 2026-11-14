'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);

const repo = 'kl5212840-lang/Breeze-plugins';
const tag = 'plugins-2026.11.14';
const previousTag = 'a46fd9cc4ec235d174d73b5b59d99d4bb1649119';
const inputDir = 'release-inputs/2026-11-14';
const specs = [
  { key: 'bika', label: 'Bika', previous: '0.1.2', version: '0.2.0' },
  { key: 'jm', label: 'Jm', previous: '0.1.2', version: '0.2.0' },
  { key: 'copy', label: 'Copy', previous: '0.1.2', version: '0.2.0' },
  { key: 'hanime', label: 'Hanime1-native', previous: '0.1.1', version: '0.2.0' },
  { key: 'modu', label: 'Modu-native', previous: '0.1.0', version: '0.1.1' },
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const old = (file) =>
  JSON.parse(execFileSync('git', ['show', previousTag + ':' + file], { encoding: 'utf8' }));

function load(script) {
  const module = { exports: {} };
  vm.runInNewContext(script, {
    module, exports: module.exports, console, URL, URLSearchParams, TextEncoder,
    TextDecoder, setTimeout, clearTimeout,
  }, { timeout: 3000 });
  return module.exports.default ?? module.exports;
}

async function prepare() {
  const catalogPath = 'catalog/v1/plugins_data.json';
  const catalog = old(catalogPath);
  const provenance = read(inputDir + '/provenance.json');
  const sums = [];
  const dist = 'dist/2026-11-14';
  fs.mkdirSync(dist, { recursive: true });

  for (const { key, label, previous, version } of specs) {
    const updateUrl = 'https://raw.githubusercontent.com/' + repo + '/main/updates/v1/' + key + '.json';
    const row = catalog.find((entry) => entry.manifest.updateUrl === updateUrl);
    const indexFile = 'updates/v1/' + key + '.json';
    const prior = old(indexFile);
    assert.equal(row.manifest.version, previous);
    assert.equal(prior.tag_name, 'v' + previous);
    const raw = fs.readFileSync(inputDir + '/' + key + '.cjs', 'utf8');
    const source = provenance[key];
    assert.equal(sha(raw), source.sha256);
    const plugin = load(raw);
    const before = await plugin.getInfo();
    assert.equal(before.uuid, row.manifest.uuid);
    assert.equal(before.version, source.inputVersion);

    const overrides = { version, releaseSeries: 1, updateUrl, npmName: '' };
    const icons = { bika: 'logo_round.webp', jm: 'fO.webp', copy: 'u3.webp' };
    if (icons[key]) {
      overrides.home = 'https://github.com/' + repo + '/tree/main/plugins/' + key;
      overrides.iconUrl = 'https://raw.githubusercontent.com/' + repo +
        '/main/plugins/' + key + '/assets/' + icons[key];
    }
    if (row.manifest.requirements) overrides.requirements = row.manifest.requirements;
    const releaseScript = raw + '\n;(() => { const plugin = module.exports.default ?? module.exports; const original = plugin.getInfo; const metadata = ' + JSON.stringify(overrides) + '; plugin.getInfo = function(...args) { const result = original.apply(this, args); const decorate = info => ({...info, ...metadata}); return result && typeof result.then === "function" ? result.then(decorate) : decorate(result); }; })();\n';
    const released = load(releaseScript);
    const info = JSON.parse(JSON.stringify(await released.getInfo()));
    assert.equal(info.uuid, before.uuid);
    assert.equal(info.version, version);
    assert.deepEqual(Object.keys(released), Object.keys(plugin));
    for (const name of Object.keys(plugin)) {
      if (name !== 'getInfo' && typeof plugin[name] === 'function') {
        assert.equal(String(released[name]), String(plugin[name]));
      }
    }

    const history = [...(prior.migrationFrom ?? []), ...(source.migrationFrom ?? [])];
    const migrationFrom = Array.from(new Map(history.map((entry) =>
      [entry.version + ':' + entry.scriptSha256, entry])).values());
    const metadata = { releaseSeries: 1, scriptSha256: sha(releaseScript.trim()), migrationFrom };
    if (info.requirements) metadata.requirements = info.requirements;
    Object.assign(row.manifest, metadata, { version });
    if (overrides.home) {
      row.manifest.home = overrides.home;
      row.manifest.iconUrl = overrides.iconUrl;
    }
    const name = label + '-v' + version + '.cjs';
    fs.writeFileSync(dist + '/' + name, releaseScript);
    sums.push(sha(releaseScript) + '  ' + name);
    write(indexFile, {
      ...metadata, uuid: info.uuid, tag_name: 'v' + version, name: info.name + ' v' + version,
      html_url: 'https://github.com/' + repo + '/releases/tag/' + tag,
      assets: [{ name, browser_download_url: 'https://github.com/' + repo +
        '/releases/download/' + tag + '/' + name, size: Buffer.byteLength(releaseScript) }],
      sha256: sha(releaseScript),
    });
    // Source manifests describe their own executable, independently of the release CJS.
    if (key === 'modu') {
      const { function: menu, ...manifest } = before;
      write('plugins/modu/manifest.json', manifest);
    }
    console.log(key + ' ' + version + ' ' + sha(releaseScript));
  }

  assert.equal(new Set(catalog.map((row) => row.manifest.uuid)).size, 7);
  assert.deepEqual(catalog.map((row) => row.manifest.uuid),
    old(catalogPath).map((row) => row.manifest.uuid));
  const ikun = catalog.find((entry) => entry.manifest.updateUrl.endsWith('/ikun.json'));
  ikun.manifest.home = 'https://github.com/' + repo + '/tree/main/plugins/ikun';
  write(catalogPath, catalog);
  fs.writeFileSync(dist + '/SHA256SUMS.txt', sums.join('\n') + '\n');
}

prepare().catch((error) => { console.error(error); process.exitCode = 1; });
