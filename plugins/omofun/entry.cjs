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
