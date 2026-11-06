// One-time, reproducible metadata migration of the five published bundles.
// Unreleased source and local dist files are never inputs to this script.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'formal-release.json')));
const hash = x => createHash('sha256').update(x).digest('hex');
function load(script) {
  const module = {exports: {}};
  const context = vm.createContext({module, exports: module.exports, console: {log(){},warn(){},error(){}}, setTimeout,clearTimeout,TextEncoder,TextDecoder,URL,URLSearchParams});
  vm.runInContext(script, context, {timeout: 3000});
  return module.exports.default ?? module.exports;
}
async function build() {
  const catalog = [], sums = [], evidence = [];
  const dist = path.join(root, 'dist/formal-v1');
  fs.mkdirSync(dist, {recursive: true});
  fs.mkdirSync(path.join(root, 'catalog/v1'), {recursive: true});
  fs.mkdirSync(path.join(root, 'updates/v1'), {recursive: true});
  for (const spec of cfg.plugins) {
    const originalBytes = fs.readFileSync(path.join(root, 'compat/published', spec.legacyFile));
    assert.equal(hash(originalBytes), spec.legacySha256, `${spec.key}: published artifact changed`);
    const original = originalBytes.toString('utf8');
    const before = load(original);
    const oldInfo = await before.getInfo();
    assert.equal(oldInfo.uuid, spec.uuid);
    assert.equal(oldInfo.version, spec.oldVersion);
    const escaped = spec.oldVersion.replaceAll('.', '\\.');
    const pattern = new RegExp(`(version\\s*:\\s*)(['"])${escaped}\\2`, 'g');
    assert.equal([...original.matchAll(pattern)].length, 1);
    let script = original.replace(pattern, (_, prefix, quote) => `${prefix}${quote}${spec.version}${quote}, releaseSeries: ${spec.releaseSeries}`);
    assert.equal(script.split(oldInfo.updateUrl).length - 1, 1);
    script = script.replace(oldInfo.updateUrl, spec.updateUrl);
    const undo = script.replace(spec.updateUrl, oldInfo.updateUrl).replace(/(version\s*:\s*)(['"])0\.1\.0\2, releaseSeries: 1/, (_, prefix, quote) => `${prefix}${quote}${spec.oldVersion}${quote}`);
    assert.equal(undo, original, `${spec.key}: business content must be identical`);
    const after = load(script);
    const info = JSON.parse(JSON.stringify(await after.getInfo()));
    const old = JSON.parse(JSON.stringify(oldInfo));
    assert.deepEqual({...info, version: old.version, updateUrl: old.updateUrl, releaseSeries: undefined}, {...old, releaseSeries: undefined});
    assert.deepEqual(Object.keys(after), Object.keys(before));
    for (const name of Object.keys(before)) {
      if (name !== 'getInfo' && typeof before[name] === 'function') assert.equal(String(after[name]), String(before[name]), `${spec.key}: ${name} changed`);
    }
    const name = `${spec.label}-v${spec.version}.cjs`;
    const bytes = Buffer.from(script);
    fs.writeFileSync(path.join(dist, name), bytes);
    sums.push(`${hash(bytes)}  ${name}`);
    const migrationFrom = [{version: spec.oldVersion, scriptSha256: spec.legacyScriptSha256}];
    for (const previous of spec.additionalPublished ?? []) {
      const bytes = fs.readFileSync(path.join(root, 'compat/published', previous.file));
      assert.equal(hash(bytes), previous.sha256);
      assert.equal(hash(bytes.toString('utf8').trim()), previous.scriptSha256);
      const info = await load(bytes.toString('utf8')).getInfo();
      assert.equal(info.uuid, spec.uuid); assert.equal(info.version, previous.version);
      migrationFrom.push({version: previous.version, scriptSha256: previous.scriptSha256});
    }
    const releaseInfo = {releaseSeries: spec.releaseSeries, scriptSha256: hash(script.trim()), migrationFrom};
    const url = `https://github.com/${cfg.repo}/releases/download/${cfg.tag}/${name}`;
    const update = {...releaseInfo, uuid: spec.uuid, tag_name: `v${spec.version}`, name: `${info.name} v${spec.version}`, html_url: `https://github.com/${cfg.repo}/releases/tag/${cfg.tag}`, assets: [{name, browser_download_url: url, size: bytes.length}], sha256: hash(bytes)};
    fs.writeFileSync(path.join(root, 'updates/v1', `${spec.key}.json`), JSON.stringify(update,null,2)+'\n');
    const manifest = {...info};
    fs.writeFileSync(path.join(root, 'plugins', spec.key, 'manifest.json'), JSON.stringify(manifest,null,2)+'\n');
    const meta = {};
    for (const key of ['name','uuid','iconUrl','describe','version','home','websiteUrl','updateUrl']) if (info[key] != null) meta[key] = info[key];
    Object.assign(meta, releaseInfo, {npmName: '', 'breeze-plugin-github-repository': `https://github.com/${cfg.repo}`});
    catalog.push({repo: cfg.repo, manifest: meta});
    evidence.push({key: spec.key, oldVersion: spec.oldVersion, version: info.version, uuid: info.uuid, legacySha256: spec.legacySha256, sha256: hash(bytes), scriptSha256: releaseInfo.scriptSha256, onlyMetadataChanged: true, exportsPreserved: true});
  }
  assert.equal(new Set(catalog.map(x=>x.manifest.uuid)).size, 5);
  fs.writeFileSync(path.join(root, 'catalog/v1/plugins_data.json'), JSON.stringify(catalog,null,2)+'\n');
  fs.writeFileSync(path.join(dist,'SHA256SUMS.txt'), sums.join('\n')+'\n');
  fs.writeFileSync(path.join(dist,'verification.json'), JSON.stringify(evidence,null,2)+'\n');
  console.log(evidence.map(x=>`${x.key}: ${x.oldVersion} -> ${x.version}; business content unchanged`).join('\n'));
}
build().catch(error => {console.error(error);process.exitCode=1;});
