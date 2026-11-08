'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const cfg=require('../public-versions.json'),baseline=require('../formal-release.json');
const sha=x=>createHash('sha256').update(x).digest('hex');
const load=s=>{const module={exports:{}};vm.runInNewContext(s,{module,exports:module.exports,console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,TextEncoder,TextDecoder,URL,URLSearchParams},{timeout:3000});return module.exports.default??module.exports;};
(async()=>{
 const catalog=[],sums=[],evidence=[];fs.mkdirSync('dist/current',{recursive:true});
 for(const spec of cfg.plugins){
  assert.notEqual(spec.key,'oscar');const raw=fs.readFileSync(`release-inputs/2026-11-08/${spec.key}.cjs`);assert.equal(sha(raw),spec.inputSha256);
  const original=load(raw.toString()),before=await original.getInfo();
  const updateUrl=`https://raw.githubusercontent.com/${cfg.repo}/main/updates/v1/${spec.key}.json`;
  const overrides={version:spec.version,releaseSeries:1,updateUrl,npmName:''};
  if((before.function??[]).some(f=>f.action?.type==='openVideoLibrary' && f.action?.payload?.protocol===2)) overrides.requirements={version:1,capabilities:{videoLibraryProtocol:2}};
  const script=raw.toString()+`\n;(() => { const plugin = module.exports.default ?? module.exports; const original = plugin.getInfo; const metadata = ${JSON.stringify(overrides)}; plugin.getInfo = function(...args) { const result = original.apply(this, args); const decorate = info => ({...info, ...metadata}); return result && typeof result.then === 'function' ? result.then(decorate) : decorate(result); }; })();\n`;
  const plugin=load(script),info=JSON.parse(JSON.stringify(await plugin.getInfo()));
  assert.equal(info.uuid,before.uuid);assert.equal(info.version,spec.version);assert.equal(info.releaseSeries,1);assert.deepEqual(Object.keys(plugin),Object.keys(original));
  for(const name of Object.keys(original))if(name!=='getInfo'&&typeof original[name]==='function')assert.equal(String(plugin[name]),String(original[name]));
  const legacy=baseline.plugins.find(p=>p.key===spec.key);
  const migrationFrom=legacy?[{version:legacy.oldVersion,scriptSha256:legacy.legacyScriptSha256},...(legacy.additionalPublished??[]).map(x=>({version:x.version,scriptSha256:x.scriptSha256}))]:[];
  const name=`${spec.label}-v${spec.version}.cjs`,bytes=Buffer.from(script);fs.writeFileSync(`dist/current/${name}`,bytes);sums.push(`${sha(bytes)}  ${name}`);
  const metadata={releaseSeries:1,scriptSha256:sha(script.trim()),migrationFrom};
  if(info.function?.video?.protocolVersion===2||info.videoLibraryProtocol===2)metadata.requirements={version:1,capabilities:{videoLibraryProtocol:2}};
  // Source contracts use native.video.protocol; preserve any explicit requirements.
  if(info.requirements)metadata.requirements=info.requirements;
  const update={...metadata,uuid:info.uuid,tag_name:`v${spec.version}`,name:`${info.name} v${spec.version}`,html_url:`https://github.com/${cfg.repo}/releases/tag/${cfg.tag}`,assets:[{name,browser_download_url:`https://github.com/${cfg.repo}/releases/download/${cfg.tag}/${name}`,size:bytes.length}],sha256:sha(bytes)};
  fs.mkdirSync('updates/v1',{recursive:true});fs.writeFileSync(`updates/v1/${spec.key}.json`,JSON.stringify(update,null,2)+'\n');
  const manifest={};for(const k of ['name','uuid','iconUrl','describe','version','home','websiteUrl','updateUrl','requirements'])if(info[k]!=null)manifest[k]=info[k];Object.assign(manifest,metadata,{npmName:'','breeze-plugin-github-repository':`https://github.com/${cfg.repo}`});catalog.push({repo:cfg.repo,manifest});
  fs.writeFileSync(`plugins/${spec.key}/manifest.json`,JSON.stringify(info,null,2)+'\n');
  const pp=`plugins/${spec.key}/package.json`;if(fs.existsSync(pp)){const pkg=JSON.parse(fs.readFileSync(pp));pkg.version=spec.version;fs.writeFileSync(pp,JSON.stringify(pkg,null,2)+'\n');}
  evidence.push({key:spec.key,name:info.name,version:spec.version,uuid:info.uuid,file:name,sha256:sha(bytes),inputSha256:sha(raw),businessExportsUnchanged:true});
 }
 assert.equal(catalog.length,7);assert.equal(new Set(catalog.map(x=>x.manifest.uuid)).size,7);
 fs.mkdirSync('catalog/v1',{recursive:true});fs.writeFileSync('catalog/v1/plugins_data.json',JSON.stringify(catalog,null,2)+'\n');fs.writeFileSync('dist/current/SHA256SUMS.txt',sums.join('\n')+'\n');fs.writeFileSync('dist/current/verification.json',JSON.stringify(evidence,null,2)+'\n');console.log(evidence.map(x=>`${x.key}: ${x.version}`).join('\n'));
})().catch(e=>{console.error(e);process.exitCode=1;});
