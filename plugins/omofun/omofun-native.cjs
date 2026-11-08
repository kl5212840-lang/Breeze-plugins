'use strict';

function htmlText(value) {
  const named={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',hellip:'…',middot:'·',mdash:'—',ndash:'–'};
  return String(value||'').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(raw,name)=>{
    if(name[0]!=='#')return named[name.toLowerCase()]??raw;
    const number=name[1].toLowerCase()==='x'?parseInt(name.slice(2),16):Number(name.slice(1));
    return number>0 && number<=0x10ffff && !(number>=0xd800&&number<=0xdfff)?String.fromCodePoint(number):'';
  }).replace(/\s+/g,' ').trim();
}
function parsePublicHtml(input) {
  if(typeof input!=='string'||input.length>2500000)throw new Error('网页内容过大或格式已变化');
  // Controllers and styles are never evaluated and do not enter visible text.
  const source=input.replace(/<!--[^]*?-->/g,'').replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi,'');
  const root={tag:'root',attrs:{},children:[],parent:null};let current=root,count=0;
  const voids=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  for(const token of source.matchAll(/<[^>]+>|[^<]+/g)) {
    const text=token[0];
    if(text[0]!=='<'){current.children.push(htmlText(text));continue;}
    if(/^<!|^<\?/.test(text))continue;
    const end=text.match(/^<\/\s*([\w-]+)/);
    if(end){let node=current;while(node.parent){if(node.tag===end[1].toLowerCase()){current=node.parent;break;}node=node.parent;}continue;}
    const start=text.match(/^<\s*([\w-]+)/);if(!start)continue;
    if(++count>50000)throw new Error('网页结构过大');
    const attrs={};
    for(const a of text.slice(start[0].length,-1).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attrs[a[1].toLowerCase()]=htmlText(a[2]??a[3]??a[4]??'');
    const node={tag:start[1].toLowerCase(),attrs,children:[],parent:current};current.children.push(node);
    if(!voids.has(node.tag)&&!text.endsWith('/>'))current=node;
  }
  return root;
}
function nodes(root,predicate) {
  const out=[],stack=[root];
  while(stack.length){const node=stack.pop();if(!node||typeof node==='string')continue;
    if(predicate(node))out.push(node);for(let i=node.children.length-1;i>=0;i--)stack.push(node.children[i]);}
  return out;
}
function nodeText(node) {return htmlText(node?.children.map(n=>typeof n==='string'?n:nodeText(n)).join(' ')||'');}
function hasClass(node,name){return (node.attrs.class||'').split(/\s+/).includes(name);}
function jsonAssignment(source,name) {
  const marker=new RegExp('\\b'+name+'\\s*=\\s*').exec(source);
  if(!marker)throw new Error('网页缺少播放数据');
  const start=marker.index+marker[0].length;
  if(source[start]!=='{')throw new Error('播放数据格式已变化');
  let level=0,string=false,escape=false;
  for(let p=start;p<Math.min(source.length,start+1000000);p++){
    const c=source[p];
    if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;continue;}
    if(c==='"')string=true;else if(c==='{')level++;else if(c==='}'&&--level===0)return JSON.parse(source.slice(start,p+1));
  }
  throw new Error('播放数据不完整');
}

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


const omoConfig={"key":"omofun","id":"ccc2fe17-c0a8-4fd8-a596-835772686404","name":"OmoFun 动漫","version":"0.1.8","imageHome":"https://as.cfhls.top/","home":"https://www.omofuna.com/","iconUrl":"data:image/png;base64,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","capabilities":{"search":"full","year":true,"recent":false,"yearOnSearch":false,"filtersOnSearch":false,"yearTypePrefixes":["type:","genre:"],"browserCatalog":true,"browserItemPrefix":"/anime/","browserPaths":["/type/","/show/","/search/","/week","/topic","/dayhot","/weekhot","/monthhot","/allhot"],"presentation":"anime","siteAccount":true,"sourceSort":true,"rawHlsRecovery":true,"browserDetail":true},"iconSourceUrl":"https://www.omofuna.com/template/the4/statics/img/favicon.ico"};
'use strict';
const ID=omoConfig.id, HOME=omoConfig.home;
const details=new Map(), genreCache=new Map();
let topicCache=null, helperCache=null;
const playerTemplates=new Map();
const mediaReferrerPolicies=new Map();
const unavailableParsers=new Map();
const types=[['1','日漫'],['2','国漫'],['5','动画'],['24','剧场'],['4','特摄'],['3','美漫']];
const days=['周一','周二','周三','周四','周五','周六','周日'];
const ranks=[['dayhot','日榜'],['weekhot','周榜'],['monthhot','月榜'],['allhot','总榜']];
function text(v,max=500){return (typeof v==='string'||typeof v==='number'?String(v):'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,max);}
function requireClient(args){if(args.clientProtocol!==2)throw new Error('请更新配套 Breeze 客户端后使用此插件');}
function workId(v){const id=text(v,80);if(!/^[a-f0-9]{16,64}$/.test(id))throw new Error('无效的作品编号');return id;}
function https(raw,base=HOME){if(!text(raw,4096))return '';try{const u=new URL(raw,base);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch(_){return '';}}
function imageUrl(raw){
  let value=text(raw,4096);if(!value)return '';
  if(/^mac:\/\//i.test(value))value='https://'+value.slice(6).replace(/^\/+/,'');
  try{
    const url=new URL(value,HOME);
    if(url.origin===new URL(HOME).origin&&/^\/+upload\//.test(url.pathname))return https(url.pathname.replace(/^\/+/,'')+url.search,omoConfig.imageHome);
    return https(value,HOME);
  }catch(_){return '';}
}
function pageUrl(raw){const u=new URL(raw,HOME);if(u.origin!==new URL(HOME).origin||u.hash||!omoConfig.capabilities.browserPaths.some(p=>u.pathname.startsWith(p))&&u.pathname!=='/')throw new Error('无效的片库页面');return u.href;}
function detailUrl(id){return new URL(`/anime/${workId(id)}.html`,HOME).href;}
function watchUrl(id,line,episode){const u=new URL(detailUrl(id));u.searchParams.set('line',line);u.searchParams.set('episode',episode);return u.href;}
// Context is passed explicitly: concurrent resolution calls never mutate a
// process-global fetch or another plugin's route. Older hosts retain fetch.
async function networkFetch(url,options,context){
  if(!context)return fetch(url,options);
  if(typeof bridge==='undefined'||typeof bridge.call!=='function')throw new Error('请更新配套客户端以使用独立网络');
  if(options.signal?.aborted)throw new Error('aborted');
  const request='r'+Date.now().toString(36)+Math.random().toString(36).slice(2);
  const cancel=()=>Promise.resolve(bridge.call('breeze.omo.cancel',{context,request})).catch(()=>{});
  options.signal?.addEventListener('abort',cancel,{once:true});
  try{
    let result=await bridge.call('breeze.omo.fetch',{context,request,url,headers:options.headers||{},timeout:options.timeout||8000,responseMode:'poll-v1'});
    if(options.signal?.aborted)throw new Error('aborted');
    if(typeof result==='string')result=JSON.parse(result);
    while(result.pending===true){
      await new Promise(resolve=>setTimeout(resolve,125));
      if(options.signal?.aborted)throw new Error('aborted');
      result=await bridge.call('breeze.omo.poll',{context,request});
      if(typeof result==='string')result=JSON.parse(result);
    }
    return {status:result.status,ok:result.status>=200&&result.status<300,
      headers:{get:name=>result.headers?.[String(name).toLowerCase()]??null},text:async()=>result.body};
  }finally{options.signal?.removeEventListener('abort',cancel);await cancel();}
}
async function request(url,options={}){
  const address=new URL(url),label=options.label||(address.origin===new URL(HOME).origin
    ? (address.pathname.includes('/play/')?'分集页面':'影片页面')
    : '播放解析服务');
  // The external parser is slower than the source HTML on iOS. Its observed
  // 8-second timeouts must not abort an otherwise valid manual episode choice.
  const timeout=options.timeout||8000;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  let status=0;
  try{const r=await networkFetch(url,{signal:controller.signal,timeout,credentials:'omit',headers:{Accept:'text/html,application/javascript,*/*'}},options.networkContext);
    status=r.status;if(!r.ok)throw new Error('http');const body=await r.text();if(body.length>2500000)throw new Error('size');return body;
  }catch(error){
    const reason=status>=400?'（HTTP '+status+'）':/timeout|timed out|abort/i.test(String(error))?'（连接超时）':'';
    const failure=new Error(label+'暂未响应'+reason+'，请重试或换一条播放线路');
    if(error?.stack)failure.stack+='\nCaused by: '+String(error.stack);
    throw failure;
  }finally{clearTimeout(timer);}
}
async function topics(networkContext){
  if(topicCache&&Date.now()-topicCache.at<300000)return topicCache.values;
  try{const dom=parsePublicHtml(await request(new URL('/topic',HOME).href,{networkContext})),seen=new Set(),values=[];
    for(const n of nodes(dom,n=>n.tag==='a'&&/^\/topicdetail-\d+\.html$/.test(n.attrs.href||''))){
      const id=n.attrs.href.match(/\d+/)[0],name=text(n.attrs.title||nodeText(n),100);
      if(!name)continue;
      const coverUrl=imageUrl(n.attrs['data-original']||'');
      const previous=values.find(v=>v.id==='topic:'+id);
      if(previous){if(coverUrl)previous.coverUrl=coverUrl;continue;}
      seen.add(id);values.push({id:'topic:'+id,parentId:'topics',name,coverUrl});
    }
    if(values.length)topicCache={at:Date.now(),values};return values;
  }catch(_){return topicCache?.values||[];}
}
function updateGenres(snapshot){
  const groups=new Map();
  for(const link of snapshot.links){
    let u;try{u=new URL(link.href);}catch(_){continue;}
    if(u.origin!==new URL(HOME).origin||!u.pathname.startsWith('/show/'))continue;
    const parts=u.pathname.slice(6).replace(/\.html$/,'').split('-');
    if(!types.some(t=>t[0]===parts[0])||!parts[3])continue;
    let genre;try{genre=decodeURIComponent(parts[3]);}catch(_){continue;}
    if(genre.length>15||text(link.label)!==genre)continue;
    if(!groups.has(parts[0]))groups.set(parts[0],new Map());
    groups.get(parts[0]).set(genre,{id:`genre:${parts[0]}:${genre}`,parentId:`type:${parts[0]}`,name:genre});
  }
  for(const [type,values]of groups)genreCache.set(type,[...values.values()]);
}
async function categories(snapshot,networkContext){
  updateGenres(snapshot);
  const seasonal=await topics(networkContext);
  const seen=new Set(seasonal.map(x=>x.id));
  for(const link of snapshot.links){const m=new URL(link.href).pathname.match(/^\/topicdetail-(\d+)\.html$/);
    if(m&&!seen.has('topic:'+m[1])&&text(link.label)){seen.add('topic:'+m[1]);seasonal.push({id:'topic:'+m[1],parentId:'topics',name:text(link.label,100)});}}
  return [
    ...types.map(([id,name])=>({id:'type:'+id,parentId:'0',name})),
    {id:'week',parentId:'0',name:'周更',selectable:false},
    {id:'rank',parentId:'0',name:'榜单',selectable:false},
    {id:'topics',parentId:'0',name:'专题',selectable:false},
    ...[...genreCache.values()].flat(),
    ...days.map((name,index)=>({id:'week:'+index,parentId:'week',name})),
    ...ranks.map(([id,name])=>({id:'rank:'+id,parentId:'rank',name})),...seasonal.slice(0,100),
  ];
}
function catalogRequest(args){
  const query=text(args.query,100),type=text(args.typeId,100),year=text(args.year,4);
  const page=Number(args.page)||1;
  if(!Number.isInteger(page)||page<1||page>10000)throw new Error('无效页码');
  const browse=text(args.browseUrl,4096),sort=text(args.sort,20),signature=JSON.stringify([query,type,year,browse,sort]);
  if(sort&&!['time','hits','score'].includes(sort))throw new Error('无效排序');
  if(sort&&(query||browse||!/^type:|^genre:/.test(type)))throw new Error('请先选择可排序分类');
  if(page>1){const c=args.cursor;if(c?.version!==1||c.signature!==signature||c.page!==page-1||typeof c.nextUrl!=='string')throw new Error('分页已更新，请刷新');return {url:pageUrl(c.nextUrl),page,signature,query,type,year};}
  let path='/',genre='',typeNumber='';
  if(browse){
    const u=new URL(pageUrl(browse));
    if(query||type||year||!u.pathname.startsWith('/search/'))throw new Error('人物检索条件已变化，请重新打开');
    return {url:u.href,page,signature,query,type,year};
  }
  if(query){if(type||year)throw new Error('源站搜索不支持叠加分类，请清除筛选');const u=new URL('/search/-------------.html',HOME);u.searchParams.set('wd',query);return {url:u.href,page,signature,query,type,year};}
  if(type.startsWith('type:'))typeNumber=type.slice(5);
  else if(type.startsWith('genre:')){const m=type.match(/^genre:(\d+):(.+)$/);if(!m)throw new Error('无效分类');typeNumber=m[1];genre=m[2];}
  else if(/^week:[0-6]$/.test(type))path='/week';
  else if(ranks.some(([id])=>type==='rank:'+id))path='/'+type.slice(5);
  else if(/^topic:\d+$/.test(type))path='/topicdetail-'+type.slice(6)+'.html';
  else if(type)throw new Error('请选择具体分类');
  if(typeNumber){
    if(!types.some(([id])=>id===typeNumber)||year&&!/^(19|20)\d{2}$/.test(year))throw new Error('无效筛选条件');
    if(!genre&&!year&&!sort)path='/type/'+typeNumber+'.html';
    else path='/show/'+[typeNumber,'',sort,encodeURIComponent(genre),'','','','','','','',year].join('-')+'.html';
  }else if(year)throw new Error('请先选择分类再筛选年份');
  return {url:pageUrl(path),page,signature,query,type,year};
}
function card(raw){
  const url=https(raw.href);const u=new URL(url),m=u.pathname.match(/^\/anime\/([a-f0-9]{16,64})\.html$/);
  if(u.origin!==new URL(HOME).origin||!m)throw new Error('无效作品链接');
  const subtitle=text(raw.subtitle),year=subtitle.match(/\b(?:19|20)\d{2}\b/)?.[0]||'';
  return {id:workId(m[1]),title:text(raw.title),detailUrl:url,coverUrl:imageUrl(raw.coverUrl),year,
    language:subtitle.replace(/\/(?:19|20)\d{2}/,'').trim(),remarks:text(raw.remarks,100)};
}
async function getLibrary(args={}){
  requireClient(args);
  if(args.typeId==='recent:feed'){
    if((Number(args.page)||1)!==1 || args.sort || args.query || args.year)throw new Error('近期订阅源只包含一个更新窗口');
    const xml=await request(new URL('/rss/index.xml',HOME).href,{networkContext:args.networkContext});
    if(!/<rss\b/i.test(xml))throw new Error('近期更新暂不可用，请重试');
    const field=(body,name)=>{
      const raw=body.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([^]*?)</'+name+'>','i'))?.[1]||'';
      return htmlText(raw.replace(/^\s*<!\[CDATA\[([^]*?)\]\]>\s*$/,'$1'));
    };
    const items=[],seen=new Set();
    for(const m of xml.matchAll(/<item(?:\s[^>]*)?>([^]*?)<\/item>/gi)){
      try{const value=card({href:field(m[1],'link'),title:field(m[1],'title'),remarks:field(m[1],'pubDate')});
        if(seen.has(value.id))continue;seen.add(value.id);
        items.push({...value,description:field(m[1],'description'),updatedAt:field(m[1],'pubDate')});
      }catch(_){} if(items.length>=60)break;
    }
    if(!items.length)throw new Error('近期更新结构暂未识别');
    return {source:ID,data:{items,categories:[],page:1,pageCount:1,total:items.length,totalKnown:true,
      heading:'最近更新',description:'原站最近 '+items.length+' 条更新，不包含全部作品；未列出不代表没有更新。'}};
  }
  const requested=catalogRequest(args),snapshot=args.browserSnapshot;
  if(!snapshot)return {source:ID,data:{browserRequest:{url:requested.url}}};
  if(new URL(snapshot.url).href!==requested.url||!Array.isArray(snapshot.cards)||!Array.isArray(snapshot.links))throw new Error('片库结果与当前请求不一致');
  const items=[],seen=new Set();
  const candidates=requested.type.startsWith('week:')?snapshot.cards.filter(c=>c.group===requested.type.slice(5)):snapshot.cards;
  for(const raw of candidates.slice(0,200)){try{const item=card(raw);if(item.title&&!seen.has(item.id)){seen.add(item.id);items.push(item);}}catch(_){}}
  if(!items.length&&!snapshot.empty&&!(requested.type.startsWith('week:')&&snapshot.groups?.includes(requested.type.slice(5))))throw new Error('网页结构暂未识别，请重试');
  let nextUrl='',pageCount=requested.page;
  const paging=requested.type.startsWith('week:')||requested.type.startsWith('rank:')?[]:snapshot.links;
  for(const link of paging){
    if(!['下一页','尾页'].includes(text(link.label)))continue;
    const url=pageUrl(link.href),n=Number(new URL(url).pathname.match(/-(\d+)---\.html$/)?.[1]||new URL(url).pathname.match(/\/type\/\d+-(\d+)\.html$/)?.[1]);
    if(n>pageCount)pageCount=n;
    if(text(link.label)==='下一页'&&url!==requested.url&&(!n||n>requested.page))nextUrl=url;
  }
  if(nextUrl)pageCount=Math.max(pageCount,requested.page+1);
  for(const value of snapshot.pageText||[]){const m=text(value).match(/^(\d+)\s*\/\s*(\d+)$/);
    if(m&&Number(m[1])===requested.page&&Number(m[2])>=requested.page&&Number(m[2])<=10000)pageCount=Number(m[2]);}
  const cats=await categories(snapshot,args.networkContext),current=cats.find(x=>x.id===requested.type);
  return {source:ID,data:{items,categories:cats,page:requested.page,pageCount,total:items.length,totalKnown:false,
    heading:current?.name||'发现',description:text(snapshot.topicDescription,1500),
    nextCursor:nextUrl?{version:1,page:requested.page,signature:requested.signature,nextUrl}:null}};
}
async function getItem(args={}){
  requireClient(args);const id=workId(args.id),old=details.get(id);
  const snapshot=args.browserSnapshot;
  if(!snapshot&&args.refresh!==true&&old&&Date.now()-old.at<60000)return {source:ID,data:old.item};
  if(snapshot&&(snapshot.kind!=='public-detail'||snapshot.url!==detailUrl(id)||snapshot.verification===true||
      typeof snapshot.html!=='string'||snapshot.html.length>2000000))throw new Error('作品详情需要重新读取，请重试');
  const source=snapshot?snapshot.html:await request(detailUrl(id),{networkContext:args.networkContext}),dom=parsePublicHtml(source);
  const title=nodeText(nodes(dom,n=>n.tag==='h1')[0]);if(!title||/安全验证/.test(title))throw new Error('作品详情暂不可用');
  const labels=new Map();
  for(const n of nodes(dom,n=>n.tag==='a'&&/^#playlist\d+$/.test(n.attrs.href||'')))labels.set(n.attrs.href.slice(9),nodeText(n).replace(/\d+$/,'').trim());
  const lineMap=new Map();
  for(const n of nodes(dom,n=>n.tag==='a'&&n.attrs.href?.includes('/play/'))){
    const address=https(n.attrs.href,detailUrl(id));if(!address)continue;
    const parsed=new URL(address);if(parsed.origin!==new URL(HOME).origin)continue;
    const m=parsed.pathname.match(/^\/anime\/([a-f0-9]{16,64})\/play\/(\d+)\/(\d+)\.html$/);if(!m||m[1]!==id)continue;
    // Skip the hero's generic Play link: the actual list supplies the label.
    const name=nodeText(n);if(/立即播放|在线播放/.test(name))continue;
    const line=m[2],episode=m[3];if(!lineMap.has(line))lineMap.set(line,{id:line,label:labels.get(line)||'线路 '+line,episodes:[]});
    const value=lineMap.get(line);if(value.episodes.some(e=>e.id===episode))continue;
    value.episodes.push({id:episode,title:text(name,200)||'第'+episode+'集',resolveOnPlayback:true,
      watchUrl:watchUrl(id,line,episode),webPlaybackUrls:[address]});
  }
  // The site's actual episode links define both available lines and their order.
  // A named preference can hide a new provider or disagree with the web player.
  const lines=[...lineMap.values()].filter(l=>l.episodes.length);
  const info=nodes(dom,n=>n.tag==='p'&&hasClass(n,'data')).map(nodeText);
  const field=name=>info.map(v=>v.match(new RegExp('(?:^| / )'+name+'[:：]\\s*(.*?)(?: / |$)'))?.[1]).find(Boolean)||'';
  const synopsis=nodes(dom,n=>n.tag==='p'&&hasClass(n,'desc'))[0];
  const fullSynopsis=nodes(synopsis,n=>hasClass(n,'detail-content'))[0];
  // The source nests the full synopsis after its shortened excerpt (sometimes
  // inside malformed spanclass markup). Use that semantic node exclusively.
  let description=(nodeText(fullSynopsis)||nodeText(synopsis)).replace(/^简介[:：]\s*/,'').replace(/详情$/,'').trim();
  if(/^剧情简介暂缺|^暂无简介/.test(description))description='';
  const meta=nodes(dom,n=>n.tag==='meta'&&n.attrs.property==='og:image')[0];
  const cover=nodes(dom,n=>n.tag==='img'&&n.attrs['data-original'])[0]||nodes(dom,n=>n.tag==='a'&&n.attrs['data-original'])[0];
  const actors=nodes(dom,n=>n.tag==='p'&&nodeText(n).startsWith('声优：'))[0];
  const actorNames=actors?nodes(actors,n=>n.tag==='a').map(nodeText).filter(Boolean).join('、'):field('声优');
  const favorite=nodes(dom,n=>hasClass(n,'mac_favorites')&&n.attrs['data-mid']==='1')[0];
  const vodId=/^[1-9]\d{0,14}$/.test(favorite?.attrs['data-id']||'')?favorite.attrs['data-id']:'';
  const credits=[],creditSeen=new Set();
  for(const p of nodes(dom,n=>n.tag==='p'&&/^(声优|导演)[:：]/.test(nodeText(n)))){
    const role=nodeText(p).startsWith('声优')?'voice':'director';
    for(const a of nodes(p,n=>n.tag==='a'&&n.attrs.href)){
      const url=https(a.attrs.href),name=text(nodeText(a),100);
      if(!url||new URL(url).origin!==new URL(HOME).origin||!new URL(url).pathname.startsWith('/search/')||!name||creditSeen.has(role+'|'+url))continue;
      creditSeen.add(role+'|'+url);credits.push({name,role,url});
    }
  }
  const related=[],relatedSeen=new Set([id]);
  for(const heading of nodes(dom,n=>n.tag==='h4')){
    const a=nodes(heading,n=>n.tag==='a'&&n.attrs.href)[0];if(!a)continue;
    const root=heading.parent?.parent||heading.parent,cover=nodes(root,n=>n.attrs['data-original']||n.attrs['data-src'])[0];
    try{const value=card({href:https(a.attrs.href),title:a.attrs.title||nodeText(a),coverUrl:cover?.attrs['data-original']||cover?.attrs['data-src']||''});
      if(value.title&&!relatedSeen.has(value.id)){relatedSeen.add(value.id);related.push(value);}
    }catch(_){}if(related.length>=24)break;
  }
  const discussion=nodes(dom,n=>n.tag==='a'&&n.attrs.href).map(n=>https(n.attrs.href)).find(raw=>{
    if(!raw||!vodId)return false;const u=new URL(raw);return u.origin===new URL(HOME).origin&&u.pathname==='/square.html'&&u.searchParams.get('vod_id')===vodId;
  })||'';
  const item={id,title:text(title),detailUrl:detailUrl(id),coverUrl:imageUrl(meta?.attrs.content||cover?.attrs['data-original']||''),description:text(description,20000),
    genres:field('类型'),area:field('地区'),year:field('年份'),language:field('语言'),remarks:field('状态'),
    directors:field('导演')==='未知'?'':field('导演'),actors:text(actorNames,3000),updatedAt:field('更新'),
    finished:/完结/.test(field('状态')),vodId,credits,related,discussionUrl:discussion,lines};
  details.set(id,{at:Date.now(),item});if(details.size>32)details.delete(details.keys().next().value);
  return {source:ID,data:item};
}
function publicPlayerUrl(raw,base){
  const value=https(raw,base);if(!value)throw new Error('播放器返回了不可用地址');
  const url=new URL(value),host=url.hostname.toLowerCase();
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||
    !host.includes('.')||/^\[|^\d+(?:\.\d+){3}$/.test(host))throw new Error('播放器返回了不可用地址');
  return url.href;
}
function sourcePlayUrl(player){
  const encoding=Number(player.encrypt),raw=String(player.url||'');
  if(![0,1,2].includes(encoding)||!raw||raw.length>20000)throw new Error('源站播放地址格式暂未支持');
  if(encoding===0)return raw;
  // MacCMS uses its public escape/base64 URL wrapper, not media encryption.
  let value=raw;
  if(encoding===2){
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)||raw.length%4===1)throw new Error('源站播放地址编码无效');
    try{value=atob(raw);}catch(_){throw new Error('源站播放地址编码无效');}
  }
  // Match legacy unescape including %uXXXX, without executing any site code.
  return value.replace(/%u([a-fA-F0-9]{4})|%([a-fA-F0-9]{2})/g,(_,wide,byte)=>
    String.fromCharCode(parseInt(wide||byte,16)));
}
// Parse the observed encoded-query template without evaluating source scripts.
function encodedPlayerPairs(script,player,context,item){
  if(!/pairs\.join\(/.test(script))return undefined;
  const object=/\bvar\s+values\s*=\s*\{([\s\S]*?)\}\s*;/.exec(script);
  const expected={
    url:"MacPlayer.PlayUrl||''",
    dmid:"(window.d4ddy||{}).dmid||(window.dataflow||{}).dmid||(window.maccms||{}).dmid||MacPlayer.Id||data.id||''",
    next:"MacPlayer.PlayLinkNext||''",name:"MacPlayer.PlayName||(data.vod_data||{}).vod_name||''",
    sid:"MacPlayer.Sid||data.sid||''",nid:"MacPlayer.Nid||data.nid||''",ph:'ph',h:'window.location.origin',pic:'pic',
  };
  if(!object||!script.replace(/\s+/g,'').includes("pairs.push(key+'='+encodeURIComponent(String(values[key])))"))throw new Error('播放器模板暂未支持');
  const fields=object[1].trim().split(/,\s*(?=[a-z]+\s*:)/).map(field=>{
    const match=/^([a-z]+)\s*:([\s\S]*)$/.exec(field.trim());
    if(!match||expected[match[1]]!==match[2].replace(/\s+/g,''))throw new Error('播放器模板暂未支持');
    return match[1];
  });
  if(fields.length!==Object.keys(expected).length||new Set(fields).size!==fields.length)throw new Error('播放器模板暂未支持');
  const imageBase=/\bvar\s+imageBase\s*=\s*(['"])(https:\/\/[^'"\s]+)\1\s*;/.exec(script)?.[2];
  if(!imageBase)throw new Error('播放器模板暂未支持');
  let pic=String(player.vod_data?.vod_pic||'').trim(),ph=imageBase;
  if(/^mac:\/\//i.test(pic)){
    const bare=pic.replace(/^mac:\/\//i,'').replace(/^\/+/,'');
    const upload=bare.match(/(?:^|\/)upload\/.*$/i);
    pic=upload?upload[0].replace(/^\/+/,''):'https://'+bare.replace(/^([^/]+)\/+/, '$1/');
  }
  if(/^\/\//.test(pic))pic='https:'+pic;
  if(/^https?:\/\//i.test(pic))ph='';else pic=pic.replace(/^\/+/,'');
  if(!pic)ph='';
  const values={url:sourcePlayUrl(player),dmid:context.dmid||player.id||'',next:player.link_next||'',
    name:player.vod_data?.vod_name||item.title||'',sid:player.sid||'',nid:player.nid||'',ph,h:new URL(HOME).origin,pic};
  return fields.map(key=>key+'='+encodeURIComponent(String(values[key])));
}
function playerTemplateValue(script,values){
  if(typeof script!=='string'||script.length>100000)throw new Error('播放器模板暂未支持');
  const start=/\bMacPlayer\.Html\s*=\s*/.exec(script);
  if(!start)throw new Error('播放器模板暂未支持');
  let position=start.index+start[0].length,count=0,output='';
  const literal=()=>{
    const quote=script[position++];let result='';
    while(position<script.length){
      const c=script[position++];if(c===quote)return result;
      if(c==='\n'||c==='\r')throw new Error('播放器模板暂未支持');
      if(c!=='\\'){result+=c;continue;}
      const escape=script[position++],simple={'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f','v':'\v','0':'\0'};
      if(escape==='x'||escape==='u'){
        const size=escape==='x'?2:4,hex=script.slice(position,position+size);
        if(!new RegExp('^[a-fA-F0-9]{'+size+'}$').test(hex))throw new Error('播放器模板暂未支持');
        result+=String.fromCharCode(parseInt(hex,16));position+=size;
      }else if(escape in simple)result+=simple[escape];
      else if(["'",'"','\\','/'].includes(escape))result+=escape;
      else throw new Error('播放器模板暂未支持');
    }
    throw new Error('播放器模板暂未支持');
  };
  while(position<script.length&&count++<64){
    while(/\s/.test(script[position]||'')&&position<script.length)position++;
    if(script[position]==="'"||script[position]==='"')output+=literal();
    else if(/^pairs\.join\(/.test(script.slice(position))){
      const join=/^pairs\.join\((['"])(&amp;|&)\1\)/.exec(script.slice(position));
      if(!join||!Array.isArray(values.encodedPairs))throw new Error('播放器模板暂未支持');
      output+=values.encodedPairs.join(join[2]);position+=join[0].length;
    }else{
      const name=/^(?:MacPlayer\.[A-Za-z]+|d4ddy\.dmid|window\.location\.origin)/.exec(script.slice(position))?.[0];
      if(!name||!Object.prototype.hasOwnProperty.call(values,name)||values[name]===undefined)throw new Error('播放器模板暂未支持');
      output+=String(values[name]??'');position+=name.length;
    }
    while(/\s/.test(script[position]||'')&&position<script.length)position++;
    if(script[position]===';')return output;
    if(script[position++]!=='+')throw new Error('播放器模板暂未支持');
  }
  throw new Error('播放器模板暂未支持');
}
async function playerFrame(player,context,item,episode,refresh=false,networkContext){
  const from=String(player.from||'');
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(from))throw new Error('源站播放器标识无效');
  const url=new URL('/static/player/'+from+'.js',HOME).href,old=playerTemplates.get(url);
  const script=!refresh&&old&&Date.now()-old.at<60000?old.body:await request(url,{label:'播放器配置',networkContext});
  playerTemplates.set(url,{at:Date.now(),body:script});if(playerTemplates.size>16)playerTemplates.delete(playerTemplates.keys().next().value);
  const html=playerTemplateValue(script,{
    encodedPairs:encodedPlayerPairs(script,player,context,item),
    'MacPlayer.PlayUrl':sourcePlayUrl(player),'MacPlayer.PlayLinkNext':player.link_next||'',
    'MacPlayer.PlayName':player.vod_data?.vod_name||item.title,'MacPlayer.Nid':player.nid,
    'MacPlayer.Pic':player.vod_data?.vod_pic||'','d4ddy.dmid':context.dmid,
    'window.location.origin':new URL(HOME).origin,
  });
  const frames=nodes(parsePublicHtml(html),n=>n.tag==='iframe'&&n.attrs.src);
  if(frames.length!==1)throw new Error('播放器模板暂未支持，请在网页继续');
  return publicPlayerUrl(frames[0].attrs.src,episode.webPlaybackUrls[0]);
}
function playerHelperUrl(html,frame){
  const candidates=[];
  for(const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*>/gi)){
    let value;try{value=new URL(htmlText(match[1]),frame);}catch(_){continue;}
    if(value.pathname.endsWith('/common.js'))candidates.push(publicPlayerUrl(value.href,frame));
  }
  if(candidates.length!==1)throw new Error('播放器URL解析脚本暂未识别，请在网页继续');
  return candidates[0];
}
async function helper(url,refresh=false,networkContext){if(!refresh&&helperCache&&helperCache.url===url&&Date.now()-helperCache.at<300000)return helperCache.body;
  const body=await request(url,{label:'解析脚本',networkContext});helperCache={url,at:Date.now(),body};return body;}
function rawHlsUrl(player){
  try{const raw=sourcePlayUrl(player);if(raw.length>4096||!/^https:\/\//i.test(raw))return '';
    const value=publicPlayerUrl(raw,HOME),url=new URL(value);
    return /\.m3u8$/i.test(url.pathname)?value:'';
  }catch(_){return '';}
}
function noMediaReferrer(iframe){
  const referrer=nodes(parsePublicHtml(iframe||''),n=>n.tag==='meta'&&
    String(n.attrs.name||'').toLowerCase()==='referrer')[0]?.attrs.content?.toLowerCase();
  return referrer==='never'||referrer==='no-referrer';
}
function rawHlsHeaders(iframe,episode){
  const headers={};
  // The observed official iframe explicitly says referrer=never. Preserve
  // that public policy instead of inventing a Referer or copying a session.
  if(noMediaReferrer(iframe)||mediaReferrerPolicies.get(episode.watchUrl)===true)return headers;
  // Only the known main-site origin is supported by the current native header
  // contract. An unknown parser policy is not permission to invent its origin.
  headers.Referer=new URL(episode.webPlaybackUrls[0]).origin+'/';
  return headers;
}
async function verifyRawHls(url,headers,networkContext){
  const maximum=512*1024,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);
  try{
    const response=await networkFetch(url,{method:'GET',headers,credentials:'omit',signal:controller.signal,timeout:4000},networkContext);
    if(!response.ok||response.status!==200)return false;
    const contentType=response.headers?.get?.('content-type')||'';
    if(/(?:text\/html|application\/(?:json|problem\+json))/i.test(contentType))return false;
    const length=response.headers?.get?.('content-length');
    if(length&&(!/^\d+$/.test(length)||Number(length)>maximum))return false;
    // The current host fetch buffers responses. This is a candidate acceptance
    // limit plus a request deadline, not a claim of streaming transport cutoff.
    const body=await response.text();
    if(new TextEncoder().encode(body).length>maximum)return false;
    const value=body.replace(/^\uFEFF/,'').trimStart();
    if(!/^#EXTM3U(?:\r?\n|$)/.test(value)||/<(?:!doctype|html|body)\b/i.test(value))return false;
    if(!/^#EXT(?:INF:|-X-STREAM-INF:)/m.test(value))return false;
    return value.split(/\r?\n/).some(line=>line.trim()&&!line.trim().startsWith('#'));
  }catch(_){return false;}
  finally{clearTimeout(timer);}
}
async function getSession(args={}){
  if(args.rawHlsRecovery===true&&(!text(args.lineId,160)||!text(args.episodeId,300)))throw new Error('请指定恢复的线路和分集');
  requireClient(args);
  // Refresh resolves fresh media tokens, not an anonymous copy of the detail.
  // Once a browser-backed detail expires, ask the host for the same public
  // page in its existing session. The host permits only one such round trip.
  const work=workId(args.id),cached=details.get(work);
  if(args.browserDetailTransport===true&&!args.browserSnapshot&&(!cached||Date.now()-cached.at>=60000)){
    return {source:ID,data:{browserDetailRequest:{url:detailUrl(work)}}};
  }
  const {data:item}=await getItem({...args,refresh:false}),line=args.lineId?item.lines.find(l=>l.id===args.lineId):item.lines[0];
  if(!line)throw new Error('这条播放线路已不可用');const episode=args.episodeId?line.episodes.find(e=>e.id===args.episodeId):line.episodes[0];
  if(!episode)throw new Error('这一集已不可用，请刷新剧集');
  const source=await request(episode.webPlaybackUrls[0],{networkContext:args.networkContext}),player=jsonAssignment(source,'player_aaaa');
  if(String(player.id)!==item.id||String(player.sid)!==line.id||String(player.nid)!==episode.id)throw new Error('源站返回了其他分集，已保留当前视频');
  const session=(url,headers)=>({source:ID,data:{item,lineId:line.id,episodeId:episode.id,watchUrl:episode.watchUrl,
    sources:[{url,quality:line.label,headers}]}});
  if(args.rawHlsRecovery===true){
    const raw=rawHlsUrl(player);if(!raw)throw new Error('这条线路没有可验证的原始HLS地址');
    // Match the verified direct path. The source HTML's referrer policy does
    // not describe its cross-origin player iframe, so do not invent a Referer.
    const headers={};
    if(!await verifyRawHls(raw,headers,args.networkContext))throw new Error('原始媒体暂不可用，请选择其他线路');
    return session(raw,headers);
  }
  // The public play page often already supplies a usable HLS URL. Do not make
  // every line wait for the same optional parser before trying that media.
  const direct=rawHlsUrl(player),directHeaders={};
  if(direct&&await verifyRawHls(direct,directHeaders,args.networkContext))return session(direct,directHeaders);
  const context=/\bd4ddy\s*=\s*/.test(source)?jsonAssignment(source,'d4ddy'):{};
  let frame='',iframe='';
  mediaReferrerPolicies.delete(episode.watchUrl);
  try{
    frame=await playerFrame(player,context,item,episode,args.refresh===true,args.networkContext);
    // A parser origin serves independent providers and episodes. A timeout for
    // one request must not reject a different line before it is even fetched.
    // Keep the cooldown scoped to the same public episode and parser endpoint;
    // do not retain signed iframe query data in the failure cache.
    const parserUrl=new URL(frame),parserRequest=(args.networkContext||'legacy')+'|'+episode.watchUrl+'|'+parserUrl.origin+parserUrl.pathname;
    if(args.refresh!==true&&(unavailableParsers.get(parserRequest)||0)>Date.now())throw new Error('播放解析服务暂未响应');
    try{iframe=await request(frame,{label:'播放解析服务',timeout:18000,networkContext:args.networkContext});unavailableParsers.delete(parserRequest);}
    catch(error){
      if(/连接超时/.test(error.message)){unavailableParsers.set(parserRequest,Date.now()+30000);
        if(unavailableParsers.size>16)unavailableParsers.delete(unavailableParsers.keys().next().value);}
      throw error;
    }
    let media;
    // Keep only the public no-referrer policy for later explicit same-episode
    // recovery; never retain iframe URLs, signed tokens, cookies or account data.
    mediaReferrerPolicies.set(episode.watchUrl,noMediaReferrer(iframe));
    if(mediaReferrerPolicies.size>64)mediaReferrerPolicies.delete(mediaReferrerPolicies.keys().next().value);
    if(/\burl:\s*playData\(/.test(iframe)){
      const url=playerHelperUrl(iframe,frame);
      try{media=await unwrapPublicPlayerUrl(await helper(url,false,args.networkContext),iframe);}catch(_){media=await unwrapPublicPlayerUrl(await helper(url,true,args.networkContext),iframe);}
    }else media=https(iframe.match(/\burl:\s*['"]([^'"]+)['"]/)?.[1]||'');
    if(!media)throw new Error('未取得有效媒体地址，请换一条线路');
    return session(media,{});
  }catch(error){
    const raw=rawHlsUrl(player);
    if(raw&&iframe){try{const headers=rawHlsHeaders(iframe,episode);
      if(JSON.stringify(headers)!==JSON.stringify(directHeaders)&&await verifyRawHls(raw,headers,args.networkContext))return session(raw,headers);
    }catch(_){/* Preserve the original parser failure even if metadata is malformed. */}}
    // A rejected, timed out, or non-HLS origin does not turn a parser failure
    // into a successful line. Keep the original cause and the same episode.
    throw error;
  }
}
async function getItems(args={}){requireClient(args);if(!Array.isArray(args.ids)||args.ids.length<1||args.ids.length>20)throw new Error('每次检查1至20部作品');
  const ids=[...new Set(args.ids.map(workId))],items=[];
  for(let i=0;i<ids.length;i+=3){const batch=await Promise.all(ids.slice(i,i+3).map(id=>getItem({...args,id,refresh:true})));items.push(...batch.map(r=>r.data));}
  return {source:ID,data:{items,missingIds:[]}};}
function getInfo(){
  const payload={source:ID,title:omoConfig.name,url:HOME,protocol:2,nativeSearch:true,
    capabilities:omoConfig.capabilities,catalogFnPath:'getLibrary',detailFnPath:'getItem',playbackFnPath:'getSession',batchDetailFnPath:'getItems'};
  return {name:omoConfig.name,uuid:ID,version:omoConfig.version,home:'https://github.com/kl5212840-lang/Breeze-plugins',websiteUrl:HOME,
  routing:{version:1,siteOrigins:[new URL(HOME).origin],mediaHosts:'runtime'},
  iconUrl:omoConfig.iconUrl,updateUrl:'https://raw.githubusercontent.com/kl5212840-lang/Breeze-plugins/main/updates/omofun.json',
  describe:'动漫片库、完整搜索、分类筛选、周更专题与原生多线路播放。本机收藏与续播；需配套支持视频协议2的Breeze。',
  function:[{id:'library',title:'发现',action:{type:'openVideoLibrary',payload}}]};}
function getSettingsBundle(){return {source:ID,data:{mediaType:'video',canLogin:false,canShowUserInfo:false,values:{},sections:[]}};}
module.exports={getInfo,getLibrary,getItem,getSession,getItems,getSettingsBundle};

;(() => { const plugin = module.exports.default ?? module.exports; const original = plugin.getInfo; const metadata = {"version":"0.1.0","releaseSeries":1,"updateUrl":"https://raw.githubusercontent.com/kl5212840-lang/Breeze-plugins/main/updates/v1/omofun.json","npmName":"","requirements":{"version":1,"capabilities":{"videoLibraryProtocol":2}}}; plugin.getInfo = function(...args) { const result = original.apply(this, args); const decorate = info => ({...info, ...metadata}); return result && typeof result.then === 'function' ? result.then(decorate) : decorate(result); }; })();
