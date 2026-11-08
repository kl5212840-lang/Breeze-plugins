'use strict';

// Read the reviewed player's public URL wrapper without evaluating its script.
// This handles a URL string, not video bytes or media encryption.
function rc4Literal(encoded, key) {
  const alphabet='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
  const bytes=[]; let bits=0, value=0;
  for (const c of encoded) {
    const n=alphabet.indexOf(c);
    if(n<0 || n===64) break;
    value=(value<<6)|n; bits+=6;
    if(bits>=8) {bits-=8;bytes.push((value>>bits)&255);}
  }
  const input=decodeURIComponent(bytes.map(n=>'%'+n.toString(16).padStart(2,'0')).join(''));
  const box=Array.from({length:256},(_,i)=>i);let j=0;
  for(let i=0;i<256;i++){j=(j+box[i]+key.charCodeAt(i%key.length))&255;[box[i],box[j]]=[box[j],box[i]];}
  let i=0; j=0; let output='';
  for(let p=0;p<input.length;p++) {i=(i+1)&255;j=(j+box[i])&255;[box[i],box[j]]=[box[j],box[i]];
    output+=String.fromCharCode(input.charCodeAt(p)^box[(box[i]+box[j])&255]);}
  return output;
}

function publicWrapperKey(source) {
  if(typeof source!=='string' || source.length>300000 ||
     !source.startsWith('function N(Q,b){return G(b- -0x223,Q);}') ||
     !source.includes('h=h-0xd9') || !source.includes('return G(b-0x24f,Q)')) {
    throw new Error('播放器模板已变化，请更新插件');
  }
  const array=source.match(/function A\(\)\{var s=\[([^\]]+)\];A=function/);
  if(!array || !/^'(?:[a-zA-Z0-9+/=]*)'(?:,'[a-zA-Z0-9+/=]*')*$/.test(array[1])) {
    throw new Error('播放器字面量表已变化');
  }
  const table=array[1].split(',').map(s=>s.slice(1,-1));
  if(table.length<10 || table.length>500) throw new Error('播放器字面量表无效');
  const decode=(n,k)=>rc4Literal(table[n],k);
  const c=(key,n)=>parseInt(decode(n-0x328,key),10);
  let ready=false;
  for(let rotation=0;rotation<table.length;rotation++) {
    try {
      const value=-c('XSaA',0x33f)-c('$CPy',0x363)/2*(c('ey5%',0x35d)/3)+
        c('@tsF',0x32f)/4*(c('vln4',0x362)/5)+c('%^Y9',0x33b)/6*(-c('qk8^',0x32e)/7)+
        -c('B8tp',0x33c)/8*(-c('R]R)',0x345)/9)+-c('p6rm',0x32d)/10*(c('ZGMr',0x342)/11)+
        c('ey5%',0x358)/12*(c('@tsF',0x343)/13);
      if(value===0xc0d7c){ready=true;break;}
    }catch(_){/* A rotated table can contain invalid UTF-8 for this key. */}
    table.push(table.shift());
  }
  if(!ready) throw new Error('播放器字面量布局无法识别');
  const helper=source.slice(source.indexOf('function playData('));
  if(!helper.startsWith('function playData('))throw new Error('播放器缺少URL包装定义');
  const literal=String.raw`(?:0x[0-9a-f]+|\d+|'[^'\\]*'|"[^"\\]*")`;
  const resolved=helper.replace(new RegExp(String.raw`H\((${literal}),(${literal})\)`,'g'),(_call,key,n)=>{
    const number=Number(n.replace(/^['"]|['"]$/g,''));
    const index=number-0x106;
    if(!Number.isInteger(index)||index<0||index>=table.length)throw new Error('播放器字面量索引无效');
    return JSON.stringify(decode(index,key.slice(1,-1)));
  });
  const expression=resolved.match(/const o=CryptoJS[\s\S]*?\]\(([^;]+?)\),h=CryptoJS/)?.[1];
  if(!expression || !/^(?:'[^'\\]*'|"[^"\\]*")(?:\s*\+\s*(?:'[^'\\]*'|"[^"\\]*"))*$/.test(expression) ||
     !resolved.includes('["Hex"]'))throw new Error('播放器URL包装定义无法识别');
  const key=[...expression.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)].map(x=>x[1]??x[2]).join('');
  if(![16,24,32].includes(new TextEncoder().encode(key).length))throw new Error('播放器URL包装参数无效');
  return key;
}

async function unwrapPublicPlayerUrl(helper, html, crypto=require('crypto')) {
  const encrypted=html.match(/\burl:\s*playData\('([A-Za-z0-9+/=]+)'\s*,\s*'([a-fA-F0-9]{32})'\)/);
  if(!encrypted)throw new Error('播放器没有可识别的媒体地址');
  const key=publicWrapperKey(helper),iv=Uint8Array.from(encrypted[2].match(/../g).map(x=>parseInt(x,16)));
  let output;
  if(typeof crypto.aesCbcPkcs7Decrypt==='function') {
    const payload=Uint8Array.from(atob(encrypted[1]),c=>c.charCodeAt(0));
    output=new TextDecoder().decode(await crypto.aesCbcPkcs7Decrypt(payload,new TextEncoder().encode(key),iv));
  } else if(typeof crypto.createDecipheriv==='function') {
    // Node-only contract checks; shipped Breeze uses the host byte API above.
    const decipher=crypto.createDecipheriv(`aes-${key.length*8}-cbc`,new TextEncoder().encode(key),iv);
    output=decipher.update(encrypted[1],'base64','utf8')+decipher.final('utf8');
  } else throw new Error('请更新支持URL包装解析的Breeze客户端');
  const url=new URL(output);
  if(url.protocol!=='https:' || url.username || url.password)throw new Error('播放器返回了不可用地址');
  return url.href;
}

module.exports={unwrapPublicPlayerUrl};
