const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {createRequire} = require('node:module');
const cfg = JSON.parse(fs.readFileSync('release.json'));
const specs = [
  ['bika','Bika','dist/breeze-plugin-bika-comic.bundle.cjs'],
  ['jm','Jm','dist/breeze-plugin-jm-comic.bundle.cjs'],
  ['copy','Copy','dist/breeze-plugin-copy-comic.bundle.cjs'],
  ['hanime','Hanime1-native','hanime1-native.cjs'],
  ['ikun','iKun-native','ikun-native.cjs'],
];
(async () => {
  fs.mkdirSync('updates',{recursive:true}); fs.mkdirSync('dist',{recursive:true});
  for(const file of fs.readdirSync('dist')) if(file.endsWith('.cjs')) fs.unlinkSync(path.join('dist',file));
  const catalog=[], sums=[];
  for (const [key,label,bundle] of specs) {
    const dir=path.resolve('plugins',key), file=path.join(dir,bundle);
    const mod=createRequire(__filename)(file);
    const info=await (mod.default??mod).getInfo();
    const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
    for (const k of ['uuid','version','iconUrl','updateUrl']) {
      if (manifest[k]!==info[k]) throw Error(`${key}: ${k} differs from getInfo`);
    }
    const expected=`https://raw.githubusercontent.com/${cfg.repo}/main/updates/${key}.json`;
    if (info.updateUrl!==expected) throw Error(`${key}: wrong update channel`);
    const name=`${label}-v${info.version}.cjs`;
    const bytes=fs.readFileSync(file); fs.writeFileSync(path.join('dist',name),bytes);
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
    const update={tag_name:`v${info.version}`,name:`${info.name} v${info.version}`,html_url:`https://github.com/${cfg.repo}/releases/tag/${cfg.tag}`,assets:[{name,browser_download_url:`https://github.com/${cfg.repo}/releases/download/${cfg.tag}/${name}`,size:bytes.length}]};
    fs.writeFileSync(`updates/${key}.json`,JSON.stringify(update,null,2)+'\n');
    const meta={}; for(const k of ['name','uuid','iconUrl','describe','version','home','websiteUrl','updateUrl']) if(info[k]!=null) meta[k]=info[k];
    meta.npmName=''; meta['breeze-plugin-github-repository']=`https://github.com/${cfg.repo}`;
    catalog.push({repo:cfg.repo,manifest:meta});
  }
  if(new Set(catalog.map(x=>x.manifest.uuid)).size!==specs.length) throw Error('duplicate UUID');
  fs.writeFileSync('plugins_data.json',JSON.stringify(catalog,null,2)+'\n');
  fs.writeFileSync('dist/SHA256SUMS.txt',sums.join('\n')+'\n');
  console.log(catalog.map(x=>`${x.manifest.name} ${x.manifest.version}`).join('\n'));
})().catch(e=>{console.error(e);process.exitCode=1});
