'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const id='3d7144c241243398fd28b0e2',home='https://www.omofuna.com';
const args={clientProtocol:2};
const template=`MacPlayer.Html = '<iframe src="https://art.v2player.top:8989/player/?url='+MacPlayer.PlayUrl+'&dmid='+d4ddy.dmid+'&nid='+MacPlayer.Nid+'"></iframe>'; MacPlayer.Show();`;
function fresh(){if(process.env.OMO_TEST_SOURCE==='1')return freshSource();const file=require.resolve('./omofun-native.cjs');delete require.cache[file];return require(file);}
function freshSource(){
  const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
  const common=path.join(__dirname,'../video-common');
  const sources=['public-html.cjs','public-player-url.cjs'].map(name=>
    fs.readFileSync(path.join(common,name),'utf8').replace(/module\.exports=\{[^\n]+\};\s*$/,''));
  const config=JSON.parse(fs.readFileSync(path.join(__dirname,'source.json'),'utf8'));
  const file=path.join(__dirname,'omofun-native.cjs'),mod=new Module(file,module);
  mod.filename=file;mod.paths=module.paths;
  mod._compile(sources.join('\n')+'\nconst omoConfig='+JSON.stringify(config)+';\n'+fs.readFileSync(path.join(__dirname,'entry.cjs'),'utf8'),file);
  return mod.exports;
}
function snapshot(url,cards=[]){return {url,cards,links:[],pageText:[]};}
const card={href:`${home}/anime/${id}.html`,title:'作品',coverUrl:'https://images.example/cover.webp',subtitle:'日语/2026',remarks:'10集'};
const detail=`<h1>作品</h1><meta property="og:image" content="https://images.example/cover.webp">
<a href="#playlist2">天堂10</a><a href="#playlist1">精品10</a>
<p class="data">类型：冒险 / 年份：2026 / 状态：更新至10集</p>
<p class="desc">简介：公开简介</p>
<a href="/anime/${id}/play/2/1.html">第1集</a><a href="/anime/${id}/play/1/1.html">第1集</a>
<a href="/anime/${id}/play/1/2.html">第2集</a>`;
const original=global.fetch;
test('site sorting is scoped to a supported category and included in paging identity',async()=>{
  global.fetch=async()=>({ok:true,text:async()=>''});
  const p=fresh(),base={...args,typeId:'type:1',sort:'hits'};
  const req=(await p.getLibrary(base)).data.browserRequest;
  assert.equal(new URL(req.url).pathname,'/show/1--hits---------.html');
  const data={...snapshot(req.url,[card]),links:[{label:'下一页',href:home+'/show/1--hits------2---.html'}]};
  const page=(await p.getLibrary({...base,browserSnapshot:data})).data;
  await assert.rejects(p.getLibrary({...base,sort:'score',page:2,cursor:page.nextCursor}),/分页已更新/);
  await assert.rejects(p.getLibrary({...args,query:'Title',sort:'hits'}),/可排序分类/);
});
test.afterEach(()=>{global.fetch=original;});
test('public detail snapshot is parsed without an anonymous request and invalid snapshots are rejected',async()=>{
  global.fetch=async()=>{throw new Error('anonymous transport must not run');};
  const p=fresh(),url=home+'/anime/'+id+'.html';
  const browserSnapshot={kind:'public-detail',url,html:detail};
  const item=(await p.getItem({...args,id,browserSnapshot})).data;
  assert.equal(item.lines.length,2);assert.equal(item.description,'公开简介');
  for(const changes of [{url:home+'/anime/abcdef0123456789abcdef01.html'},{verification:true},{html:42},{html:'x'.repeat(2000001)}]){
    await assert.rejects(p.getItem({...args,id,browserSnapshot:{...browserSnapshot,...changes}}));
  }
  assert.equal((await p.getItem({...args,id})).data.title,'作品');
});
test('playback requests a browser detail once when cold and media refresh retains the cached detail',async()=>{
  const p=fresh();let detailReads=0;
  global.fetch=async raw=>{
    const url=new URL(raw);let body;
    if(url.pathname===`/anime/${id}.html`){detailReads++;throw new Error('anonymous detail');}
    if(url.pathname.includes('/play/'))body='var player_aaaa='+JSON.stringify({id,sid:'1',nid:'1',from:'mp4',encrypt:0,url:'opaque',vod_data:{vod_name:'作品'}})+';var d4ddy={"dmid":17482};';
    if(url.pathname==='/static/player/mp4.js')body=template;
    if(url.host==='art.v2player.top:8989')body="const options={url:'https://media.example/fresh.mp4'};";
    return {ok:true,text:async()=>body||''};
  };
  const call={...args,id,lineId:'1',episodeId:'1',refresh:true,browserDetailTransport:true};
  const cold=(await p.getSession(call)).data;
  assert.equal(cold.browserDetailRequest.url,home+'/anime/'+id+'.html');
  const resolved=(await p.getSession({...call,browserSnapshot:{kind:'public-detail',url:cold.browserDetailRequest.url,html:detail}})).data;
  assert.equal(resolved.lineId,'1');assert.equal(resolved.episodeId,'1');
  assert.equal((await p.getSession(call)).data.sources[0].url,'https://media.example/fresh.mp4');
  assert.equal(detailReads,0);
});
test('RSS update window keeps source work identity and declares its limited coverage',async()=>{
  global.fetch=async()=>({ok:true,text:async()=>`<rss><channel><item><title><![CDATA[公开作品]]></title><link>${home}/anime/${id}.html</link><pubDate>Tue, 27 Oct 2026 10:00:00 GMT</pubDate><description>公开简介</description></item></channel></rss>`});
  const data=(await fresh().getLibrary({...args,typeId:'recent:feed'})).data;
  assert.equal(data.items[0].id,id);assert.equal(data.items[0].title,'公开作品');
  assert.equal(data.pageCount,1);assert.match(data.description,/不包含全部作品/);
});
test('full synopsis wins over the collapsed excerpt, including malformed source markup',async()=>{
  global.fetch=async()=>({ok:true,text:async()=>detail.replace(
    '<p class="desc">简介：公开简介</p>',
    '<p class="desc"><span class="left">简介：</span><spanclass="detail-sketch">摘要片段<span class="detail-content" style="display:none">这是完整简介，只有一份。</span><a class="detail-more">详情</a></p>'
  )});
  const item=(await fresh().getItem({...args,id})).data;
  assert.equal(item.description,'这是完整简介，只有一份。');
});
test('source recommendations, cast links and discussion retain their real identities',async()=>{
  const other='abcdef0123456789abcdef01';
  global.fetch=async()=>({ok:true,text:async()=>detail+
    '<a class="mac_favorites sc" data-mid="1" data-id="18454"></a>'+
    '<p class="data">声优：<a href="/search/-%E5%8D%97%E6%9D%A1------------.html">南条</a></p>'+
    '<a href="/square.html?vod_id=18454">进入作品讨论 (0)</a>'+
    `<div><a data-original="https://images.example/recommend.webp"></a><div><h4><a href="/anime/${other}.html">相关推荐</a></h4></div></div>`+
    `<h4><a href="https://outside.example/anime/${other}.html">外站条目</a></h4>`});
  const value=(await fresh().getItem({...args,id})).data;
  assert.equal(value.vodId,'18454');
  assert.equal(value.credits[0].url,home+'/search/-%E5%8D%97%E6%9D%A1------------.html');
  assert.equal(value.credits[0].role,'voice');
  assert.equal(value.discussionUrl,home+'/square.html?vod_id=18454');
  assert.equal(value.related.length,1);assert.equal(value.related[0].id,other);
  assert.equal(value.related[0].coverUrl,'https://images.example/recommend.webp');
});
test('browser catalog retains a real paging URL and rejects stale conditions',async()=>{
  global.fetch=async()=>({ok:true,text:async()=>'<a href="/topicdetail-68.html">秋季新番</a>'});
  const p=fresh(),request=(await p.getLibrary({...args,typeId:'type:1',year:'2026'})).data.browserRequest;
  const data=snapshot(request.url,[card]);data.links=[{label:'下一页',href:`${home}/show/1--------2---2026.html`}];data.pageText=['1/8'];
  const page=(await p.getLibrary({...args,typeId:'type:1',year:'2026',browserSnapshot:data})).data;
  assert.equal(page.items[0].year,'2026');assert.equal(page.items[0].language,'日语');assert.equal(page.pageCount,8);assert.equal(page.totalKnown,false);
  const next=(await p.getLibrary({...args,typeId:'type:1',year:'2026',page:2,cursor:page.nextCursor})).data.browserRequest;
  assert.equal(next.url,data.links[0].href);
  await assert.rejects(p.getLibrary({...args,typeId:'type:2',year:'2026',page:2,cursor:page.nextCursor}),/分页已更新/);
  await assert.rejects(p.getLibrary({...args,typeId:'type:1',year:'2025',browserSnapshot:data}),/不一致/);
});
test('cast navigation preserves the observed source search URL instead of a title query',async()=>{
  const p=fresh(),url=home+'/search/-%E5%8D%97%E6%9D%A1------------.html';
  assert.equal((await p.getLibrary({...args,browseUrl:url})).data.browserRequest.url,url);
  await assert.rejects(p.getLibrary({...args,browseUrl:url,query:'wrong'}),/条件已变化/);
  await assert.rejects(p.getLibrary({...args,browseUrl:'https://outside.example/search/anything'}),/无效/);
  await assert.rejects(p.getLibrary({...args,browseUrl:home+'/user/logout'}),/无效/);
});
test('unknown empty pages fail, explicit empty searches and empty weekday groups remain valid',async()=>{
  global.fetch=async()=>({ok:true,text:async()=>''});const p=fresh();
  const req=(await p.getLibrary({...args,query:'unknown'})).data.browserRequest;
  await assert.rejects(p.getLibrary({...args,query:'unknown',browserSnapshot:snapshot(req.url)}),/结构暂未识别/);
  assert.equal((await p.getLibrary({...args,query:'unknown',browserSnapshot:{...snapshot(req.url),empty:true}})).data.items.length,0);
  const week={...snapshot(home+'/week',[{...card,group:'1'}]),groups:['0','1']};
  assert.equal((await p.getLibrary({...args,typeId:'week:0',browserSnapshot:week})).data.items.length,0);
  assert.equal((await p.getLibrary({...args,typeId:'week:1',browserSnapshot:week})).data.items.length,1);
});
test('details contain unresolved episodes, playback refresh resolves the requested identity only',async()=>{
  let wrong=false,token=1;
  global.fetch=async raw=>{
    const url=new URL(raw);let body=detail;
    if(url.pathname.includes('/play/'))body='var player_aaaa='+JSON.stringify({id,sid:'1',nid:wrong?'1':'2',from:'mp4',encrypt:0,url:'opaque',vod_data:{vod_name:'作品'}})+';var d4ddy={"dmid":17482};';
    if(url.pathname==='/static/player/mp4.js')body=template;
    if(url.host==='art.v2player.top:8989')body=`const options={url:'https://media.example/video.mp4?token=${token}'};`;
    return {ok:true,text:async()=>body};
  };
  const p=fresh(),item=(await p.getItem({...args,id})).data;
  assert.equal(item.lines[0].id,'2');assert.equal(item.lines.find(line=>line.id==='1').episodes.length,2);
  assert.equal(item.lines[0].episodes[0].url,undefined);assert.equal(item.lines[0].episodes[0].resolveOnPlayback,true);
  const a=(await p.getSession({...args,id,lineId:'1',episodeId:'2'})).data;token=2;
  const b=(await p.getSession({...args,id,lineId:'1',episodeId:'2',refresh:true})).data;
  assert.equal(a.watchUrl,b.watchUrl);assert.notEqual(a.sources[0].url,b.sources[0].url);
  wrong=true;await assert.rejects(p.getSession({...args,id,lineId:'1',episodeId:'2'}),/其他分集/);
  await assert.rejects(p.getSession({...args,id,lineId:'1',episodeId:'3'}),/这一集已不可用/);
});
test('the observed quantum HLS protocol resolves the selected fourth line',async()=>{
  let parserInput='';
  global.fetch=async raw=>{
    const url=new URL(raw);let body=detail.replace('</h1>','</h1><a href="#playlist4">量子1</a>')+
      `<a href="/anime/${id}/play/4/1.html">第1集</a>`;
    if(url.pathname.includes('/play/'))body='var player_aaaa='+JSON.stringify({id,sid:'4',nid:'1',from:'lzm3u8',encrypt:1,
      url:encodeURIComponent('https://media.example/quantum.m3u8'),vod_data:{vod_name:'作品'}})+';var d4ddy={"dmid":17482};';
    if(url.pathname==='/static/player/lzm3u8.js')body=template;
    if(url.host==='art.v2player.top:8989'){
      parserInput=url.searchParams.get('url');body="const options={url:'https://media.example/resolved.m3u8'};";
    }
    return {ok:true,text:async()=>body};
  };
  const value=(await fresh().getSession({...args,id,lineId:'4',episodeId:'1'})).data;
  assert.equal(parserInput,'https://media.example/quantum.m3u8');
  assert.equal(value.lineId,'4');assert.equal(value.sources[0].url,'https://media.example/resolved.m3u8');
});
test('actual episode links define zero, one, three or five lines in source order',async()=>{
  for(const count of [0,1,3,5]){
    const lines=Array.from({length:count},(_,i)=>({id:String(i+7),label:['天堂','精品','量子','新来源','西瓜'][i]}));
    global.fetch=async()=>({ok:true,text:async()=>'<h1>作品</h1>'+`<a href="/anime/${id}/play/99/1.html">立即播放</a>`+lines.map((line,i)=>
      `<a href="#playlist${line.id}">${line.label}12</a><a href="${i%2?home:''}/anime/${id}/play/${line.id}/1.html">第01集</a>`).join('')+
      `<a href="https://outside.example/anime/${id}/play/66/1.html">外站</a>`});
    const p=fresh(),item=(await p.getItem({...args,id})).data;
    assert.deepEqual(item.lines.map(line=>[line.id,line.label]),lines.map(line=>[line.id,line.label]));
    if(count===0)await assert.rejects(p.getSession({...args,id}),/播放线路已不可用/);
  }
});
test('a new provider uses its observed template and endpoint instead of a fixed parser',async()=>{
  const calls=[];global.__omoExecuted=undefined;
  global.fetch=async raw=>{
    const url=new URL(raw);calls.push(url);
    let body=detail;
    if(url.pathname.includes('/play/'))body='var player_aaaa='+JSON.stringify({id,sid:'2',nid:'1',from:'new_provider_v5',encrypt:0,url:'public-video-id'})+';var d4ddy={"dmid":17482};';
    if(url.pathname==='/static/player/new_provider_v5.js')body=`globalThis.__omoExecuted=true;
      MacPlayer.Html = '<iframe src="https://new-player.example:9443/stream?id='+MacPlayer.PlayUrl+'&episode='+MacPlayer.Nid+'"></iframe>';MacPlayer.Show();`;
    if(url.hostname==='new-player.example')body="const options={url:'https://media.example/actual.m3u8'};";
    return {ok:true,text:async()=>body};
  };
  const session=(await fresh().getSession({...args,id,lineId:'2',episodeId:'1'})).data;
  assert.equal(session.sources[0].url,'https://media.example/actual.m3u8');
  assert.equal(calls.some(url=>url.pathname==='/static/player/new_provider_v5.js'),true);
  assert.equal(calls.some(url=>url.hostname==='new-player.example'&&url.searchParams.get('id')==='public-video-id'),true);
  assert.equal(calls.some(url=>url.hostname==='art.v2player.top'),false);
  assert.equal(global.__omoExecuted,undefined);
});
test('refresh reloads a changed provider template and does not require unused metadata',async()=>{
  let version=1,templates=0;
  global.fetch=async raw=>{
    const url=new URL(raw);let body=detail;
    if(url.pathname.includes('/play/'))body='var player_aaaa='+JSON.stringify({id,sid:'2',nid:'1',from:'flexible',encrypt:0,url:'opaque'})+';';
    if(url.pathname==='/static/player/flexible.js'){
      templates++;body=`MacPlayer.Html='<iframe src="https://player${version}.example/play?url='+MacPlayer.PlayUrl+'"></iframe>';MacPlayer.Show();`;
    }
    if(url.hostname.startsWith('player'))body=`const options={url:'https://media.example/version${version}.m3u8'};`;
    return {ok:true,text:async()=>body};
  };
  const p=fresh();
  await p.getSession({...args,id,lineId:'2',episodeId:'1'});version=2;
  const value=(await p.getSession({...args,id,lineId:'2',episodeId:'1',refresh:true})).data;
  assert.equal(templates,2);assert.equal(value.sources[0].url,'https://media.example/version2.m3u8');
});
test('public source URL wrappers support base64 escape and reject unknown encodings',async()=>{
  for(const encoding of [0,1,2,3]){
    let input='';const raw='https://media.example/public.m3u8';
    global.fetch=async value=>{
      const url=new URL(value);let body=detail;
      if(url.pathname.includes('/play/'))body='var player_aaaa='+JSON.stringify({id,sid:'2',nid:'1',from:'custom',encrypt:encoding,
        url:encoding===2?Buffer.from(escape(raw),'ascii').toString('base64'):encoding===1?escape(raw):raw})+';var d4ddy={"dmid":17482};';
      if(url.pathname==='/static/player/custom.js')body=template;
      if(url.hostname==='art.v2player.top'){input=url.searchParams.get('url');body="const options={url:'https://media.example/actual.m3u8'};";}
      return {ok:true,text:async()=>body};
    };
    const work=fresh().getSession({...args,id,lineId:'2',episodeId:'1'});
    if(encoding===3)await assert.rejects(work,/播放地址格式暂未支持/);
    else{await work;assert.equal(input,raw);}
  }
});
test('unknown template expressions and private frames fail explicitly without executing code',async()=>{
  const frame=value=>'MacPlayer.Html='+JSON.stringify('<iframe src="'+value+'"></iframe>')+';';
  for(const script of [
    'MacPlayer.Html=globalThis.evil();',
    'MacPlayer.Html="<video src=video.mp4></video>";',
    frame('http://127.0.0.1:8080/play'),
    frame('https://127.0.0.1/play'),
  ]){
    let external=false;
    global.fetch=async value=>{
      const url=new URL(value);let body=detail;
      if(url.pathname.includes('/play/'))body='var player_aaaa='+JSON.stringify({id,sid:'2',nid:'1',from:'changed',encrypt:0,url:'opaque'})+';var d4ddy={"dmid":17482};';
      if(url.pathname==='/static/player/changed.js')body=script;
      if(url.origin!==home)external=true;
      return {ok:true,text:async()=>body};
    };
    await assert.rejects(fresh().getSession({...args,id,lineId:'2',episodeId:'1'}),/模板暂未支持|不可用地址/);
    assert.equal(external,false);
  }
});
function rawHlsFixture(options={}){
  const raw=options.raw??'https://origin.example/current.m3u8',calls=[];
  const response=(body,status=200,headers={})=>({ok:status>=200&&status<300,status,
    headers:{get:name=>headers[name.toLowerCase()]??null},text:async()=>body});
  global.fetch=async(value,init={})=>{
    const url=new URL(value);calls.push({url:value,method:init.method||'GET',headers:{...init.headers},credentials:init.credentials,signal:init.signal});
    if(url.pathname.includes('/play/'))return response((options.sourceMeta||'')+'var player_aaaa='+JSON.stringify({id,sid:'2',nid:'1',from:'origin_source',encrypt:0,url:raw,...options.playerOverride})+';var d4ddy={"dmid":17482};');
    if(url.pathname==='/static/player/origin_source.js')return options.templateFailure?response('missing',404):response(template);
    if(url.hostname==='art.v2player.top')return options.iframe===undefined?response('parser down',503):response(options.iframe);
    if(url.origin!==home){
      if(options.originFetch)return options.originFetch(value,init);
      return response(options.body??'#EXTM3U\n#EXTINF:5,\npublic.ts\n#EXT-X-ENDLIST\n',options.status??200,options.headers);
    }
    return response(detail);
  };
  const plugin=fresh();
  return {raw,calls,plugin,play:(extra={})=>plugin.getSession({...args,id,lineId:'2',episodeId:'1',...extra})};
}
test('verified direct HLS skips the optional parser and preserves the exact line, episode and headers',async()=>{
  for(const body of ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nchild/index.m3u8\n',
    '\uFEFF#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\npublic.ts\n#EXT-X-ENDLIST\n']){
    const f=rawHlsFixture({body,headers:{'content-type':'application/vnd.apple.mpegurl'}}),session=(await f.play()).data;
    assert.equal(session.lineId,'2');assert.equal(session.episodeId,'1');assert.equal(session.sources[0].url,f.raw);
    const requests=f.calls.filter(call=>call.url===f.raw);assert.equal(requests.length,1);
    assert.equal(requests[0].method,'GET');assert.equal(requests[0].credentials,'omit');
    assert.deepEqual(session.sources[0].headers,requests[0].headers);
    assert.deepEqual(session.sources[0].headers,{});
    assert.equal(f.calls.some(call=>new URL(call.url).hostname==='art.v2player.top'),false);
    assert.equal(session.sources[0].headers.Cookie,undefined);assert.equal(session.sources[0].headers['User-Agent'],undefined);
  }
});
test('an observed no-referrer iframe keeps media and raw-HLS recovery headers empty',async()=>{
  const f=rawHlsFixture({iframe:'<meta name="referrer" content="never"><div>player unavailable</div>'});
  const data=(await f.play()).data;
  assert.deepEqual(data.sources[0].headers,{});
  assert.deepEqual(f.calls.find(call=>call.url===f.raw).headers,{});
  const success=rawHlsFixture({iframe:'<meta name="referrer" content="no-referrer"><script>const options={url:"https://media.example/actual.m3u8"};</script>'});
  assert.deepEqual((await success.play()).data.sources[0].headers,{});
  assert.equal(success.calls.some(call=>new URL(call.url).hostname==='art.v2player.top'),false);
});
test('raw HLS verification also survives a missing template without changing episode identity',async()=>{
  const f=rawHlsFixture({templateFailure:true}),data=(await f.play()).data;
  assert.equal(data.sources[0].url,f.raw);assert.equal(data.lineId,'2');assert.equal(data.episodeId,'1');
  assert.equal(f.calls.filter(call=>call.url===f.raw).length,1);
});
test('raw HLS rejects denial, HTML, JSON and excessive bodies while preserving the parser error',async()=>{
  for(const options of [
    {status:403},{status:404},{body:'<!doctype html><html>denied</html>'},
    {body:'{"url":"https://media.example/a.m3u8"}'},
    {body:'#EXTM3U\n#EXTINF:5,\na.ts',headers:{'content-type':'text/html'}},
    {body:'#EXTM3U\n#EXTINF:5,\na.ts',headers:{'content-length':'999999'}},
    {body:'#EXTM3U\n#EXTINF:5,\na.ts\n#'+ '中'.repeat(180000)},
    {body:'#EXTM3U\n#EXT-X-VERSION:3\n'},
  ]){
    const f=rawHlsFixture(options);await assert.rejects(f.play(),/播放解析服务.*HTTP 503/);
    assert.equal(f.calls.filter(call=>call.url===f.raw).length,1);
  }
});
test('tokens, relative values, MP4, non-HTTPS and IP literals never become raw-HLS fallbacks',async()=>{
  for(const raw of ['opaque','relative.m3u8','blob:https://www.omofuna.com/opaque','data:application/vnd.apple.mpegurl,abc',
    'https://origin.example/video.mp4','http://origin.example/a.m3u8','https://127.0.0.1/a.m3u8','https://[::1]/a.m3u8',
    'https://user:password@origin.example/a.m3u8']){
    const f=rawHlsFixture({raw});await assert.rejects(f.play(),/播放解析服务.*HTTP 503/);
    assert.equal(f.calls.filter(call=>call.url===raw).length,0);
  }
});
test('raw-HLS verification times out, aborts its one request and keeps the original error',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let began,aborted=false;const started=new Promise(resolve=>began=resolve);
  const f=rawHlsFixture({originFetch:(_url,init)=>new Promise((_resolve,reject)=>{
    init.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));});began();
  })});
  const result=f.play();await started;t.mock.timers.tick(4000);
  await assert.rejects(result,/播放解析服务.*HTTP 503/);
  assert.equal(aborted,true);assert.equal(f.calls.filter(call=>call.url===f.raw).length,1);
});
test('lazy recovery is explicitly declared and skips all official player templates and parsers',async()=>{
  const f=rawHlsFixture(),info=f.plugin.getInfo();
  assert.equal(info.function[0].action.payload.capabilities.rawHlsRecovery,true);
  const data=(await f.play({rawHlsRecovery:true})).data;
  assert.equal(data.item.id,id);assert.equal(data.lineId,'2');assert.equal(data.episodeId,'1');
  assert.equal(data.watchUrl,home+'/anime/'+id+'.html?line=2&episode=1');
  assert.equal(data.sources[0].url,f.raw);
  assert.equal(f.calls.filter(call=>call.url===f.raw).length,1);
  assert.equal(f.calls.some(call=>new URL(call.url).pathname.startsWith('/static/player/')),false);
  assert.equal(f.calls.some(call=>new URL(call.url).hostname==='art.v2player.top'),false);
});
test('direct recovery preserves the same no-referrer request as verified direct playback',async()=>{
  const f=rawHlsFixture({originFetch:async(_url,init)=>({
    ok:!init.headers.Referer,status:init.headers.Referer?403:200,
    text:async()=>'#EXTM3U\n#EXTINF:5,\na.ts\n',
  })});
  const normal=(await f.play()).data,recovery=(await f.play({rawHlsRecovery:true})).data;
  assert.deepEqual(recovery.sources[0].headers,normal.sources[0].headers);
  assert.deepEqual(recovery.sources[0].headers,{});
});
test('lazy recovery validates the reread exact episode and never silently chooses a default',async()=>{
  for(const playerOverride of [{id:'abcdef0123456789abcdef01'},{sid:'1'},{nid:'2'}]){
    const f=rawHlsFixture({playerOverride});await assert.rejects(f.play({rawHlsRecovery:true}),/其他分集/);
    assert.equal(f.calls.filter(call=>call.url===f.raw).length,0);
  }
  const f=rawHlsFixture();
  await assert.rejects(f.play({rawHlsRecovery:true,lineId:undefined}),/指定恢复的线路和分集/);
  await assert.rejects(f.play({rawHlsRecovery:true,episodeId:undefined}),/指定恢复的线路和分集/);
  assert.equal(f.calls.length,0);
});
test('lazy recovery refuses opaque sources and false HLS without entering a parser fallback loop',async()=>{
  const token=rawHlsFixture({raw:'opaque'});
  await assert.rejects(token.play({rawHlsRecovery:true}),/没有可验证的原始HLS地址/);
  assert.equal(token.calls.some(call=>new URL(call.url).origin!==home),false);
  for(const options of [{body:'<html>not a playlist</html>'},{status:403},{status:404}]){
    const f=rawHlsFixture(options);await assert.rejects(f.play({rawHlsRecovery:true}),/原始媒体暂不可用/);
    assert.equal(f.calls.filter(call=>call.url===f.raw).length,1);
    assert.equal(f.calls.some(call=>new URL(call.url).pathname.startsWith('/static/player/')),false);
  }
});
test('lazy recovery reuses a known public no-referrer policy without rereading the iframe',async()=>{
  let count=0;
  const f=rawHlsFixture({iframe:'<meta name="referrer" content="never"><script>const options={url:"https://media.example/actual.m3u8"};</script>',
    originFetch:async()=>({ok:++count>1,status:count>1?200:403,text:async()=>'#EXTM3U\n#EXTINF:5,\na.ts\n'})});
  const normal=(await f.play()).data;
  assert.equal(normal.sources[0].url,'https://media.example/actual.m3u8');
  assert.equal(f.calls.filter(call=>call.url===f.raw).length,1);
  const before=f.calls.length,recovery=(await f.play({rawHlsRecovery:true})).data;
  assert.deepEqual(recovery.sources[0].headers,{});
  assert.deepEqual(f.calls.find(call=>call.url===f.raw).headers,{});
  assert.equal(f.calls.slice(before).some(call=>new URL(call.url).hostname==='art.v2player.top'),false);
});
test('a shared parser timeout is not repeated for every automatic line and explicit retry can retest it',async()=>{
  const p=fresh();let parserCalls=0;
  global.fetch=async raw=>{
    const url=new URL(raw);let body=detail;
    if(url.pathname.includes('/play/'))body='var player_aaaa='+JSON.stringify({id,sid:'1',nid:'1',from:'mp4',encrypt:0,url:'opaque'})+';var d4ddy={"dmid":17482};';
    if(url.pathname==='/static/player/mp4.js')body=template;
    if(url.hostname==='art.v2player.top'){parserCalls++;throw new Error('timeout');}
    return {ok:true,status:200,text:async()=>body};
  };
  for(const refresh of [false,false,true])await assert.rejects(p.getSession({...args,id,lineId:'1',episodeId:'1',refresh}),/播放解析服务暂未响应/);
  assert.equal(parserCalls,2);
});

test('one timed-out parser request cannot suppress another line on the same parser origin',async()=>{
  const p=freshSource(),parserLines=[];
  global.fetch=async raw=>{
    const url=new URL(raw);let body=detail;
    if(url.pathname.includes('/play/')){
      const line=url.pathname.match(/\/play\/(\d+)\//)[1];
      body='var player_aaaa='+JSON.stringify({id,sid:line,nid:'1',from:'mp4',encrypt:0,url:'opaque-line-'+line})+';var d4ddy={"dmid":17482};';
    }
    if(url.pathname==='/static/player/mp4.js')body=template;
    if(url.hostname==='art.v2player.top'){
      const line=url.searchParams.get('url');parserLines.push(line);
      if(line==='opaque-line-2')throw new Error('timeout');
      body="const options={url:'https://media.example/working.m3u8'};";
    }
    return {ok:true,status:200,text:async()=>body};
  };
  await assert.rejects(p.getSession({...args,id,lineId:'2',episodeId:'1'}),/播放解析服务暂未响应/);
  const value=(await p.getSession({...args,id,lineId:'1',episodeId:'1'})).data;
  assert.equal(value.lineId,'1');assert.equal(value.episodeId,'1');
  assert.equal(value.sources[0].url,'https://media.example/working.m3u8');
  await assert.rejects(p.getSession({...args,id,lineId:'2',episodeId:'1'}),/播放解析服务暂未响应/);
  assert.deepEqual(parserLines,['opaque-line-2','opaque-line-1']);
  await assert.rejects(p.getSession({...args,id,lineId:'2',episodeId:'1',refresh:true}),/播放解析服务暂未响应/);
  assert.deepEqual(parserLines,['opaque-line-2','opaque-line-1','opaque-line-2']);
});


test('network contexts remain explicit and concurrent requests never use legacy fetch',async()=>{
  const oldBridge=global.bridge,calls=[];
  global.fetch=async()=>{throw new Error('wrong route');};
  global.bridge={call:async(name,payload)=>{
    if(name==='breeze.omo.cancel')return '{}';
    assert.equal(name,'breeze.omo.fetch');assert.equal(payload.responseMode,'poll-v1');calls.push(payload);
    await new Promise(resolve=>setTimeout(resolve,payload.context==='route_a'?8:1));
    return JSON.stringify({status:200,headers:{'content-type':'text/html'},body:detail});
  }};
  try{
    const plugin=fresh();
    const result=await Promise.all(['route_a','route_b'].map(networkContext=>plugin.getItem({...args,id,refresh:true,networkContext})));
    assert.equal(result.length,2);assert.deepEqual(calls.map(call=>call.context),['route_a','route_b']);
    assert.notEqual(calls[0].request,calls[1].request);
    assert.ok(calls.every(call=>call.url===home+'/anime/'+id+'.html'));
  }finally{global.bridge=oldBridge;}
});
test('an explicit network failure does not fall back to the process proxy',async()=>{
  const oldBridge=global.bridge;let legacy=0;
  global.fetch=async()=>{legacy++;throw new Error('must not fall back');};
  global.bridge={call:async()=>{throw new Error('network timeout');}};
  try{await assert.rejects(fresh().getItem({...args,id,refresh:true,networkContext:'route_a'}),/暂未响应/);assert.equal(legacy,0);}
  finally{global.bridge=oldBridge;}
});

test('native transport polls without truncating the parser budget',async()=>{
  const oldBridge=global.bridge;let polls=0,timeout;
  global.fetch=async()=>{throw new Error('wrong route');};
  global.bridge={call:async(name,payload)=>{
    if(name==='breeze.omo.cancel')return '{}';
    if(name==='breeze.omo.fetch'){assert.equal(payload.responseMode,'poll-v1');timeout=payload.timeout;return JSON.stringify({pending:true});}
    assert.equal(name,'breeze.omo.poll');polls++;
    return JSON.stringify(polls===1?{pending:true}:{status:200,headers:{},body:detail});
  }};
  try{assert.equal((await fresh().getItem({...args,id,refresh:true,networkContext:'route_poll'})).data.title,'作品');assert.equal(polls,2);assert.equal(timeout,8000);}
  finally{global.bridge=oldBridge;}
});


test('a failed native bridge request always releases its host job',async()=>{
  const oldBridge=global.bridge;let cancellations=0;
  global.bridge={call:async(name,payload)=>{
    if(name==='breeze.omo.cancel'){cancellations++;return '{}';}
    if(name==='breeze.omo.fetch'){assert.equal(payload.responseMode,'poll-v1');return JSON.stringify({pending:true});}
    throw new Error('bridge fixture failure');
  }};
  try{await assert.rejects(fresh().getItem({...args,id,refresh:true,networkContext:'failed-poll'}),/暂未响应/);assert.equal(cancellations,1);}
  finally{global.bridge=oldBridge;}
});

 test('encoded source template preserves URL query data without executing provider scripts',async()=>{
  const fs=require('node:fs'),path=require('node:path');
  const observed=fs.readFileSync(path.join(__dirname,'player-template-encoded.fixture.js'),'utf8');
  for(const corrupt of [false,true]){
    const raw='https://media.example/raw.m3u8?token=a&part=2',calls=[];
    global.__omoExecuted=undefined;
    global.fetch=async value=>{
      const url=new URL(value);calls.push(url);let body=detail;
      if(url.pathname.includes('/play/'))body='var player_aaaa='+JSON.stringify({id,sid:'2',nid:'1',from:'encoded',encrypt:0,url:raw,vod_data:{vod_name:'Name & title',vod_pic:'mac://images.example/upload/cover.webp'}})+';var d4ddy={"dmid":17482};';
      if(url.pathname==='/static/player/encoded.js')body='globalThis.__omoExecuted=true;'+(corrupt?observed.replace("url: MacPlayer.PlayUrl || ''","url: globalThis.evil()") : observed);
      if(url.hostname==='art.v2player.top')body="const options={url:'https://media.example/actual.m3u8'};";
      return {ok:true,text:async()=>body};
    };
    const work=fresh().getSession({...args,id,lineId:'2',episodeId:'1'});
    if(corrupt)await assert.rejects(work,/模板暂未支持/);
    else {
      assert.equal((await work).data.sources[0].url,'https://media.example/actual.m3u8');
      const frame=calls.find(url=>url.hostname==='art.v2player.top');
      assert.equal(frame.searchParams.get('url'),raw);
      assert.equal(frame.searchParams.get('sid'),'2');
      assert.equal(frame.searchParams.get('name'),'Name & title');
      assert.equal(frame.searchParams.get('pic'),'upload/cover.webp');
    }
    assert.equal(global.__omoExecuted,undefined);
  }
});

test('relative upload covers and MacCMS image addresses use the image CDN in catalog and details',async()=>{
  global.fetch=async()=>({ok:true,text:async()=>''});
  const p=fresh(),url=home+'/anime/'+id+'.html';
  for(const coverUrl of ['/upload/vod/cover.jpg',home+'/upload/vod/cover.jpg','mac://as.cfhls.top/upload/vod/cover.jpg']){
    const page=(await p.getLibrary({...args,browserSnapshot:snapshot(home+'/',[{...card,coverUrl}])})).data;
    assert.equal(page.items[0].coverUrl,'https://as.cfhls.top/upload/vod/cover.jpg');
    const value=(await p.getItem({...args,id,browserSnapshot:{kind:'public-detail',url,html:detail.replace('https://images.example/cover.webp',coverUrl)}})).data;
    assert.equal(value.coverUrl,'https://as.cfhls.top/upload/vod/cover.jpg');
  }
});


test('routing declares exact site identity and runtime media discovery rather than fixed rotating CDNs',()=>{
  const info=rawHlsFixture().plugin.getInfo();
  assert.equal(info.routing.version,1);
  assert.equal(info.routing.mediaHosts,'runtime');
  assert.deepEqual(Array.from(info.routing.siteOrigins),[home]);
  assert.equal(Object.hasOwn(info.routing,'domainSuffixes'),false);
});
