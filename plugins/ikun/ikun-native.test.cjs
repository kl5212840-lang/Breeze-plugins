const {test, beforeEach} = require('node:test');
const assert = require('node:assert/strict');
let plugin, rows, requests;
const row = (id = 7) => ({vod_id:id,vod_name:'测试作品',type_id:37,type_name:'日本动漫',
  vod_pic:'https://images.example.test/poster.jpg',vod_content:'<p>真实字段简介</p>',
  vod_play_from:'ikm3u8',vod_play_url:'第01集$https://cdn.example.test/a.m3u8#第02集$https://cdn.example.test/b.m3u8',
  vod_total:12,vod_remarks:'更新至02集',vod_year:'2026',vod_hits:0,vod_score:'0.0',vod_score_num:0});
beforeEach(() => {
  delete require.cache[require.resolve('./ikun-native.cjs')]; plugin = require('./ikun-native.cjs');
  rows = [row()]; requests=[];
  global.fetch = async input => {
    const url = new URL(input); requests.push(url);
    const list = url.searchParams.has('ids') ? rows.filter(x => url.searchParams.get('ids').split(',').includes(String(x.vod_id))) : rows;
    return {ok:true,status:200,text:async()=>JSON.stringify({code:1,page:'1',pagecount:1,total:list.length,list,
      class:[{type_id:4,type_pid:0,type_name:'动漫'},{type_id:37,type_pid:4,type_name:'日本动漫'}]})};
  };
});
test('opt-in library protocol and no fake login', () => {
  assert.equal(plugin.getInfo().function[0].action.type,'openVideoLibrary');
  assert.equal(plugin.getSettingsBundle().data.canLogin,false);
});
test('real detail listing contract carries posters, query and explicit filters', async () => {
  const value = await plugin.getLibrary({query:'中文 & test',typeId:'37',year:'2026',page:1,area:'ignored'});
  assert.equal(value.data.items[0].coverUrl, 'https://images.example.test/poster.jpg');
  const url=requests.find(x=>x.searchParams.get('ac')==='detail');
  assert.equal(url.searchParams.get('wd'),'中文 & test'); assert.equal(url.searchParams.get('t'),'37');
  assert.equal(url.searchParams.has('area'),false); assert.equal(value.data.categories.length,2);
});
test('planned total does not manufacture available episodes or zero ratings',async()=>{
  const item=(await plugin.getItem({id:'7'})).data;
  assert.equal(item.plannedEpisodes,12); assert.equal(item.lines[0].episodes.length,2);
  assert.equal(item.sourceRating,null); assert.equal(item.sourceViews,null);
});
test('real descriptive fields and update-window parameter retain their meaning',async()=>{
  Object.assign(rows[0],{vod_sub:'原名',vod_class:'剧情,科幻',vod_writer:'编剧',vod_douban_id:12345,vod_douban_score:'8.6'});
  const item=(await plugin.getItem({id:'7'})).data;
  assert.equal(item.alternateTitle,'原名');assert.equal(item.genres,'剧情,科幻');assert.equal(item.doubanScore,8.6);
  await plugin.getLibrary({recentHours:24});assert.equal(requests.at(-1).searchParams.get('h'),'24');
  rows[0].vod_douban_id=0;assert.equal((await plugin.getItem({id:7,refresh:true})).data.doubanScore,null);
});
test('bounded batch details reports missing IDs and never includes unrelated films',async()=>{
  rows.push(row(8));
  const value=(await plugin.getItems({ids:['7','8','9']})).data;
  assert.deepEqual(value.items.map(x=>x.id),['7','8']);assert.deepEqual(value.missingIds,['9']);
  await assert.rejects(plugin.getItems({ids:Array.from({length:21},(_,i)=>String(i+1))}),/20/);
});
test('episode identity survives reorder and token renewal',async()=>{
  const first=(await plugin.getSession({id:'7',episodeId:'第02集'})).data;
  rows[0].vod_play_url='第02集$https://cdn.example.test/b.m3u8?new=1#第01集$https://cdn.example.test/a.m3u8';
  const next=(await plugin.getSession({id:'7',episodeId:'第02集',refresh:true})).data;
  assert.equal(next.watchUrl,first.watchUrl); assert.match(next.sources[0].url,/new=1/);
  assert.notEqual(new URL(next.watchUrl).searchParams.get('episode'),'第01集');
});
test('duplicate labels keep different source paths and do not collide',async()=>{
  rows[0].vod_play_url='正片$https://cdn.example.test/a.m3u8#正片$https://cdn.example.test/b.m3u8';
  const episodes=(await plugin.getItem({id:7})).data.lines[0].episodes;
  assert.equal(episodes.length,2); assert.notEqual(episodes[0].id,episodes[1].id);
});
test('single episode, absent target and unsafe source boundaries',async()=>{
  rows[0].vod_play_url='正片$http://cdn.example.test/a.m3u8#正片$https://user:pass@cdn.example.test/a.m3u8';
  await assert.rejects(plugin.getSession({id:7}),/不可用/);
  await assert.rejects(plugin.getItem({id:'../7'}),/无效/);
  await assert.rejects(plugin.getItem({id:99}),/不可用/);
});
test('multiple lines remain independent from quality and episode indices',async()=>{
  rows[0].vod_play_from='ikm3u8$$$backup';
  rows[0].vod_play_url+='$$$第01集$https://backup.example.test/a.m3u8';
  const data=(await plugin.getSession({id:7,lineId:'backup',episodeId:'第01集'})).data;
  assert.equal(data.lineId,'backup'); assert.equal(data.sources[0].quality,'backup');
  assert.equal(new URL(data.watchUrl).searchParams.get('line'),'backup');
});
test('network and invalid JSON produce explicit failures',async()=>{
  global.fetch=async()=>({ok:false,status:503});await assert.rejects(plugin.getLibrary(),/503/);
  global.fetch=async()=>({ok:true,status:200,text:async()=>'<html>验证</html>'});
  await assert.rejects(plugin.getLibrary(),/未返回有效/);
});
test('parent groups merge full leaf streams and keep a cursor across module reload',async()=>{
  const classes=[{type_id:4,type_pid:0,type_name:'动漫'},
    {type_id:35,type_pid:4,type_name:'国产动漫'},{type_id:37,type_pid:4,type_name:'日本动漫'}];
  global.fetch=async input=>{
    const u=new URL(input),type=u.searchParams.get('t'),page=Number(u.searchParams.get('pg')||1);
    const list=type?[...Array(40)].map((_,i)=>({...row(Number(type)*100+i+1),type_id:Number(type),
      vod_time:`2026-10-${String(30-Math.floor(i/2)).padStart(2,'0')} 12:${String(59-i%2).padStart(2,'0')}:00`})).slice((page-1)*20,page*20):[];
    return{ok:true,status:200,text:async()=>JSON.stringify({code:1,page,pagecount:type?2:0,total:type?40:0,list,class:classes})};
  };
  const first=(await plugin.getLibrary({typeId:'4'})).data;
  const second=(await plugin.getLibrary({typeId:'4',page:2,cursor:first.nextCursor})).data;
  assert.equal(first.total,80);assert.equal(first.items.length,20);assert.equal(second.items.length,20);
  assert.equal(new Set(first.items.map(x=>x.typeId)).size,2);
  assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,40);
  delete require.cache[require.resolve('./ikun-native.cjs')];plugin=require('./ikun-native.cjs');
  const third=(await plugin.getLibrary({typeId:'4',page:3,cursor:second.nextCursor})).data;
  assert.equal(third.items.length,20);assert.equal(new Set([...first.items,...second.items,...third.items].map(x=>x.id)).size,60);
  await assert.rejects(plugin.getLibrary({typeId:'4',page:4,cursor:first.nextCursor}),/刷新/);
});

test('web playback uses declared official players without changing episode identity', async () => {
  const value = (await plugin.getItem({id:7})).data;
  const episode = value.lines[0].episodes[0];
  assert.equal(episode.webPlaybackUrls.length, 2);
  assert.deepEqual(episode.webPlaybackUrls.map(x => new URL(x).hostname), ['bofang.ikundmjx.com','bofang.ikdmjx.com']);
  assert.equal(episode.webPlaybackUrls[0].split('url=')[1], episode.url);
  assert.equal(new URL(episode.webPlaybackUrls[1]).searchParams.get('url'), episode.url);
  assert.equal(new URL(episode.watchUrl).hostname, 'www.ikunzy.com');
  assert.equal(value.lines.length,1);
});

test('the current official player receives the complete signed media query', async () => {
  rows[0].vod_play_url = '正片$https://cdn.example.test/a.m3u8?token=one&part=two';
  const episode = (await plugin.getItem({id:7})).data.lines[0].episodes[0];
  assert.equal(episode.webPlaybackUrls[0].split('url=')[1], episode.url);
  assert.equal(new URL(episode.webPlaybackUrls[1]).searchParams.get('url'), episode.url);
});
