'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCmsVideoPlugin} = require('./cms-core.cjs');

const row = (id, type, label='正片', query='old') => ({
  vod_id:id, vod_name:`Fixture ${id}`, type_id:type, vod_time:'2026-10-27 12:00:00',
  vod_play_from:'one', vod_play_url:`${label}$https://media.example/${id}.m3u8?token=${query}#`,
});
function plugin() {
  return createCmsVideoPlugin({id:'fixture',home:'https://site.example/',apis:['https://api.example/'],
    pageSize:20,capabilities:{search:'full'},lineLabels:{},
    detailPath:id=>`/vod/${id}/`,webPlayback:(_id,_sid,_nid,url)=>[url]});
}

test('parent aggregation includes direct parent records and its descendants', async () => {
  const original = global.fetch;
  const requests = [];
  global.fetch = async raw => {
    const u = new URL(raw); requests.push(u);
    const type = u.searchParams.get('t');
    const data = type ? [row(type==='7'?101:102,type)] : [];
    return {ok:true,text:async()=>JSON.stringify({code:1,page:1,pagecount:1,total:data.length,
      list:data,class:[{type_id:7,type_pid:0,type_name:'parent'},{type_id:10,type_pid:7,type_name:'child'}]})};
  };
  try {
    const result = (await plugin().getLibrary({clientProtocol:2,typeId:'7'})).data;
    assert.deepEqual(new Set(result.items.map(x=>x.id)), new Set(['101','102']));
    assert.equal(result.total,2);
    assert.deepEqual(requests.filter(u=>u.searchParams.has('t')).map(u=>u.searchParams.get('t')),['7','10']);
  } finally {global.fetch=original;}
});

test('merged categories continue through consecutive empty pages before declaring exhaustion', async () => {
  const original = global.fetch;
  const requested = [];
  const classes = [
    {type_id:7,type_pid:0,type_name:'parent'},
    {type_id:10,type_pid:7,type_name:'child'},
  ];
  global.fetch = async raw => {
    const url = new URL(raw);
    const type = url.searchParams.get('t');
    const page = Number(url.searchParams.get('pg') ?? 1);
    if (type === '10') requested.push(page);
    const list = type === '10' && page === 3 ? [row(101,10)] : [];
    return {ok:true,text:async()=>JSON.stringify({
      code:1,page,pagecount:type === '10' ? 3 : 1,total:type === '10' ? 1 : 0,
      list,class:classes,
    })};
  };
  try {
    const result = (await plugin().getLibrary({clientProtocol:2,typeId:'7'})).data;
    assert.deepEqual(requested,[1,2,3]);
    assert.deepEqual(result.items.map(item=>item.id),['101']);
    assert.equal(result.total,1);
    assert.equal(result.totalKnown,true);
    assert.equal(result.pageCount,1);
    assert.equal(result.nextCursor,null);
  } finally { global.fetch = original; }
});

test('media token refresh preserves the episode identity and ignores trailing separators', async () => {
  const original = global.fetch;
  let token='old';
  global.fetch=async()=>({ok:true,text:async()=>JSON.stringify({code:1,list:[row(42,10,'第01集',token)]})});
  try {
    const p=plugin(),a=(await p.getSession({clientProtocol:2,id:'42'})).data;
    token='renewed';
    const b=(await p.getSession({clientProtocol:2,id:'42',episodeId:a.episodeId,lineId:a.lineId,refresh:true})).data;
    assert.equal(a.item.lines[0].episodes.length,1);
    assert.equal(b.episodeId,a.episodeId);
    assert.equal(b.watchUrl,a.watchUrl);
    assert.notEqual(b.sources[0].url,a.sources[0].url);
    await assert.rejects(p.getSession({clientProtocol:2,id:'42',episodeId:'missing'}),/已不可用/);
  } finally {global.fetch=original;}
});

for (const [name, create] of [
  ['CMS', plugin],
  ['Modu bundle', () => require('../modu/modu-native.cjs')],
  ['iKun bundle', () => require('../ikun/ikun-native.cjs')],
]) {
  test(name + ' does not republish a late detail response after refresh', async () => {
    const original = global.fetch;
    const response = token => ({ok:true,text:async()=>JSON.stringify({code:1,list:[row(42,10,'Episode',token)]})});
    let finishOld;
    let count = 0;
    let started;
    const dispatched = new Promise(resolve => { started = resolve; });
    global.fetch = () => ++count === 1
      ? new Promise(resolve => { finishOld = resolve; started(); })
      : Promise.resolve(response('new'));
    try {
      const source = create();
      const request = {clientProtocol: 2, id: '42'};
      const old = source.getItem(request);
      await dispatched;
      await source.getItem({...request, refresh: true});
      finishOld(response('old'));
      await old;
      const playback = await source.getSession(request);
      assert.equal(new URL(playback.data.sources[0].url).searchParams.get('token'), 'new');
      assert.equal(count, 2);
    } finally {
      global.fetch = original;
    }
  });
}

test('old clients fail before a network request instead of ignoring capabilities', async () => {
  await assert.rejects(plugin().getLibrary({}),/更新配套/);
});
test('source counters retain known zero and missing values stay absent', async()=>{
  const original=global.fetch;
  global.fetch=async()=>({ok:true,text:async()=>JSON.stringify({code:1,list:[{
    ...row(42,10),vod_hits_day:0,vod_hits_week:'27',vod_duration:'120分钟',vod_version:'高清',vod_time_add:1700000000,
  }]})});
  try { const item=(await plugin().getItem({clientProtocol:2,id:'42'})).data;
    assert.deepEqual(item.sourceCounters,{day:0,week:27});
    assert.equal(item.sourceDuration,'120分钟');assert.equal(item.sourceVersion,'高清');
  }finally{global.fetch=original;}
});

test('CMS defaults and contradictory vote counts are identified independently', async () => {
  const original = global.fetch;
  const fixtures = [
    {
      ...row(10172, 10),
      vod_hits: 17, vod_hits_day: 0, vod_hits_week: '0', vod_hits_month: 0, vod_time_hits: 0,
      vod_score: '1.1', vod_score_all: 215, vod_score_num: 611,
    },
    {
      ...row(42, 10),
      vod_hits: '0', vod_hits_day: 0, vod_hits_week: 0, vod_hits_month: 0, vod_time_hits: 1700000000,
      vod_score: '8.1', vod_score_all: 809, vod_score_num: 100,
    },
  ];
  global.fetch = async url => {
    const id = new URL(url).searchParams.get('ids');
    return {ok: true, text: async () => JSON.stringify({
      code: 1, list: fixtures.filter(value => String(value.vod_id) === id),
    })};
  };
  try {
    const adapter = plugin();
    const uninitialized = (await adapter.getItem({clientProtocol: 2, id: '10172'})).data;
    assert.equal(uninitialized.sourceViews, 17);
    assert.equal(uninitialized.sourceViewsKind, 'clicks');
    assert.deepEqual(uninitialized.sourceCounters, {});
    assert.equal(uninitialized.sourceRating, 1.1);
    assert.equal(uninitialized.sourceRatingCount, 611);
    assert.equal(uninitialized.sourceRatingCountConsistent, false);

    const observed = (await adapter.getItem({clientProtocol: 2, id: '42'})).data;
    assert.equal(observed.sourceViews, 0);
    assert.deepEqual(observed.sourceCounters, {day: 0, week: 0, month: 0});
    assert.equal(observed.sourceRating, 8.1);
    assert.equal(observed.sourceRatingCount, 100);
    assert.equal(observed.sourceRatingCountConsistent, undefined);
  } finally {
    global.fetch = original;
  }
});
