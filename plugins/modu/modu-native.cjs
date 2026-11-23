'use strict';

// Shared, source-configured MacCMS read adapter. Bundled into each install file.
function createCmsVideoPlugin(config) {
const {id: ID, home: HOME, apis, pageSize, capabilities} = config;
const cache = new Map();
const detailReads = new Map();

function beginDetailRead(ids) {
  const owner = Symbol();
  for (const id of ids) detailReads.set(id, owner);
  return owner;
}
function rememberDetail(id, item, owner) {
  if (detailReads.get(id) !== owner) return;
  cache.delete(id);
  cache.set(id, {at: Date.now(), item});
  if (cache.size > 32) cache.delete(cache.keys().next().value);
}
function endDetailRead(ids, owner) {
  for (const id of ids) {
    if (detailReads.get(id) === owner) detailReads.delete(id);
  }
}
let categoryCache = null;
let categoryPending = null;
const pageCache = new Map();
const pageReads = new Map();
let responseCacheEpoch = 0;

async function syncResponseCache() {
  let epoch;
  try {
    epoch = await globalThis.bridge?.call('cache.response_generation');
  } catch { /* Older hosts omit generations. */ }
  if (Number.isSafeInteger(epoch) && epoch > responseCacheEpoch) {
    responseCacheEpoch = epoch;
    cache.clear();
    detailReads.clear();
    pageCache.clear();
    pageReads.clear();
    categoryCache = categoryPending = null;
  }
  return responseCacheEpoch;
}

function text(value, limit = 500) {
  return (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit);
}
function integer(value, fallback = 0) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : fallback;
}
function metricInteger(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  return integer(value, null);
}
function credit(value, limit) {
  const result=text(value,limit);
  return ['', '暂无','未知','不详','内详','N/A'].includes(result) ? '' : result;
}
function https(value) {
  try {
    const u = new URL(text(value, 4096));
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : '';
  } catch { return ''; }
}
function itemId(value) {
  const id = text(value, 30);
  if (!/^[1-9][0-9]{0,14}$/.test(id)) throw new Error('无效的影片编号');
  return id;
}
function digest(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
function episodeUrl(id, line, episode) {
  const u = new URL(config.detailPath(itemId(id)), HOME);
  u.searchParams.set('line', line);
  u.searchParams.set('episode', episode);
  return u.href;
}
function lines(raw, id) {
  const names = text(raw.vod_play_from, 10000).split('$$$');
  const groups = text(raw.vod_play_url, 1000000).split('$$$');
  const result = [];
  for (let i = 0; i < Math.min(names.length, groups.length, 12); i++) {
    const name = text(names[i], 100);
    if (!name) continue;
    const lineId = result.some(x => x.id === name) ? `${name}-${i}` : name;
    const entries = groups[i].split('#').slice(0, 5000).map((entry, originalIndex) => {
      const at = entry.indexOf('$');
      if (at < 1) return null;
      const title = text(entry.slice(0, at), 200), url = https(entry.slice(at + 1));
      return title && url ? {title, url, originalIndex} : null;
    }).filter(Boolean);
    const counts = new Map();
    entries.forEach(x => counts.set(x.title, (counts.get(x.title) || 0) + 1));
    const seen = new Set(), episodes = [];
    for (const entry of entries) {
      // Unique labels survive reordering and renewed query tokens. Duplicate
      // labels need a path discriminator; never use the displayed list index.
      const discriminator = counts.get(entry.title) > 1
        ? `-${digest(new URL(entry.url).origin + new URL(entry.url).pathname)}` : '';
      const key = `${entry.title}${discriminator}`;
      if (seen.has(key)) continue;
      seen.add(key);
      episodes.push({id: key, title: entry.title, url: entry.url,
        watchUrl: episodeUrl(id, lineId, key),
        webPlaybackUrls: config.webPlayback(id, i + 1, entry.originalIndex + 1, entry.url)});
    }
    if (episodes.length) result.push({id: lineId, label: config.lineLabels[name] || name, episodes});
  }
  return result;
}
function normalize(raw, detail = false) {
  const id = itemId(raw.vod_id), title = text(raw.vod_name);
  if (!title) throw new Error('影片缺少名称');
  const score = Number(raw.vod_score), scoreCount = integer(raw.vod_score_num);
  const validScore = Number.isFinite(score) && score > 0 && score <= 10 && scoreCount > 0;
  const scoreSum = metricInteger(raw.vod_score_all);
  // MacCMS publishes its average to one decimal. Keep the source's average,
  // but do not present a contradictory vote count as its denominator.
  const ratingCountConsistent = !validScore || scoreSum === null ||
    Math.abs(score - scoreSum / scoreCount) <= 0.05 + Number.EPSILON * 10;
  const clickTime = metricInteger(raw.vod_time_hits);
  const totalClicks = metricInteger(raw.vod_hits);
  const periods = Object.fromEntries(['day','week','month']
    .map(key=>[key,metricInteger(raw['vod_hits_'+key])])
    .filter(([, count])=>count !== null));
  // Rows without any measured window often contain all three defaults.
  const uninitializedPeriods = !clickTime && Object.keys(periods).length === 3 &&
    Object.values(periods).every(count=>count === 0);
  return {
    id, title, detailUrl: new URL(config.detailPath(id), HOME).href,
    coverUrl: https(raw.vod_pic) || https(raw.vod_pic_thumb), description: text(raw.vod_content || raw.vod_blurb, detail ? 20000 : 1500),
    typeId: String(integer(raw.type_id)), typeName: text(raw.type_name, 100),
    remarks: text(raw.vod_remarks, 200) || (integer(raw.vod_serial) > 0 ? `更新至${integer(raw.vod_serial)}集` : ''), year: text(raw.vod_year, 100),
    alternateTitle: text(raw.vod_sub, 500), genres: [...new Set([raw.vod_class,raw.vod_tag].flatMap(v=>text(v,500).split(/[,，、]/)).map(v=>v.trim()).filter(Boolean))].join('、'),
    area: text(raw.vod_area, 300), language: text(raw.vod_lang, 300),
    actors: credit(raw.vod_actor, 3000), directors: credit(raw.vod_director, 1000),
    writers: credit(raw.vod_writer, 1000),
    doubanId: integer(raw.vod_douban_id) > 0 ? String(integer(raw.vod_douban_id)) : '',
    doubanScore: integer(raw.vod_douban_id) > 0 && Number(raw.vod_douban_score) > 0 && Number(raw.vod_douban_score) <= 10
      ? Number(raw.vod_douban_score) : null,
    updatedAt: text(raw.vod_time, 80), releaseDate: text(raw.vod_pubdate, 80),
    plannedEpisodes: integer(raw.vod_total), finished: String(raw.vod_isend) === '1',
    sourceViews: totalClicks === 0 && !clickTime ? null : totalClicks,
    sourceViewsKind: 'clicks',
    sourceCounters: uninitializedPeriods ? {} : periods,
    sourceDuration: credit(raw.vod_duration,200).replace(/^0(?:\.0+)?$/,''),
    sourceVersion: credit(raw.vod_version,100),
    sourceAddedAt: /^0+$/.test(String(raw.vod_time_add))?'':text(raw.vod_time_add,80), sourceStatus: credit(raw.vod_state,200),
    sourceRating: validScore ? score : null,
    sourceRatingCount: scoreCount > 0 ? scoreCount : null,
    ...(ratingCountConsistent ? {} : {sourceRatingCountConsistent: false}),
    ...(detail ? {lines: lines(raw, id)} : {}),
  };
}
async function request(params = {}) {
  // Aliases share a source and its backoff. They are never extra media lines.
  const deadline = Date.now() + 15000;
  let failure = new Error('资源接口暂不可用，请稍后重试');
  for (const api of apis.slice(0, 2)) {
    const remaining = Math.min(10000, deadline - Date.now());
    if (remaining <= 0) break;
    const url = new URL(api);
    for (const [key, value] of Object.entries(params)) {
      if (value !== '' && value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(url.href, {signal: controller.signal, timeout: remaining,
        headers: {Accept: 'application/json,text/plain,*/*'}});
      if (!response.ok) {
        const after = String(response.headers?.get?.('retry-after') ?? '').trim();
        const safe = /^\d{1,10}$|^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(after);
        failure = new Error(`HTTP ${response.status}${safe ? ` Retry-After: ${after}` : ''}`);
        if (response.status === 429 || safe) break;
        continue;
      }
      const body = await response.text();
      if (Date.now() >= deadline || controller.signal.aborted) {
        failure = new Error('Network request timed out');
        continue;
      }
      if (body.length > 2500000) continue;
      const json = JSON.parse(body);
      if (integer(json.code) === 1 && Array.isArray(json.list)) return json;
    } catch (_) {
      if (controller.signal.aborted) failure = new Error('Network request timed out');
    } finally {
      clearTimeout(timer);
    }
  }
  throw failure;
}
async function categories(epoch) {
  if (categoryCache && Date.now() - categoryCache.at < 300000) return categoryCache.value;
  if (categoryPending) return categoryPending;
  const pending = categoryPending = (async () => {
    const result = await request();
    const value = (Array.isArray(result.class) ? result.class : []).slice(0, 300).map(x => ({
      id: String(integer(x.type_id)), parentId: String(integer(x.type_pid)), name: text(x.type_name, 100),
    })).filter(x => x.id !== '0' && x.name);
    if (!value.length) throw new Error('暂时无法读取分类');
    if (await syncResponseCache() === epoch) categoryCache = {at: Date.now(), value};
    return value;
  })();
  try { return await pending; } finally {
    if (categoryPending === pending) categoryPending = null;
  }
}
function normalizedPage(raw) {
  const items = [], seen = new Set();
  for (const value of raw.list.slice(0, 100)) {
    try {
      const item = normalize(value);
      if (!seen.has(item.id)) { seen.add(item.id); items.push(item); }
    } catch { /* A malformed row does not hide other real results. */ }
  }
  if (raw.list.length && !items.length) throw new Error('资源列表格式已变化');
  return {items, page: integer(raw.page, 1), pageCount: integer(raw.pagecount), total: integer(raw.total)};
}
async function mapLimit(values, fn) {
  const out = new Array(values.length); let next = 0;
  await Promise.all(Array.from({length: Math.min(3, values.length)}, async () => {
    while (next < values.length) { const i = next++; out[i] = await fn(values[i]); }
  }));
  return out;
}
function directTypes(types, parent) {
  const nodes = [], visited = new Set();
  const visit = id => {
    if (visited.has(id)) throw new Error('分类结构存在循环'); visited.add(id);
    nodes.push(id); // A parent can own direct entries (observed in Modu).
    types.filter(x => x.parentId === id).forEach(x => visit(x.id));
  };
  visit(parent); return nodes;
}
function requireClient(args) {
  if (args.clientProtocol !== 2) throw new Error('请更新配套 Breeze 客户端后使用此插件');
}
async function getLibrary(args = {}) {
  requireClient(args);
  const page = Math.max(1, Math.min(integer(args.page, 1), 10000));
  const typeId = text(args.typeId, 20), year = text(args.year, 8), query = text(args.query, 300);
  const hours = args.recentHours === 24 ? 24 : '';
  if (typeId && !/^[1-9][0-9]*$/.test(typeId)) throw new Error('无效分类');
  if (year && !/^(19|20)[0-9]{2}$/.test(year)) throw new Error('无效年份');
  const epoch = await syncResponseCache();
  const types = await categories(epoch);
  if (query && ['none','website'].includes(capabilities.search)) throw new Error(capabilities.search==='website'?'请使用官网搜索入口':'源站不支持关键词检索，请使用分类与年份');
  if (typeId && !types.some(x => x.id === typeId)) throw new Error('分类已变更，请刷新');
  const leaves = typeId ? directTypes(types, typeId) : [];
  if (leaves.length <= 1) {
    const result = normalizedPage(await request({ac:'detail',pg:page,t:typeId,year,wd:query,h:hours}));
    return {source: ID, data: {...result, categories:types}};
  }
  // The public API accepts one direct type. Merge parent AND descendant streams,
  // with explicit cursors so module eviction cannot lose pagination state.
  const signature = JSON.stringify([typeId,query,year,hours,leaves]);
  const cursor = args.cursor;
  if (page > 1 && (!cursor || cursor.version !== 1 || cursor.signature !== signature || cursor.page !== page - 1)) {
    throw new Error('分类列表已更新，请刷新后继续');
  }
  if (page > 1 && (!Array.isArray(cursor.streams) || cursor.streams.length !== leaves.length ||
      !Array.isArray(cursor.seen) || cursor.seen.length > 100000 || cursor.seen.some(x=>typeof x !== 'string'))) {
    throw new Error('无效的分类分页状态');
  }
  const previous = page > 1 ? cursor.streams : [];
  if (previous.length && (previous.length !== leaves.length || previous.some((x,i) => x.type !== leaves[i] ||
      !Number.isInteger(x.page) || x.page < 1 || x.page > 10000 || !Number.isInteger(x.offset) || x.offset < 0 || x.offset > 100))) {
    throw new Error('无效的分类分页状态');
  }
  const seen = new Set(page > 1 && Array.isArray(cursor.seen) ? cursor.seen.filter(x=>typeof x==='string').slice(0,100000) : []);
  const streams = leaves.map((type,i) => ({type,page:previous[i]?.page || 1,offset:previous[i]?.offset || 0,data:null}));
  async function read(stream) {
    const key = JSON.stringify([signature,stream.type,stream.page]);
    const existing = pageCache.get(key);
    if (args.refresh !== true && existing && Date.now() - existing.at < 45000) stream.data = existing.data;
    else {
      const owner = Symbol();
      pageReads.set(key, owner);
      try {
        stream.data = normalizedPage(await request({ac:'detail',pg:stream.page,t:stream.type,year,wd:query,h:hours}));
        if (stream.data.page !== stream.page) throw new Error('资源分页返回不一致');
        if (await syncResponseCache() === epoch && pageReads.get(key) === owner) {
          pageCache.delete(key);
          pageCache.set(key, {at: Date.now(), data: stream.data});
          if (pageCache.size > 64) pageCache.delete(pageCache.keys().next().value);
        }
      } finally {
        if (pageReads.get(key) === owner) pageReads.delete(key);
      }
    }
    if(stream.data.page!==stream.page)throw new Error('资源分页返回不一致');
  }
  await mapLimit(streams,read);
  const total = streams.reduce((sum,x)=>sum+x.data.total,0), output=[];
  let scanned = 0;
  while (output.length < pageSize) {
    if (++scanned > 2000) throw new Error('分类内容变化过多，请刷新');
    const exhausted = streams.filter(x=>x.offset>=x.data.items.length && x.page<x.data.pageCount);
    if (exhausted.length) {
      await mapLimit(exhausted, async stream => {
        stream.page++;
        stream.offset = 0;
        await read(stream);
      });
      continue;
    }
    const candidates=streams.filter(x=>x.offset<x.data.items.length);
    if (!candidates.length) break;
    candidates.sort((a,b)=>{
      const x=a.data.items[a.offset],y=b.data.items[b.offset];
      return y.updatedAt.localeCompare(x.updatedAt) || Number(y.id)-Number(x.id);
    });
    const stream=candidates[0],item=stream.data.items[stream.offset++];
    if(!seen.has(item.id)){seen.add(item.id);output.push(item);}
  }
  const hasMore = streams.some(x=>x.offset<x.data.items.length || x.page<x.data.pageCount);
  return {source:ID,data:{items:output,categories:types,page,
    pageCount:hasMore ? Math.max(page + 1, Math.ceil(total/pageSize)) : page,
    total:hasMore ? Math.max(total, seen.size) : seen.size, totalKnown:!hasMore,
    nextCursor:hasMore ? {version:1,signature,page,streams:streams.map(x=>({type:x.type,page:x.page,offset:x.offset})),seen:[...seen]} : null}};
}
async function getItem(args = {}) {
  requireClient(args);
  const epoch = await syncResponseCache();
  const id = itemId(args.id), existing = cache.get(id);
  if (args.refresh !== true && existing && Date.now() - existing.at < 60000) {
    return {source: ID, data: existing.item};
  }
  if (args.refresh === true) cache.delete(id);
  const owner = beginDetailRead([id]);
  try {
    const result = await request({ac: 'detail', ids: id});
    const row = result.list.find(x => String(x.vod_id) === id);
    if (!row) throw new Error('这部影片已不可用');
    const item = normalize(row, true);
    if (await syncResponseCache() === epoch) rememberDetail(id, item, owner);
    return {source: ID, data: item};
  } finally {
    endDetailRead([id], owner);
  }
}
async function getSession(args = {}) {
  const {data: item} = await getItem({clientProtocol:args.clientProtocol,id: args.id, refresh: args.refresh === true});
  const line = args.lineId ? item.lines.find(x => x.id === args.lineId) : item.lines[0];
  if (!line) throw new Error('这条线路已不可用');
  const episode = args.episodeId ? line.episodes.find(x => x.id === args.episodeId) : line.episodes[0];
  if (!episode) throw new Error('这一集已不可用，请刷新剧集');
  return {source: ID, data: {item, lineId: line.id, episodeId: episode.id,
    watchUrl: episode.watchUrl, sources: [{url: episode.url, quality: line.label, headers: {}}]}};
}
async function getItems(args = {}) {
  requireClient(args);
  if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 20) throw new Error('每次可检查1至20部影片');
  const ids = [...new Set(args.ids.map(itemId))];
  const epoch = await syncResponseCache();
  const owner = beginDetailRead(ids);
  try {
    const raw = await request({ac: 'detail', ids: ids.join(',')});
    const mayRemember = await syncResponseCache() === epoch;
    const items = [], seen = new Set();
    for (const row of raw.list) {
      if (!ids.includes(String(row.vod_id)) || seen.has(String(row.vod_id))) continue;
      const item = normalize(row, true);
      seen.add(item.id);
      items.push(item);
      if (mayRemember) rememberDetail(item.id, item, owner);
    }
    return {source: ID, data: {items, missingIds: ids.filter(id => !seen.has(id))}};
  } finally {
    endDetailRead(ids, owner);
  }
}
function getInfo() {
  const distribution = config.releaseSeries === 1
    ? {releaseSeries: 1, npmName: '', requirements: {version: 1, capabilities: {videoLibraryProtocol: 2}}}
    : {};
  const updatePath = config.releaseSeries === 1 ? `v1/${config.key}.json` : `${config.key}.json`;
  return {name:config.name,uuid:ID,version:config.version,home:'https://github.com/kl5212840-lang/Breeze-plugins',
    websiteUrl:HOME,iconUrl:config.iconUrl,updateUrl:`https://raw.githubusercontent.com/kl5212840-lang/Breeze-plugins/main/updates/${updatePath}`,
    ...distribution,
    describe:config.description,
    function:[{id:'library',title:'片库',action:{type:'openVideoLibrary',payload:{
      source:ID,title:config.name,url:HOME,protocol:2,nativeSearch:capabilities.search !== 'none',capabilities,
      catalogFnPath:'getLibrary',detailFnPath:'getItem',playbackFnPath:'getSession',batchDetailFnPath:'getItems',
    }}}]};
}
function getSettingsBundle() {
  return {source:ID,data:{mediaType:'video',canLogin:false,canShowUserInfo:false,values:{},sections:[]}};
}
return {getInfo,getLibrary,getItem,getItems,getSession,getSettingsBundle};
}


const config = {"key":"modu","id":"b27083a4-a643-462a-8204-e6f42c19a5b9","name":"魔都资源","version":"0.1.2","releaseSeries":1,"home":"https://www.mdzyapi.com/","apis":["https://www.mdzyapi.com/api.php/provide/vod/"],"pageSize":20,"capabilities":{"search":"full","year":true,"recent":true},"iconUrl":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACshmLzAAAFDklEQVRYCe2WS2gdVRjHv5k8mtYQ02ollBKKIAqFIlVc+ciiEbXFoi60VTQFK7pQF8GKhBhEK6VSiaikIKUQFz4LDYRSRFC6iFXaNCKUtoi6kBBsjdcQYm5y5xx/35k5M3Nfyd3rwJ/vvOb8/9/jnBmR//oTNByASStipVsi6QG3gFCM/ColmaB9SXoD0/BeuYWNCZiyzZC9BF6BrAtIDvOIGGXuoDwYTOf2bqi5uoAfbQebHwcPQ6RCBCvOqhBtx4J+we4LS9YExvZKZLcEkW0NIztD+wvaZ4vPtlVFaXUBU1Y9fy/ncZ7UkzsbRDKvpEFkgAgWWMC4se/QPvTP82uXkJw+Ydqq1Ziy3ZC/mnrrQ69+VEArAJJ20Jq06etYMh7ZQeaeqqRZWYCRXRBtct5XEFYKEEOR5gCZ66tN0EwEhq4bnu/Mi6gv4LwNqfp7qokS7zUaiSgX5ozIEZL32KaidL3dTET25gU05ztlbUPBCd7X8xwHdc6F2Mpv2B/AT4B8S3tgZSv2LnAzcGKwIdHo7Tg8d3TuQIfu7EjUlj/n8J4XwWYnIOdtWTEaOSvWHiRSEzaQQrhs9ASEFJ1hXMk6we3gZbAL6NgW0AbhgpJWp+C8Xcf4ATb9PhERh7q8ACGQ02CnfSQch7itqWj2cqSOMzYWWHuM49dHajrAt+Ax8CIoQK7HWgW4pzwFk0xa+YwFO7Dxma+dAjyXPU3FqCCflp4gt0fwuAuLh+zr8i597HMNnKQ/wPqjkF8hgh8iUJ2cVQVZBCZd0emZfwA0p5WfD78XoyJ3BwXev5tcfwTppji/aa415xrum8BzrDmB95wm+zX9fqDc7skEiGxDZT/kccjr20U2ONn0SQkS2Y13evaTIqtjI3sva8aQp4JOwZNe2ZkAI49D3rmaADaYY820u0IpJiWPQ24L2GFQSvqVorZTF0//NbTeKJIA5FJgpMeR+2Lz1keCfny9ShsbtSuJekUUZrXqsV8S5jdo/5ysSyPJXNK2/RsGZ+tcRFqZ6UJeSM65F6WbqLdAye8vPdlCWzSnt1KAW3njBQRoRNZRZH6ts4lYbWsKelibPvkUnEsLT4VoBPI2CzXn3L7WMrrUtfRMqxT3rbnGV+5SWIxU0BAE3czHAtyHiHZmtTDvSNlpZMcwkjEI+0DV8eOleMPM6uXyzZpjiwN8fi9CwEfL7idqjzrRabTSqKk4B+bTO0CFZAIIJ5NfgYf8Jmr9izXsbYydgHQJNNNW71Kh8R5aoLA4xMXKmstK7J8sBfcFi4R9kMUz/iUtJpc/H9IcQY6Mz6878yl5bq5y7A/2Pu3J1WYCtLcjmGTBToRcjGsgzh9F5oToF64KiagGhOr1PXj1yMbflco/5QJ01IiK0F/MQ2AKzLhjpsfQpwQdrp1YFat9CJJw0/djxh3RafZ8m9MxqhT5Z8VfsvDzKAxLRq/ZCxTajblqzipbI1BKch/bCdadYUyP3ALtC9hTVw9vnMkT+/aKAnRRy8fLeq6/Y6NtGn4uoYy8uj1PFPYUBjvHuXBE74M/37rBc9W02SmoOc0gXoD3wQiecESJcwVc+A3/x4YiFjuuW82+uaHejmXj1TVQNi2yzGXD12wUknfBgpJVAkHTeKvkHxReX1+xw8rdVVPgX187sqBCtpOK/eBOcqxfQQrUnsHzkb8Hrq+ZY/9+PduwAL9B+/C8Vrre+Xr+F/m3K/vP9+v+t41G4F+SZd7nf/BxpAAAAABJRU5ErkJggg==","lineLabels":{"aosika":"奥斯卡","mdu":"魔都","modu":"魔都"},"description":"分类片库、详情与原生播放，本机收藏与续播。需配套支持视频协议 2 的 Breeze。","iconSourceUrl":"https://www.mdzyapi.com/favicon.ico"};
config.detailPath = id => `/vod/${id}/`;
config.webPlayback = (_id,_sid,_nid,url) => ['https://www.modujiexi66.com/?url='+url];
module.exports = createCmsVideoPlugin(config);
