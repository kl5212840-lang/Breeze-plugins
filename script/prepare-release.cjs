// Prepare formal-series releases only. Legacy root catalog and indices are frozen.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
if (process.argv.includes('--published-baseline')) {
  require('./migrate-published-v1.cjs');
} else {
  prepare().catch(error => { console.error(error); process.exitCode = 1; });
}
async function prepare() {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'release.json')));
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'formal-release.json')));
  assert.equal(cfg.repo, baseline.repo);
  assert.notEqual(cfg.tag, baseline.baselineTag, 'Use a new release tag');
  const specs = [
    ['bika','Bika','dist/breeze-plugin-bika-comic.bundle.cjs'],
    ['jm','Jm','dist/breeze-plugin-jm-comic.bundle.cjs'],
    ['copy','Copy','dist/breeze-plugin-copy-comic.bundle.cjs'],
    ['hanime','Hanime1-native','hanime1-native.cjs'],
    ['ikun','iKun-native','ikun-native.cjs'],
  ];
  const hash = value => createHash('sha256').update(value).digest('hex');
  const catalog = [], sums = [];
  const dist = path.join(root, 'dist/formal-v1');
  fs.mkdirSync(dist, {recursive:true});
  fs.mkdirSync(path.join(root,'updates/v1'), {recursive:true});
  fs.mkdirSync(path.join(root,'catalog/v1'), {recursive:true});
  for (const [key,label,bundle] of specs) {
    const dir = path.join(root,'plugins',key);
    const bytes = fs.readFileSync(path.join(dir,bundle));
    const module = {exports:{}};
    const context = vm.createContext({module,exports:module.exports,console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,TextEncoder,TextDecoder,URL,URLSearchParams});
    vm.runInContext(bytes.toString('utf8'),context,{timeout:3000});
    const info = JSON.parse(JSON.stringify(await (module.exports.default??module.exports).getInfo()));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir,'package.json')));
    const original = baseline.plugins.find(p=>p.key===key);
    for (const field of ['uuid','version','releaseSeries','iconUrl','updateUrl']) assert.equal(manifest[field],info[field],`${key}: ${field} differs from getInfo`);
    assert.equal(info.uuid,original.uuid,`${key}: UUID must remain stable`);
    assert.equal(info.version,pkg.version,`${key}: package version differs`);
    assert.match(info.version,/^0\.\d+\.\d+$/);
    assert.equal(info.releaseSeries,1);
    assert.equal(info.updateUrl,`https://raw.githubusercontent.com/${cfg.repo}/main/updates/v1/${key}.json`);
    // The first formal release must use exact published-code metadata migration.
    // Recompiled or changed code needs a new public plugin version.
    if(info.version==='0.1.0') {
      const published = fs.readFileSync(path.join(root,'compat/published',original.legacyFile),'utf8');
      const reverted = bytes.toString('utf8').replace(info.updateUrl,`https://raw.githubusercontent.com/${cfg.repo}/main/updates/${key}.json`).replace(/(version\s*:\s*)(['"])0\.1\.0\2, releaseSeries: 1/,(_,p,q)=>`${p}${q}${original.oldVersion}${q}`);
      assert.equal(reverted,published,`${key}: 0.1.0 is frozen; use --published-baseline or bump version`);
    }
    const migrationFrom = [{version:original.oldVersion,scriptSha256:original.legacyScriptSha256},...(original.additionalPublished??[]).map(x=>({version:x.version,scriptSha256:x.scriptSha256}))];
    const releaseInfo = {releaseSeries:1,scriptSha256:hash(bytes.toString('utf8').trim()),migrationFrom};
    const name = `${label}-v${info.version}.cjs`;
    fs.writeFileSync(path.join(dist,name),bytes);
    sums.push(`${hash(bytes)}  ${name}`);
    const update = {...releaseInfo,uuid:info.uuid,tag_name:`v${info.version}`,name:`${info.name} v${info.version}`,html_url:`https://github.com/${cfg.repo}/releases/tag/${cfg.tag}`,assets:[{name,browser_download_url:`https://github.com/${cfg.repo}/releases/download/${cfg.tag}/${name}`,size:bytes.length}],sha256:hash(bytes)};
    fs.writeFileSync(path.join(root,'updates/v1',`${key}.json`),JSON.stringify(update,null,2)+'\n');
    const meta = {};
    for(const field of ['name','uuid','iconUrl','describe','version','home','websiteUrl','updateUrl']) if(info[field]!=null) meta[field]=info[field];
    Object.assign(meta,releaseInfo,{npmName:'','breeze-plugin-github-repository':`https://github.com/${cfg.repo}`});
    catalog.push({repo:cfg.repo,manifest:meta});
  }
  assert.equal(new Set(catalog.map(x=>x.manifest.uuid)).size,specs.length);
  fs.writeFileSync(path.join(root,'catalog/v1/plugins_data.json'),JSON.stringify(catalog,null,2)+'\n');
  fs.writeFileSync(path.join(dist,'SHA256SUMS.txt'),sums.join('\n')+'\n');
  console.log(catalog.map(x=>`${x.manifest.name} ${x.manifest.version}`).join('\n'));
}
