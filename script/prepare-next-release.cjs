'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { brotliCompressSync, constants } = require('node:zlib');

const root = path.resolve(__dirname, '..');
const repository = 'kl5212840-lang/Breeze-plugins';
const catalogFile = 'catalog/v1/plugins_data.json';
const bundles = {
  bika: 'bika/dist/breeze-plugin-bika-comic.bundle.cjs',
  jm: 'jm/dist/breeze-plugin-jm-comic.bundle.cjs',
  copy: 'copy/dist/breeze-plugin-copy-comic.bundle.cjs',
  hanime: 'hanime/hanime1-native.cjs',
  ikun: 'ikun/ikun-native.cjs',
  modu: 'modu/modu-native.cjs',
  omofun: 'omofun/omofun-native.cjs',
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function nextPatch(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

async function inspectBundle(bytes, filename) {
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, console, URL, URLSearchParams,
    TextEncoder, TextDecoder, setTimeout, clearTimeout,
  });
  vm.runInContext(bytes.toString('utf8'), context, { filename, timeout: 3000 });
  const plugin = module.exports.default ?? module.exports;
  const info = await vm.runInContext(
    '(module.exports.default ?? module.exports).getInfo()', context, { timeout: 3000 },
  );
  return { info: JSON.parse(JSON.stringify(info)), plugin };
}

function verifyMetadata(info, manifest) {
  for (const field of ['uuid', 'version', 'releaseSeries', 'updateUrl', 'npmName', 'requirements']) {
    assert.deepEqual(info[field], manifest[field], `${manifest.name}: ${field}`);
  }
}

async function prepare(baseRef, tag, currentAssets, output, keys) {
  assert.match(tag, /^plugins-\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/);
  assert.equal(new Set(keys).size, keys.length, 'Duplicate plugin selection');
  const base = git('rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`);
  const fromBase = (file) => JSON.parse(git('show', `${base}:${file}`));
  const catalog = fromBase(catalogFile);
  const catalogUuids = catalog.map(({ manifest }) => manifest.uuid);
  assert.equal(new Set(catalogUuids).size, catalogUuids.length, 'Duplicate public UUID');
  const prepared = [];

  for (const key of keys) {
    assert.ok(Object.hasOwn(bundles, key), `Unknown public plugin ${key}`);
    const file = `updates/v1/${key}.json`;
    const url = `https://raw.githubusercontent.com/${repository}/main/${file}`;
    const rows = catalog.filter(({ manifest }) => manifest.updateUrl === url);
    assert.equal(rows.length, 1, `${key}: expected a single store entry`);
    const [{ repo, manifest }] = rows;
    const index = fromBase(file);
    assert.equal(repo, repository);
    assert.equal(index.uuid, manifest.uuid);
    assert.equal(index.releaseSeries, 1);
    assert.equal(manifest.releaseSeries, 1);
    assert.equal(index.tag_name, `v${manifest.version}`);
    assert.equal(index.scriptSha256, manifest.scriptSha256);
    assert.deepEqual(index.requirements, manifest.requirements);
    assert.deepEqual(index.migrationFrom, manifest.migrationFrom);

    const versionSuffix = `-v${manifest.version}.cjs`;
    const previousScripts = index.assets.filter(({ name }) => name.endsWith(versionSuffix));
    assert.equal(previousScripts.length, 1, `${key}: expected one previous CJS`);
    const [previousAsset] = previousScripts;
    assert.ok(previousAsset.name === path.basename(previousAsset.name));
    const previousBytes = fs.readFileSync(path.join(currentAssets, previousAsset.name));
    assert.equal(previousBytes.length, previousAsset.size);
    assert.equal(sha256(previousBytes), index.sha256);
    assert.equal(sha256(previousBytes.toString('utf8').trim()), index.scriptSha256);
    const previous = await inspectBundle(previousBytes, previousAsset.name);
    verifyMetadata(previous.info, manifest);

    const version = nextPatch(manifest.version);
    const name = previousAsset.name.slice(0, -versionSuffix.length) + `-v${version}.cjs`;
    const bytes = fs.readFileSync(path.join(root, 'plugins', bundles[key]));
    const candidate = await inspectBundle(bytes, name);
    verifyMetadata(candidate.info, { ...manifest, version });
    // JM 0.2.1 reports allowLike=false. Host details then hide the retired write.
    const retired = key === 'jm' && manifest.version === '0.2.0' ? ['toggleLike'] : [];
    for (const name of Object.keys(previous.plugin)) {
      if (typeof previous.plugin[name] === 'function' && !retired.includes(name)) {
        assert.equal(typeof candidate.plugin[name], 'function', `${key}: missing export ${name}`);
      }
    }

    const sha = sha256(bytes);
    const scriptSha256 = sha256(bytes.toString('utf8').trim());
    const attachments = [{ name, bytes, sha }];
    const compressed = brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: 11,
      },
    });
    if (compressed.length < bytes.length) {
      attachments.push({ name: `${name}.br`, bytes: compressed, sha: sha256(compressed) });
    }
    Object.assign(manifest, { version, scriptSha256 });
    const indexUpdate = {
      ...index, sha256: sha, scriptSha256, tag_name: `v${version}`,
      name: `${candidate.info.name} v${version}`,
      html_url: `https://github.com/${repository}/releases/tag/${tag}`,
      assets: attachments.map((asset) => ({
        name: asset.name,
        browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${asset.name}`,
        size: asset.bytes.length,
      })),
    };
    prepared.push({ key, name, version, attachments, sha, scriptSha256, file, indexUpdate });
  }

  fs.mkdirSync(output);
  const attachments = path.join(output, 'attachments');
  fs.mkdirSync(attachments);
  const writeMetadata = (file, value) => {
    const target = path.join(output, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json(value));
  };
  for (const { file, indexUpdate } of prepared) {
    writeMetadata(file, indexUpdate);
  }
  const files = prepared.flatMap((release) => release.attachments);
  for (const { name, bytes } of files) {
    fs.writeFileSync(path.join(attachments, name), bytes);
  }
  writeMetadata(catalogFile, catalog);
  fs.writeFileSync(path.join(attachments, 'SHA256SUMS.txt'),
    files.map(({ sha, name }) => `${sha}  ${name}\n`).join(''));
  console.log(json({ base, tag, plugins: prepared.map(({ key, name, version, sha, scriptSha256 }) => ({
    key, version, name, sha256: sha, scriptSha256,
  })) }).trimEnd());
}

const [baseRef, tag, currentAssets, output, ...selection] = process.argv.slice(2);
if (!baseRef || !tag || !currentAssets || !output) {
  console.error('Usage: node script/prepare-next-release.cjs <published-ref> <tag> <previous-assets> <new-output> [plugin ...]');
  process.exitCode = 1;
} else {
  prepare(baseRef, tag, currentAssets, output, selection.length ? selection : Object.keys(bundles))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
