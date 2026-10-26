const assert = require('node:assert/strict');
const test = require('node:test');
const { getInfo, getCatalog, getVideoDetail, getPlayback, getSettingsBundle } = require('./hanime1-native.cjs');
const manifest = require('./manifest.json');
const { getAccountBackup, saveAccountBackup, forgetAccountBackup } = require('./hanime1-native.cjs');

function accountBridge() {
  const values = new Map();
  globalThis.bridge = { call: async (method, key, raw) => {
    if (method === 'load_plugin_config') return JSON.stringify({ ok: true, value: values.get(key) ?? JSON.parse(raw) });
    assert.equal(method, 'save_plugin_config');
    values.set(key, JSON.parse(raw));
    return '{"ok":true}';
  } };
  return values;
}

const sessionCookie = (extra = {}) => ({ name: 'site_session', value: 'test-session',
  domain: 'hanime1.me', path: '/', httpOnly: true, expires: null, ...extra });

test('account backup uses plugin config and excludes verification and other sites', async () => {
  const values = accountBridge();
  try {
    await saveAccountBackup({ backup: { version: 1, origin: 'https://hanime1.me', name: 'Example', cookies: [
      sessionCookie(), sessionCookie({ name: 'cf_clearance' }), sessionCookie({ name: '__cf_bm' }),
      sessionCookie({ domain: 'another.example' }), sessionCookie({ name: 'XSRF-TOKEN' }),
      sessionCookie({ httpOnly: false }), sessionCookie({ expires: 1 }),
    ] } });
    const saved = values.get('account.backup');
    assert.equal(saved.name, 'Example');
    assert.equal(saved.cookies.length, 1);
    assert.equal(saved.cookies[0].secure, true);
    assert.deepEqual((await getAccountBackup()).data.backup, saved);
    await forgetAccountBackup();
    assert.equal(values.get('account.backup').deleted, true);
    assert.equal((await getAccountBackup()).data.backup.deleted, true);
  } finally { delete globalThis.bridge; }
});

test('account backup rejects bad origins, expired or empty sessions and failed writes', async () => {
  accountBridge();
  try {
    for (const backup of [
      { version: 1, origin: 'https://another.example', cookies: [sessionCookie()] },
      { version: 1, origin: 'https://hanime1.me', cookies: [sessionCookie({ value: '\r\nsecret' })] },
      { version: 1, origin: 'https://hanime1.me', cookies: [] },
    ]) await assert.rejects(saveAccountBackup({ backup }));
    globalThis.bridge.call = async () => '{"ok":false}';
    await assert.rejects(saveAccountBackup({ backup: { version: 1, origin: 'https://hanime1.me', cookies: [sessionCookie()] } }));
  } finally { delete globalThis.bridge; }
});

test('declares a native catalog action', () => {
  const info = getInfo();
  assert.equal(info.function[0].action.type, 'openVideoCatalog');
  assert.deepEqual(manifest, info);
  assert.equal(info.uuid, '1e600cff-8ebe-4517-8aa4-6678aec46424');
  assert.equal(info.version, '0.11.3');
  assert.equal(info.updateUrl, 'https://api.github.com/repos/kl5212840-lang/Breeze-plugin-Hanime1-native/releases/latest');
  assert.deepEqual(info.function[0].action.payload.tabs.map((item) => item.title),
    ['推荐', '排行', '订阅', '我的']);
  assert.equal(info.function[0].action.payload.nativeAccount, true);
  assert.equal(info.function[0].action.payload.nativeSubscriptions, true);
  assert.equal(info.function[0].action.payload.nativeAuth, true);
  assert.equal(info.function[0].action.payload.nativeSiteActions, true);
  assert.equal(info.function[0].action.payload.nativeSearch, true);
  assert.ok(info.iconUrl.startsWith('data:image/png;base64,'));
  assert.equal(info.iconUrl, require('./manifest.json').iconUrl);
  assert.deepEqual(info.function[0].action.payload.externalAuthenticationEntries, ['https://hanime1.me/auth/google']);
  assert.equal(info.function[0].action.payload.tabs[2].mode, 'catalog');
  assert.equal(new URL(info.function[0].action.payload.tabs[1].url).searchParams.get('sort'), '本日排行');
  assert.deepEqual(info.function[0].action.payload.categories.map((item) => item.title),
    ['全部', '里番', '泡面番', 'Motion Anime', '3DCG', '2.5D', '2D动画', 'AI生成', 'MMD', 'Cosplay']);
  assert.equal(new URL(info.function[0].action.payload.categories[1].url).searchParams.get('genre'), '裏番');
});

test('video settings use the existing persistent plugin config bridge', async () => {
  globalThis.bridge = { call: async (method, key) => {
    assert.equal(method, 'load_plugin_config');
    return JSON.stringify({ ok: true, value: {
      'video.defaultMode': 'website', 'video.parseTimeoutSeconds': '45',
      'video.preferredSource': 'highest', 'video.refreshExpiredSources': false,
    }[key] });
  } };
  try {
    const settings = await getSettingsBundle();
    assert.equal(settings.data.mediaType, 'video');
    assert.equal(settings.data.values['video.defaultMode'], 'native');
    assert.equal(settings.data.values['video.parseTimeoutSeconds'], '45');
    assert.equal(settings.data.values['video.refreshExpiredSources'], false);
    assert.equal(settings.scheme.sections[0].fields.length, 4);
    assert.equal(settings.data.values['video.hideAdvertisements'], true);
  } finally { delete globalThis.bridge; }
  const defaults = await getSettingsBundle();
  assert.equal(defaults.data.values['video.defaultMode'], 'native');
});

test('catalog keeps only unique first-party videos', () => {
  const result = getCatalog({
    snapshot: { rows: [{ title: '最新上市', moreUrl: '/search?sort=date', cards: [
      { href: '/watch?v=408773', title: 'Episode 1', coverUrl: '/poster.jpg' },
      { href: '/watch?v=408773', title: 'Duplicate' },
      { href: 'https://evil.test/watch?v=1', title: 'Advertisement' },
    ] }] },
  });
  assert.equal(result.data.sections[0].videos.length, 1);
  assert.equal(result.data.sections[0].videos[0].watchUrl,
    'https://hanime1.me/watch?v=408773');
  assert.equal(result.data.sections[0].videos[0].coverUrl,
    'https://hanime1.me/poster.jpg');
  assert.equal(result.data.sections[0].moreUrl,
    'https://hanime1.me/search?sort=date');
});

test('homepage normalizes displayed rows without revisiting the flat fallback', () => {
  const snapshot = { rows: [{ title: 'Latest', cards: [{ href: '/watch?v=42', title: 'Episode' }] }] };
  Object.defineProperty(snapshot, 'cards', { get() { throw new Error('unused fallback'); } });
  const result = getCatalog({ snapshot });
  assert.equal(result.data.sections[0].videos.length, 1);
  assert.deepEqual(result.data.videos, []);
  const fallback = getCatalog({ snapshot: {
    rows: [{ title: 'Broken', cards: [{ href: 'https://evil.test/watch?v=42', title: 'Ad' }] }],
    cards: [{ href: '/watch?v=43', title: 'Fallback' }],
  } });
  assert.equal(fallback.data.videos[0].id, '43');
});

test('catalog adds only first-party official genre links from the loaded page', () => {
  const result = getCatalog({
    snapshot: {
      cards: [{ href: '/watch?v=42', title: 'A result' }],
      categoryLinks: [
        { title: 'cast', url: '/search?genre=not-a-category' },
        { title: '新分类', url: '/search?genre=New' },
        { title: '广告', url: 'https://evil.test/search?genre=Ad' },
        { title: '重复', url: '/search?genre=New' },
      ],
      genreOptions: [{ title: 'Cosplay', value: 'Cosplay' }],
    },
  });
  assert.deepEqual(result.data.categories.map((item) => item.title), ['新分类', 'Cosplay']);
  assert.equal(result.data.categories[0].url, 'https://hanime1.me/search?genre=New');
});

test('catalog rejects a verification page instead of showing an empty feed', () => {
  assert.throws(() => getCatalog({ snapshot: { cards: [] } }), /验证/);
  assert.throws(() => getCatalog({ pageUrl: 'https://evil.test/' }));
  assert.throws(() => getCatalog({ pageUrl: 'https://hanime1.me:444/' }));
});

test('search distinguishes a real empty result from a verification page', () => {
  const result = getCatalog({
    pageUrl: 'https://hanime1.me/search?query=unlikely',
    snapshot: { searchPageReady: true, cards: [] },
  });
  assert.deepEqual(result.data.videos, []);
  assert.throws(() => getCatalog({
    pageUrl: 'https://hanime1.me/search?query=unlikely',
    snapshot: { searchPageReady: false, cards: [] },
  }), /验证/);
});

test('search paging follows only first-party result pages', () => {
  const result = getCatalog({
    pageUrl: 'https://hanime1.me/search?query=sample&page=2',
    snapshot: {
      rows: [{ title: 'Trending suggestions', cards: [
        { href: '/watch?v=99', title: 'Not this search result' },
      ] }],
      cards: [{ href: '/watch?v=42', title: 'A result' }],
      pagination: [
        { href: '/search?query=sample&page=1', label: '1' },
        { href: '/search?query=sample&page=3', label: '3' },
        { href: 'https://evil.test/search?page=4', label: '4' },
      ],
    },
  });
  assert.equal(result.data.paging.page, 2);
  assert.equal(result.data.sections.length, 0);
  assert.equal(result.data.videos[0].id, '42');
  assert.equal(result.data.paging.totalPages, 3);
  assert.match(result.data.paging.nextUrl, /page=3/);
  assert.equal(result.data.paging.previousUrl,
    'https://hanime1.me/search?query=sample&page=1');
});

test('a populated or multi-page document cannot masquerade as an empty result', () => {
  for (const extra of [
    { resultCardCount: 3 },
    { pagination: [{ href: '/search?genre=Test&page=73', label: '73' }] },
  ]) {
    assert.throws(() => getCatalog({ pageUrl: `${getInfo().home}search?genre=Test`,
      snapshot: { searchPageReady: true, cards: [], ...extra } }), /不是普通空结果/);
  }
});

test('detail normalizes episodes, recommendations, and text', () => {
  const result = getVideoDetail({
    watchUrl: 'https://hanime1.me/watch?v=408773',
    snapshot: {
      title: 'A title - Hanime1.me', description: '  Short\n summary ',
      tags: [' HD ', 'HD', '动画'],
      episodes: [{ href: '/watch?v=408773', title: '第 1 集' }],
      related: [{ href: '/watch?v=2', title: 'Related' }],
    },
  });
  assert.equal(result.data.id, '408773');
  assert.equal(result.data.title, 'A title');
  assert.equal(result.data.description, 'Short summary');
  assert.deepEqual(result.data.tags, ['HD', '动画']);
  assert.equal(result.data.episodes.length, 1);
  assert.equal(result.data.related.length, 1);
});

test('playback rejects insecure links and retains first-party referer', () => {
  const result = getPlayback({
    watchUrl: 'https://hanime1.me/watch?v=408773',
    snapshot: { title: 'A title - Hanime1.me', video: { sources: [
      { src: 'http://evil.test/video.mp4' },
      { src: 'https://cdn.example/video.m3u8', label: '1080p' },
    ] } },
  });
  assert.equal(result.data.sources.length, 1);
  assert.equal(result.data.title, 'A title');
  assert.equal(result.data.sources[0].quality, '1080p');
  assert.equal(result.data.sources[0].headers.Referer,
    'https://hanime1.me/watch?v=408773');
});

test('playback can use a declared preload source before video starts', () => {
  const result = getPlayback({
    watchUrl: 'https://hanime1.me/watch?v=408773',
    snapshot: { title: 'A title', video: { preloadSrc: '/media/sample.mp4' } },
  });
  assert.equal(result.data.sources[0].url,
    'https://hanime1.me/media/sample.mp4');
});


// R04 fixtures model original management-row identities and actual per-card
// aliases. They are structural regressions, not proof of a live account read.
const directoryArtist = (id, nameSearchUrl, extra = {}) => ({
  role: 'artist', artistId: String(id), entityKey: `artist:${id}`, name: 'Same name',
  nameSearchUrl, profileUrl: '', profileId: '', ...extra,
});

test('subscription ownership uses stable artist IDs and exact observed aliases, keeping unknown works', () => {
  const pageUrl = 'https://hanime1.me/subscriptions';
  const cards = [
    { href: '/watch?v=1', title: 'First', creatorUrl: '/search?query=first-key', creatorName: 'Same name' },
    { href: '/watch?v=2', title: 'Second', creatorUrl: '/search?query=second-key', creatorName: 'Same name' },
    { href: '/watch?v=3', title: 'Unassigned', creatorName: 'Same name' },
    { href: '/watch?v=4', title: 'Unsafe affiliation', creatorUrl: 'https://evil.test/user/11', creatorName: 'Unsafe' },
  ];
  const first = directoryArtist(11, '/search?query=first-key', { profileUrl: '/user/101' });
  const second = directoryArtist(22, '/search?query=second-key', { profileUrl: '/user/202' });
  const data = getCatalog({ pageUrl, snapshot: { cards, personalPageReady: true,
    creatorDirectory: { recognized: true, creators: [first, second] },
    // A containing section is not affiliation: card 2 belongs to its own alias.
    creatorGroups: [{ creator: first, cards: [cards[1]] }],
  } }).data;
  assert.deepEqual(data.creatorGroups.map(group => group.creator.entityKey), ['artist:11', 'artist:22']);
  assert.deepEqual(data.creatorGroups.map(group => group.videos.map(card => card.id)), [['1'], ['2']]);
  assert.ok(data.creatorGroups.every(group => group.creator.followed));
  assert.equal(data.creatorGroups[0].creator.profileId, '101', 'profile ID is an independent namespace');
  assert.equal(data.creatorGroups[0].creator.artistId, '11');
  assert.equal(data.videos.length, 4, 'the flat compatibility payload retains unassigned works');
  assert.equal(data.videos[3].creatorUrl, undefined);
});

test('same-name artists with a shared alias remain distinct and ambiguous cards stay unassigned', () => {
  const first = directoryArtist(11, '/search?query=shared', { profileUrl: '/user/101' });
  const second = directoryArtist(22, '/search?query=shared', { profileUrl: '/user/202' });
  const cards = [
    { href: '/watch?v=5', title: 'Ambiguous alias', creatorUrl: '/search?query=shared' },
    { href: '/watch?v=6', title: 'Ambiguous multiple targets', creatorProfileUrl: '/user/101', creatorNameSearchUrl: '/search?query=shared' },
    { href: '/watch?v=7', title: 'Parent alone does not establish ownership' },
  ];
  const data = getCatalog({ pageUrl: 'https://hanime1.me/subscriptions', snapshot: {
    cards, personalPageReady: true, creatorDirectory: { recognized: true, creators: [first, second] },
    creatorGroups: [{ creator: first, cards: [cards[2]] }],
  } }).data;
  assert.deepEqual(data.creatorGroups.map(group => group.creator.entityKey), ['artist:11', 'artist:22']);
  assert.deepEqual(data.creatorGroups.map(group => group.videos.length), [0, 0]);
  assert.deepEqual(data.videos.map(video => video.id), ['5', '6', '7']);
});

test('an observed name-search alias is not weakened by stripping genre, sort or page', () => {
  const data = getCatalog({ pageUrl: 'https://hanime1.me/subscriptions', snapshot: {
    personalPageReady: true,
    creatorDirectory: { recognized: true, creators: [directoryArtist(11, '/search?query=actual-key')] },
    cards: [
      { href: '/watch?v=1', title: 'Exact', creatorUrl: '/search?query=actual-key' },
      { href: '/watch?v=2', title: 'Different genre', creatorUrl: '/search?query=actual-key&genre=Example' },
      { href: '/watch?v=3', title: 'Different sort', creatorUrl: '/search?query=actual-key&sort=latest' },
      { href: '/watch?v=4', title: 'Different page', creatorUrl: '/search?query=actual-key&page=2' },
    ],
  } }).data;
  assert.equal(data.creatorGroups.length, 1);
  assert.deepEqual(data.creatorGroups[0].videos.map(video => video.id), ['1']);
  assert.equal(data.videos.length, 4);
  assert.equal(data.creatorGroups[0].creator.profileUrl, '', 'a management ID never manufactures a profile');
});

test('same artist ID deduplicates management rows without merging same-name identities', () => {
  const same = directoryArtist(11, '/search?query=first-key');
  const data = getCatalog({ pageUrl: 'https://hanime1.me/subscriptions', snapshot: {
    personalPageReady: true,
    creatorDirectory: { recognized: true, creators: [same, { ...same, profileUrl: '/user/101' }, directoryArtist(22, '/search?query=second-key')] },
    cards: [{ href: '/watch?v=1', title: 'First', creatorUrl: '/search?query=first-key' }],
  } }).data;
  assert.equal(data.creatorGroups.length, 2);
  assert.equal(data.creatorGroups[0].creator.entityKey, 'artist:11');
  assert.equal(data.creatorGroups[0].creator.profileUrl, 'https://hanime1.me/user/101');
  assert.deepEqual(data.creatorGroups.map(group => group.videos.length), [1, 0]);
});

test('subscription group normalization has a total card budget and rejects cross-site affiliation', () => {
  const groups = Array.from({ length: 80 }, (_, author) => ({
    creator: directoryArtist(author + 1, `/search?query=artist-${author}`),
    cards: Array.from({ length: 160 }, (_, card) => ({ href: `/watch?v=${author * 160 + card + 1}`, title: 'Video',
      creatorUrl: `/search?query=artist-${author}` })),
  }));
  groups[0].cards.push({ href: '/watch?v=999999', title: 'External artist', creatorUrl: 'https://evil.test/search?query=artist-0' });
  const data = getCatalog({ pageUrl: 'https://hanime1.me/subscriptions', snapshot: {
    personalPageReady: true, creatorDirectory: { recognized: true, creators: groups.map(group => group.creator) }, creatorGroups: groups,
  } }).data;
  assert.ok(data.creatorGroups.length <= 80);
  assert.equal(data.creatorGroups.reduce((sum, group) => sum + group.videos.length, 0), 320);
  assert.ok(data.creatorGroups.every(group => group.videos.every(card => card.id !== '999999')));
});

test('public metadata sanitizes exact versus approximate values without invented zeroes', () => {
  const pageUrl='https://hanime1.me/';
  const cards=[
    {href:'/watch?v=1',title:'Exact',viewCountRaw:'1,234次',viewCount:1234,ratingPercentRaw:'99.5%',duration:'06:33',publishedRelative:'• 1天前'},
    {href:'/watch?v=2',title:'Approximate',viewCountRaw:'1.2万次',viewCount:12000,ratingPercentRaw:'101%',ratingPercent:101},
    {href:'/watch?v=3',title:'Absent'},
    {href:'/watch?v=4',title:'Zero',viewCountRaw:'0次',ratingPercentRaw:'0%'},
    {href:'/watch?v=5',title:'Invalid grouping',viewCountRaw:'1,2次'},
  ];
  const videos=getCatalog({pageUrl,snapshot:{cards}}).data.videos;
  assert.equal(videos[0].viewCount,1234);assert.equal(videos[0].ratingPercent,99.5);assert.equal(videos[0].publishedRelative,'• 1天前');
  assert.equal(videos[1].viewCountRaw,'1.2万次');assert.equal(videos[1].viewCount,null);assert.equal(videos[1].ratingPercent,null);
  for(const key of ['viewCountRaw','viewCount','ratingPercentRaw','ratingPercent','publishedRelative'])assert.equal(videos[2][key],null);
  assert.equal(videos[3].viewCount,0);assert.equal(videos[3].ratingPercent,0);assert.equal(videos[4].viewCount,null);
});

test('primary metadata does not infer votes from percentages and preserves plain valid dates', () => {
  const watchUrl='https://hanime1.me/watch?v=501';
  const detail=getVideoDetail({watchUrl,snapshot:{title:'Fixture',viewCountRaw:'4208次',publishedDate:'2024-02-29',ratingPercentRaw:'99%',totalVotes:215,positiveVotes:213,negativeVotes:2}}).data;
  assert.equal(detail.viewCount,4208);assert.equal(detail.publishedDate,'2024-02-29');assert.equal(detail.ratingPercent,99);
  assert.equal(detail.totalVotes,215);assert.equal(detail.positiveVotes,213);assert.equal(detail.negativeVotes,2);
  for(const date of ['2025-02-29','2025-13-01','2025-01-32','2025-12-24T00:00:00Z'])assert.equal(getVideoDetail({watchUrl,snapshot:{title:'Fixture',publishedDate:date}}).data.publishedDate,null);
  const unknown=getVideoDetail({watchUrl,snapshot:{title:'Fixture',ratingPercentRaw:'99%'}}).data;
  assert.equal(unknown.totalVotes,null);assert.equal(unknown.positiveVotes,null);assert.equal(unknown.negativeVotes,null);
  const invalid=getVideoDetail({watchUrl,snapshot:{title:'Fixture',totalVotes:-1,positiveVotes:1.2,negativeVotes:Number.MAX_SAFE_INTEGER+1}}).data;
  assert.equal(invalid.totalVotes,null);assert.equal(invalid.positiveVotes,null);assert.equal(invalid.negativeVotes,null);
});
