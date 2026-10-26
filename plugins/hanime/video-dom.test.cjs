const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { getInfo, getCatalog, getVideoDetail } = require('./hanime1-native.cjs');

// Execute the actual host script, not a duplicate parser. Synthetic fixtures
// contain no real account, cookie, media URL or copied third-party source code.
const root = process.env.BREEZE_ROOT || path.resolve(__dirname, '../Breeze');
const selectors = getInfo().function[0].action.payload.selectors;
const scripts = JSON.parse(execFileSync('dart', ['script/lint/video_dom_scripts.dart', JSON.stringify(selectors)],
  { cwd: root, encoding: 'utf8' }));
function documentFor(body, pageUrl = 'https://hanime1.me/search?sort=Test') {
  const { window } = parseHTML(`<html><head></head><body>${body}</body></html>`);
  Object.defineProperty(window.document, 'readyState', { value: 'complete', configurable: true });
  Object.defineProperty(window.document, 'forms', { get: () => Array.from(window.document.querySelectorAll('form')), configurable: true });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ height: 80, bottom: 746, top: 0 });
  const context = { window, document: window.document, URL, location: new URL(pageUrl), innerHeight: 746,
    innerWidth: 440, navigator: { cookieEnabled: true, onLine: true, userAgent: 'fixture' },
    performance: { getEntriesByType: () => [] },
    getComputedStyle: node => ({ position: node.style.position || 'static' }), MutationObserver: window.MutationObserver };
  return { ...context, run: source => vm.runInNewContext(source, context) };
}

test('watch video in a still-parsing document must not publish a partial detail', () => {
  const env = documentFor('<video id="player" src="https://media.example.test/clip.mp4"></video>', 'https://hanime1.me/watch?v=42');
  Object.defineProperty(env.document, 'readyState', { value: 'loading', configurable: true });
  assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, false);
  // DOM parsing, not optional metadata or slow images/subframes, gates readiness.
  Object.defineProperty(env.document, 'readyState', { value: 'interactive', configurable: true });
  assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, true);
  Object.defineProperty(env.document, 'readyState', { value: 'complete', configurable: true });
  assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, true);
});

const accountHeader = '<a id="user-modal-trigger" href="/user/42"><img src="/avatar.jpg"></a><span id="user-modal-name">Example account</span>';
for (const path of ['/user/42', '/user/42/histories', '/user/42/saves', '/user/42/likes']) {
  test(`native personal data and library cards for ${path}`, () => {
    const env = documentFor(`${accountHeader}<div class="user-nav-bar"><a class="yt-tab" href="/user/42">Home</a><a class="yt-tab" href="/user/42/saves">Later</a></div><div class="content-padding-new"><div class="profile-avatar-wrapper"><img src="/avatar.jpg"></div><h1 class="profile-display-name">Example account</h1><div class="user-tab-item-wrapper"><a href="/watch?v=42"><img src="/poster.jpg"><span class="video-title">Library video</span></a></div><a href="/user/42/edit">Edit</a></div>`, `https://hanime1.me${path}`);
    const snapshot = JSON.parse(env.run(scripts.catalog));
    const data = getCatalog({ pageUrl: `https://hanime1.me${path}`, snapshot }).data;
    assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, true);
    assert.equal(data.account.status, 'signedIn');
    assert.equal(data.account.name, 'Example account');
    assert.equal(data.videos[0].watchUrl, 'https://hanime1.me/watch?v=42');
    assert.ok(data.account.links.some(link => link.url.endsWith('/saves')));
    assert.equal(data.account.links.some(link => link.url.endsWith('/edit')), false);
  });
}

test('real account navigation preserves seven observed libraries and a separate settings target', () => {
  const pageUrl = 'https://hanime1.me/user/42/uploaded';
  const kinds = ['', 'histories', 'saves', 'likes', 'playlists', 'uploaded', 'uploading'];
  const tabs = kinds.map((kind, i) => `<a class="yt-tab" href="/user/42${kind ? '/' + kind : ''}">Library ${i}</a>`).join('');
  const env = documentFor(`${accountHeader}<a href="/user/42/edit">Settings</a><div class="user-nav-bar">${tabs}<a href="/user/99/edit">Other account</a></div><div class="content-padding-new"></div>`, pageUrl);
  const snapshot = JSON.parse(env.run(scripts.catalog));
  const data = getCatalog({ pageUrl, snapshot }).data;
  assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, true);
  assert.equal(data.account.settingsUrl, 'https://hanime1.me/user/42/edit');
  assert.deepEqual(data.account.links.map(link => new URL(link.url).pathname), kinds.map(kind => '/user/42' + (kind ? '/' + kind : '')));
  assert.equal(data.account.links.some(link => link.url.endsWith('/edit')), false);
});

test('account edit password fields do not become signed-out auth or enter catalog data', () => {
  const env = documentFor(`${accountHeader}<div class="content-padding"><form action="/user/42" method="post"><input name="type" value="password"><input type="password" name="password_old" value="private-password"><input name="email" value="private@example.test"></form><a href="/user/42/edit">Settings</a></div>`, 'https://hanime1.me/user/42/edit');
  const snapshot = JSON.parse(env.run(scripts.catalog));
  assert.equal(snapshot.account.loginForm, false);
  assert.equal(snapshot.account.settingsUrl, '/user/42/edit');
  assert.equal(JSON.stringify(snapshot).includes('private-password'), false);
  assert.equal(JSON.stringify(snapshot).includes('private@example.test'), false);
});

test('subscriptions use their distinct card layout and remain native', () => {
  const pageUrl = 'https://hanime1.me/subscriptions';
  const env = documentFor(`${accountHeader}<div class="content-padding-new"><div class="video-item-container-new" title="Subscription video"><a class="video-link-new" href="/watch?v=55"><img class="main-thumb-new" src="/poster.jpg"></a></div></div>`, pageUrl);
  const data = getCatalog({ pageUrl, snapshot: JSON.parse(env.run(scripts.catalog)) }).data;
  assert.equal(data.videos[0].title, 'Subscription video');
  assert.equal(data.videos[0].watchUrl, 'https://hanime1.me/watch?v=55');
});

test('playlist index and detail have native destinations and safe pagination', () => {
  const indexUrl = 'https://hanime1.me/user/42/playlists';
  const env = documentFor(`${accountHeader}<div class="content-padding"><div class="playlist-card"><a href="/playlist?list=abc"><img src="/poster.jpg"><span class="playlist-title">Example list</span></a></div></div>`, indexUrl);
  const data = getCatalog({ pageUrl: indexUrl, snapshot: JSON.parse(env.run(scripts.catalog)) }).data;
  assert.equal(data.videos[0].pageUrl, 'https://hanime1.me/playlist?list=abc');
  const detailUrl = data.videos[0].pageUrl;
  const detail = documentFor(`${accountHeader}<h1 class="playlist-title">Example list</h1><div class="playlist-video-list"><div class="user-tab-item-wrapper"><a href="/watch?v=99"><img class="main-thumb" src="/poster.jpg"><span class="video-title">List video</span></a></div></div><ul class="pagination"><li class="page-item"><a class="page-link" href="/playlist?list=other&page=2">2</a></li></ul>`, detailUrl);
  const normalized = getCatalog({ pageUrl: detailUrl, snapshot: JSON.parse(detail.run(scripts.catalog)) }).data;
  assert.equal(normalized.title, 'Example list');
  assert.equal(normalized.videos[0].watchUrl, 'https://hanime1.me/watch?v=99');
  assert.equal(normalized.paging.nextUrl, '');
});

test('signed out personal page never invents identity or reads password fields', () => {
  const pageUrl = 'https://hanime1.me/login';
  const env = documentFor('<form action="/login"><input name="password" type="password" value="must-not-be-read"><input name="_token" value="private-token"></form>', pageUrl);
  const snapshot = JSON.parse(env.run(scripts.catalog));
  const data = getCatalog({ pageUrl, snapshot }).data;
  assert.equal(data.account.status, 'signedOut');
  assert.equal(data.account.name, '');
  assert.equal(JSON.stringify(snapshot).includes('must-not-be-read'), false);
  assert.equal(JSON.stringify(snapshot).includes('private-token'), false);
});

test('author search results preserve their actual name-search action without claiming a profile identity', () => {
  const pageUrl = 'https://hanime1.me/search?type=artist';
  const env = documentFor('<div class="content-padding-new"><div class="search-artist-card"><a class="overlay" href="/search?query=Example"><img src="/artist.jpg"><span class="search-artist-title">Example artist</span><span class="search-artist-count">12 部作品</span></a></div></div>', pageUrl);
  const snapshot = JSON.parse(env.run(scripts.catalog));
  const data = getCatalog({ pageUrl, snapshot }).data;
  assert.equal(snapshot.artists[0].subtitle, '12 部作品');
  assert.equal(data.videos.length, 1);
  assert.equal(data.videos[0].subtitle, '12 部作品');
  assert.equal(data.videos[0].kind, 'creatorSearch');
  assert.equal(data.videos[0].creatorName, undefined);
  assert.equal(data.videos[0].pageUrl, 'https://hanime1.me/search?query=Example');
  assert.equal(data.videos[0].nameSearchUrl, 'https://hanime1.me/search?query=Example');
  assert.equal(data.videos[0].profileUrl, '');
  assert.equal(data.videos[0].entityKey, '');
  assert.equal(data.videos[0].identityState, 'unresolved');
  assert.equal(data.videos[0].lookup, undefined);
  assert.equal(data.videos[0].watchUrl, undefined);
});

test('author search subtitles preserve bounded public text without inventing statistics', () => {
  const pageUrl = 'https://hanime1.me/search?type=artist';
  const normalize = raw => getCatalog({ pageUrl, snapshot: { artists: [
    { title: 'Example artist', url: '/search?query=Example', ...raw },
  ] } }).data.videos[0];
  assert.equal(normalize({}).subtitle, '');
  const zero = normalize({ subtitle: ' 0\n 部作品 ' });
  assert.equal(zero.subtitle, '0 部作品');
  assert.equal(zero.videoCount, undefined);
  assert.equal(zero.viewCount, undefined);
  assert.equal(normalize({ subtitle: ` 公开\n${'文'.repeat(130)} ` }).subtitle,
    `公开 ${'文'.repeat(117)}`);
});

test('search author cards preserve actual self, outer and inner targets but never invent a lookup', () => {
  const pageUrl = 'https://hanime1.me/search?type=artist';
  for (const markup of [
    '<a class="search-artist-card" href="/search?query=actual-key"><span class="search-artist-title">Display name</span></a>',
    '<a href="/search?query=actual-key"><div class="search-artist-card"><span class="search-artist-title">Display name</span></div></a>',
    '<div class="search-artist-card"><a class="overlay" href="/">Home</a><a href="/search?query=actual-key"><span class="search-artist-title">Display name</span></a></div>',
  ]) {
    const env = documentFor(`<div class="content-padding-new">${markup}</div>`, pageUrl);
    const data = getCatalog({ pageUrl, snapshot: JSON.parse(env.run(scripts.catalog)) }).data;
    assert.equal(data.videos[0].nameSearchUrl, 'https://hanime1.me/search?query=actual-key');
    assert.equal(data.videos[0].profileUrl, '');
    assert.equal(data.videos[0].title, 'Display name');
    assert.equal(data.videos[0].lookup, undefined);
  }
  const missing = documentFor('<div class="content-padding-new"><div class="search-artist-card"><a href="/"><span class="search-artist-title">Display name</span></a></div></div>', pageUrl);
  const snapshot = JSON.parse(missing.run(scripts.catalog));
  assert.equal(snapshot.artists[0].url, '');
  assert.equal(JSON.stringify(snapshot).includes('type=artist&query=Display'), false);
  assert.throws(() => getCatalog({ pageUrl, snapshot }), /catalog_results_unrecognized/);
});

test('responsive subscription artist-option nodes are filters and never create empty author entities', () => {
  const pageUrl = 'https://hanime1.me/subscriptions';
  const filter = '<div class="subscriptions-artist-card artist-option"><img src="/avatar.jpg"><div class="search-artist-title">Display name</div></div>';
  const env = documentFor(`${accountHeader}<div class="mobile-subscriptions-nav">${filter}</div><div class="desktop-subscriptions-nav">${filter}</div><div class="content-padding-new"></div>`, pageUrl);
  const snapshot = JSON.parse(env.run(scripts.catalog));
  assert.deepEqual(snapshot.artists, []);
  assert.deepEqual(snapshot.creatorGroups, []);
  const data = getCatalog({ pageUrl, snapshot }).data;
  assert.deepEqual(data.creators, []);
  assert.deepEqual(data.creatorGroups, []);
});

test('watch avatar profile, artist management target and name-search remain distinct from uploader', () => {
  const pageUrl = 'https://hanime1.me/watch?v=42';
  const artist = '<section><a href="/user/101"><img src="/creator-avatar.jpg"></a><div><div><a id="video-artist-name" href="/search?query=canonical-key&genre=Example">Display name</a></div></div></section>';
  const form = '<form id="video-subscribe-form" action="/subscribe"><input type="hidden" name="_token" value="synthetic-private-token"><input name="subscribe-user-id" value="42"><input name="subscribe-artist-id" value="11"></form>';
  const env = documentFor(`${accountHeader}${artist}${form}<div class="video-description-panel"><a href="/user/99"><img src="/uploader-avatar.jpg">Uploader name</a></div>`, pageUrl);
  const snapshot = JSON.parse(env.run(scripts.detail));
  assert.equal(snapshot.creator.profileUrl, 'https://hanime1.me/user/101');
  assert.equal(snapshot.creator.artistId, '11');
  assert.equal(JSON.stringify(snapshot).includes('synthetic-private-token'), false);
  const data = getVideoDetail({ watchUrl: pageUrl, snapshot: { ...snapshot, title: 'Fixture video' } }).data;
  assert.equal(data.creator.role, 'artist');
  assert.equal(data.creator.url, 'https://hanime1.me/user/101');
  assert.equal(data.creator.profileUrl, 'https://hanime1.me/user/101');
  assert.equal(data.creator.profileId, '101');
  assert.equal(data.creator.artistId, '11');
  assert.equal(data.creator.entityKey, 'artist:11');
  assert.equal(data.creator.nameSearchUrl, 'https://hanime1.me/search?query=canonical-key&genre=Example');
  assert.equal(data.creator.avatarUrl, 'https://hanime1.me/creator-avatar.jpg');
  assert.equal(data.creator.name, 'Display name');
  assert.equal(data.uploader.role, 'uploader');
  assert.equal(data.uploader.url, 'https://hanime1.me/user/99');
  assert.equal(data.uploader.entityKey, 'uploader-profile:99');
  assert.equal(data.uploader.artistId, '');
  assert.equal(data.uploader.name, 'Uploader name');
});

test('watch avatar chooses the overlaid actual image rather than the ratio placeholder', () => {
  const pageUrl = 'https://hanime1.me/watch?v=42';
  const artist = '<section><a href="/user/101"><img src="/artist_avatar_default.jpg"><img style="position:absolute;object-fit:cover" data-src="/actual-avatar.jpg" src="data:image/gif;base64,placeholder"></a><div><div><a id="video-artist-name" href="/search?query=canonical-key">Display name</a></div></div></section>';
  const env = documentFor(artist, pageUrl);
  const snapshot = JSON.parse(env.run(scripts.detail));
  assert.equal(snapshot.creator.profileUrl, 'https://hanime1.me/user/101');
  assert.equal(snapshot.creator.avatarUrl, '/actual-avatar.jpg');
});

test('name navigation stays a name-search action when no actual creator avatar profile exists', () => {
  const pageUrl = 'https://hanime1.me/watch?v=42';
  for (const artist of [
    '<a id="video-artist-name" href="/search?query=canonical-key">Display name</a>',
    '<span id="video-artist-name" data-href="/search?query=canonical-key">Display name</span>',
    '<span id="video-artist-name" onclick="window.location.href=\'/search?query=canonical-key\'">Display name</span>',
  ]) {
    const env = documentFor(`<section><div><div>${artist}</div></div></section><div class="video-description-panel"><a href="/user/99">Uploader name</a></div>`, pageUrl);
    const snapshot = JSON.parse(env.run(scripts.detail));
    const data = getVideoDetail({ watchUrl: pageUrl, snapshot: { ...snapshot, title: 'Fixture video' } }).data;
    assert.equal(data.creator.url, '');
    assert.equal(data.creator.profileUrl, '');
    assert.equal(data.creator.nameSearchUrl, 'https://hanime1.me/search?query=canonical-key');
    assert.equal(data.creator.name, 'Display name');
    assert.equal(data.uploader.url, 'https://hanime1.me/user/99');
  }
});

test('missing, unsafe or ambiguous avatar profiles never become a guessed search or uploader profile', () => {
  const pageUrl = 'https://hanime1.me/watch?v=42';
  for (const avatars of [
    '',
    '<a href="https://evil.example/user/101"><img src="/artist.jpg"></a>',
    '<a href="/user/101"><img src="/artist.jpg"></a><a href="/user/102"><img src="/other.jpg"></a>',
  ]) {
    const env = documentFor(`<section>${avatars}<div><div><span id="video-artist-name">Display name</span></div></div></section><div class="video-description-panel"><a href="/user/99">Uploader name</a></div>`, pageUrl);
    const snapshot = JSON.parse(env.run(scripts.detail));
    const data = getVideoDetail({ watchUrl: pageUrl, snapshot: { ...snapshot, title: 'Fixture video' } }).data;
    assert.equal(data.creator.name, 'Display name');
    assert.equal(data.creator.url, '');
    assert.equal(data.creator.profileUrl, '');
    assert.equal(data.creator.nameSearchUrl, '');
    assert.equal(data.uploader.name, 'Uploader name');
  }
});

test('frequent readiness checks do not walk the DOM or resource timeline', () => {
  const env = documentFor('<div class="content-padding-new"><div class="horizontal-card"></div></div>');
  let scans = 0;
  const original = env.document.querySelectorAll.bind(env.document);
  env.document.querySelectorAll = selector => {
    if (selector === '*') scans++;
    return original(selector);
  };
  for (let i = 0; i < 20; i++) {
    assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, true);
  }
  assert.equal(scans, 0);
  assert.equal(JSON.parse(env.run(scripts.diagnostic)).nativeContent, true);
  assert.equal(scans, 1, 'full diagnostics remain available on demand');
});

test('lightweight observation still recognizes a newly appearing challenge', () => {
  const env = documentFor('<form id="challenge-form"></form>');
  const state = JSON.parse(env.run(scripts.state));
  assert.equal(state.challengeForm, true);
  assert.equal(state.nativeContent, false);
  assert.equal(state.challengeResources, undefined);
});

test('an early homepage heading alone does not start an empty parse', () => {
  const env = documentFor('<div id="home-rows-wrapper"><a class="horizontal-row-title"><h3>Latest</h3></a></div>', 'https://hanime1.me/');
  assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, false);
  env.document.getElementById('home-rows-wrapper').insertAdjacentHTML('beforeend', '<div class="horizontal-card"><a href="/watch?v=42"><span class="title">Example</span></a></div>');
  assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, true);
});

test('a homepage card shared by row and fallback is extracted only once', () => {
  const env = documentFor('<div id="home-rows-wrapper"><a class="horizontal-row-title"><h3>Latest</h3></a><section><div class="home-rows-videos-wrapper horizontal-row"><div class="horizontal-card"><a href="/watch?v=42"><span class="title">Example</span><img src="/poster.jpg"></a></div></div></section></div>', 'https://hanime1.me/');
  const card = env.document.querySelector('.horizontal-card');
  const original = card.querySelector.bind(card);
  let imageQueries = 0;
  card.querySelector = selector => {
    if (selector === selectors.cardImage) imageQueries++;
    return original(selector);
  };
  const snapshot = JSON.parse(env.run(scripts.catalog));
  assert.equal(snapshot.rows[0].cards[0].title, 'Example');
  assert.equal(snapshot.cards[0].title, 'Example');
  assert.equal(imageQueries, 1);
});

for (const genre of ['裏番', '泡麵番', 'Motion Anime']) {
  test(`actual snapshot handles both card layouts for ${genre}`, () => {
    for (const compact of [true, false]) {
      const poster = `<a href="/watch?v=42"><img data-src="/poster.jpg"><span class="${compact ? 'home-rows-videos-title' : 'title'}">Example episode</span></a>`;
      const markup = compact ? `<div class="home-rows-videos-wrapper">${poster}</div>` : `<div class="horizontal-card">${poster}</div>`;
      const url = `https://hanime1.me/search?genre=${encodeURIComponent(genre)}&sort=Test`;
      const env = documentFor(`<div class="content-padding-new">${markup}</div>`, url);
      const snapshot = JSON.parse(env.run(scripts.catalog));
      const result = getCatalog({ pageUrl: url, snapshot });
      assert.equal(result.data.videos.length, 1);
      assert.equal(result.data.videos[0].id, '42');
      assert.equal(result.data.videos[0].coverUrl, 'https://hanime1.me/poster.jpg');
    }
  });
}

test('compact results support outer links, numeric data IDs and metadata on the card itself', () => {
  const pageUrl = 'https://hanime1.me/search?genre=Fixture';
  for (const markup of [
    '<a href="/watch?v=42"><div class="home-rows-videos-wrapper"><img src="/poster.jpg"><span class="home-rows-videos-title">Example episode</span></div></a>',
    '<div class="home-rows-videos-wrapper"><div data-id="42"><img src="/poster.jpg"><span class="home-rows-videos-title">Example episode</span></div></div>',
    '<div class="home-rows-videos-wrapper"><a class="home-rows-videos-title" href="/watch?v=42"><img src="/poster.jpg">Example episode</a></div>',
    '<div class="home-rows-videos-wrapper"><div data-href="/watch?v=42" title="Example episode"><img src="/poster.jpg"></div></div>',
  ]) {
    const env = documentFor(`<div class="content-padding-new">${markup}</div>`, pageUrl);
    const snapshot = JSON.parse(env.run(scripts.catalog));
    const state = JSON.parse(env.run(scripts.state));
    assert.equal(state.nativeContent, true, markup);
    const videos = getCatalog({ pageUrl, snapshot }).data.videos;
    assert.equal(videos.length, 1, markup);
    assert.equal(videos[0].id, '42');
    assert.equal(videos[0].title, 'Example episode');
    assert.equal(videos[0].coverUrl, 'https://hanime1.me/poster.jpg');
  }
});

test('search header and unrelated advertising cards do not confirm an empty result', () => {
  const env = documentFor('<form action="/search"></form><div class="horizontal-card"><a href="https://ads.example/watch?v=42">Advert</a></div>');
  const snapshot = JSON.parse(env.run(scripts.catalog));
  assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, false);
  assert.equal(snapshot.searchPageReady, false);
  assert.throws(() => getCatalog({ pageUrl: env.location.href, snapshot }), /catalog_not_ready/);
});

test('unrelated cards do not suppress valid compact results or turn a confirmed empty result into an error', () => {
  const ads = '<div class="horizontal-card"><a href="https://ads.example/item"><span class="title">Advert</span></a></div>';
  for (const result of [
    '<div class="home-rows-videos-wrapper"><div data-id="42" title="Example"><img src="/poster.jpg"></div></div>',
    '<div class="home-rows-videos-wrapper"><p>No results</p></div>',
  ]) {
    const env = documentFor(`<div class="content-padding-new">${ads}${ads}${result}</div>`);
    const snapshot = JSON.parse(env.run(scripts.catalog));
    const videos = getCatalog({ pageUrl: env.location.href, snapshot }).data.videos;
    assert.equal(videos.length, result.includes('data-id') ? 1 : 0);
    assert.equal(snapshot.resultCardCount, videos.length);
  }
});

test('a streaming or busy result container is not empty; completed unknown content is a structure error', () => {
  const env = documentFor('<div class="content-padding-new"><div class="home-rows-videos-wrapper" aria-busy="true"></div></div>');
  const wrapper = env.document.querySelector('.home-rows-videos-wrapper');
  assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, false);
  wrapper.removeAttribute('aria-busy');
  Object.defineProperty(env.document, 'readyState', { value: 'loading', configurable: true });
  assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, false);
  Object.defineProperty(env.document, 'readyState', { value: 'complete', configurable: true });
  assert.equal(getCatalog({ pageUrl: env.location.href, snapshot: JSON.parse(env.run(scripts.catalog)) }).data.videos.length, 0);
  wrapper.innerHTML = '<article class="new-unknown-card"><img src="/poster.jpg">Unknown result</article>';
  const snapshot = JSON.parse(env.run(scripts.catalog));
  assert.equal(snapshot.searchState, 'unrecognized');
  assert.equal(JSON.parse(env.run(scripts.state)).nativeContent, true, 'settled unknown results enter explicit parser recovery');
  assert.throws(() => getCatalog({ pageUrl: env.location.href, snapshot }), /catalog_results_unrecognized/);
});

test('foreign links and malformed data IDs never become native results', () => {
  const env = documentFor('<div class="content-padding-new"><div class="home-rows-videos-wrapper"><a href="https://ads.example/watch?v=42" data-id="42"><img src="/poster.jpg" alt="Advert"></a><div data-id="not-a-video" title="Unknown"></div></div></div>');
  const snapshot = JSON.parse(env.run(scripts.catalog));
  assert.equal(snapshot.cards.length, 0);
  assert.throws(() => getCatalog({ pageUrl: env.location.href, snapshot }), /catalog_results_unrecognized/);
});

test('an unlinked card on a watch page never inherits the current video URL', () => {
  const env = documentFor('<div class="content-padding-new"><div class="horizontal-card"><img src="/poster.jpg"><span class="title">Unlinked recommendation</span></div></div>', 'https://hanime1.me/watch?v=42');
  const snapshot = JSON.parse(env.run(scripts.catalog));
  assert.equal(snapshot.cards[0].href, '');
});

test('icon text is not a genre; an empty wrapper is not a populated card', () => {
  const env = documentFor('<div class="content-padding-new"><div class="home-rows-videos-wrapper"><p>No results</p></div></div><a href="/search?genre=Test"><i class="material-icons">cast</i>New category</a>');
  const snapshot = JSON.parse(env.run(scripts.catalog));
  assert.equal(snapshot.categoryLinks[0].title, 'New category');
  assert.equal(snapshot.resultCardCount, 0);
  assert.equal(getCatalog({ pageUrl: env.location.href, snapshot }).data.videos.length, 0);
});

test('website fallback keeps site navigation and only optionally hides identified ads', () => {
  const env = documentFor('<nav><a href="/">Home</a><span id="user-modal-trigger">Account</span></nav><div class="ad-container" id="ad">Banner</div><a href="https://ourdream.ai/example" id="banner"><img src="/ad.jpg"></a><div class="ad-container" id="form"><form><input></form></div><iframe id="verification" title="Advertisement" src="https://challenges.cloudflare.com/example"></iframe><video id="player"></video>');
  env.run(scripts.presentation);
  assert.equal(env.document.getElementById('ad').getAttribute('data-breeze-video-hidden'), 'ad');
  assert.equal(env.document.getElementById('banner').getAttribute('data-breeze-video-hidden'), 'ad');
  assert.equal(env.document.querySelector('nav').hasAttribute('data-breeze-video-hidden'), false);
  for (const id of ['verification', 'form', 'player']) assert.equal(env.document.getElementById(id).hasAttribute('data-breeze-video-hidden'), false);
  env.run(scripts.presentationOff);
  assert.equal(env.document.getElementById('ad').hasAttribute('data-breeze-video-hidden'), false);
  assert.equal(env.document.querySelector('nav').hasAttribute('data-breeze-video-hidden'), false);
  env.window.__breezeVideoPresentation.disconnect();
});

test('website cleanup restores earlier navigation hiding and preserves site tools', () => {
  const env = documentFor('<header data-breeze-video-hidden="nav"><a href="/">Home</a><button id="account-tools">Account tools</button></header><footer data-breeze-video-hidden="nav"><a href="/subscriptions">Subscriptions</a><a href="/user/7/playlists">Playlists</a></footer><form method="post" action="/login"><input name="email"><button>Login</button></form>');
  env.run(scripts.presentation);
  assert.equal(env.document.querySelectorAll('[data-breeze-video-hidden="nav"]').length, 0);
  assert.equal(env.document.getElementById('account-tools').textContent, 'Account tools');
  assert.equal(env.document.querySelectorAll('header, footer, form').length, 3);
  assert.equal(env.document.querySelectorAll('a').length, 3);
  env.window.__breezeVideoPresentation.disconnect();
});

test('late ads are handled and a later challenge restores the unmodified page', async () => {
  const env = documentFor('<div id="content">Site content</div>');
  env.run(scripts.presentation);
  const ad = env.document.createElement('div'); ad.className = 'ad-container';
  env.document.body.appendChild(ad);
  await new Promise(setImmediate);
  assert.equal(ad.getAttribute('data-breeze-video-hidden'), 'ad');
  env.window._cf_chl_opt = {};
  env.document.body.appendChild(env.document.createElement('div'));
  await new Promise(setImmediate);
  assert.equal(ad.hasAttribute('data-breeze-video-hidden'), false);
  assert.equal(env.document.getElementById('breeze-video-presentation'), null);
  assert.equal(env.window.__breezeVideoPresentation, undefined);
});

test('a challenge document is never altered by cleanup', () => {
  const env = documentFor('<form id="challenge-form"></form><div class="ad-container"></div>');
  const original = env.document.toString();
  env.run(scripts.presentation);
  assert.equal(env.document.toString(), original);
});


test('subscription DOM ignores structural parent affiliation and uses unique per-card directory aliases', () => {
  const filter = id => `<div class="subscriptions-artist-card artist-option"><img src="/avatar.jpg"><span class="search-artist-title">Artist ${id}</span></div>`;
  const card = (id, owner = '') => `<div class="video-item-container-new" title="Video ${id}"><a href="/watch?v=${id}"><img src="/poster.jpg"></a>${owner ? `<span class="subtitle"><a href="/search?query=artist-${owner}">Artist ${owner}</a></span>` : ''}</div>`;
  const directory = {recognized:true,creators:[11,22].map(id=>({role:'artist',artistId:String(id),entityKey:`artist:${id}`,name:`Artist ${id}`,nameSearchUrl:`/search?query=artist-${id}`}))};
  const pageUrl = 'https://hanime1.me/subscriptions';
  const env = documentFor(`${accountHeader}<div class="content-padding-new"><section>${filter(11)}${card(1)}</section><section>${filter(22)}${card(2,22)}</section>${card(3)}</div>`, pageUrl);
  const snapshot = JSON.parse(env.run(scripts.catalog));
  assert.deepEqual(snapshot.artists, []);
  assert.deepEqual(snapshot.creatorGroups, []);
  const data = getCatalog({ pageUrl, snapshot: {...snapshot,creatorDirectory:directory} }).data;
  assert.deepEqual(data.creatorGroups.map(group => group.videos.map(video => video.id)), [[], ['2']]);
  assert.equal(data.videos.length, 3);
  assert.ok(data.creatorGroups.every(group => group.creator.followed));
  const withoutDirectory = getCatalog({pageUrl,snapshot}).data;
  assert.deepEqual(withoutDirectory.creatorGroups, []);
  assert.equal(withoutDirectory.videos.length, 3, 'unresolved updates remain visible');
});

test('public profile preserves actual uploaded and playlists navigation without becoming the current account', () => {
  const pageUrl='https://hanime1.me/user/101/uploaded';
  const links='<div class="user-nav-bar"><a class="yt-tab" href="/user/101">Profile</a><a class="yt-tab" href="/user/101/uploaded?sort=newest">Uploads</a><a class="yt-tab" href="/user/101/playlists">Playlists</a><a class="yt-tab" href="/user/101/edit">Not public</a><a class="yt-tab" href="/user/42/uploaded">Current account uploads</a><a class="yt-tab" href="https://evil.example/user/101/playlists">External</a></div>';
  const env=documentFor(`${accountHeader}<div class="profile-avatar-wrapper"><img src="/creator.jpg"></div><h1 class="profile-display-name">Creator</h1>${links}<div class="content-padding-new"></div>`,pageUrl);
  const snapshot=JSON.parse(env.run(scripts.catalog));
  const data=getCatalog({pageUrl,snapshot}).data;
  assert.equal(data.publicProfile.profileUrl,'https://hanime1.me/user/101');
  assert.equal(data.publicProfile.name,'Creator');
  assert.equal(data.publicProfile.avatarUrl,'https://hanime1.me/creator.jpg');
  assert.deepEqual(data.publicProfile.links.map(link=>link.url),['https://hanime1.me/user/101','https://hanime1.me/user/101/uploaded?sort=newest','https://hanime1.me/user/101/playlists']);
  assert.equal(data.account.profileUrl,'https://hanime1.me/user/42');
  assert.equal(data.account.isOwnProfile,false);
  assert.notEqual(data.account.name,'Creator');
  assert.equal(data.account.links.some(link=>new URL(link.url).pathname.startsWith('/user/101')),false);
});

test('detail keeps full episode titles and recommendation wrappers without mixing their order', () => {
  const fullTitle = 'Series with a long title Episode 12';
  const env = documentFor(`<meta property="og:title" content="Current"><div id="playlist-scroll">
    <div class="playlist-hover-wrap"><a href="/watch?v=30"><img alt="Short"></a><span class="title" title="${fullTitle}">Series…</span></div>
    <div class="playlist-hover-wrap" title="Series OVA"><a href="/watch?v=2"><img alt="Other"></a></div>
    </div><div id="related-tabcontent"><a href="/watch?v=88"><div class="related-video-margin-bottom"><img src="/related.jpg"></div><div class="home-rows-videos-title">Related full title</div></a></div>`, 'https://hanime1.me/watch?v=30');
  const snapshot = JSON.parse(env.run(scripts.detail));
  const detail = getVideoDetail({watchUrl:'https://hanime1.me/watch?v=30',snapshot}).data;
  assert.deepEqual(detail.episodes.map(card=>card.title), [fullTitle,'Series OVA']);
  assert.deepEqual(detail.episodes.map(card=>card.id), ['30','2']);
  assert.equal(detail.related[0].title, 'Related full title');
  assert.equal(detail.related[0].id, '88');
});

test('public filter schema retains grouped tag wire values, choices and years without account fields', () => {
  const env = documentFor(`<input type="hidden" name="_token" value="private-token"><input name="password" value="private-password">
    <select name="genre"><option value="">All</option><option value="3DCG">3DCG</option></select>
    <select id="year"><option value="">All years</option><option value="2026">2026 年</option><option value="2025">2025 年</option></select>
    <h5>Attributes</h5><label><input type="checkbox" name="tags[]" value="1080p">Full HD</label>
    <label for="tag-two">Smooth</label><input id="tag-two" type="checkbox" name="tags[]" value="60FPS">
    <h5>Other group</h5><label><input type="checkbox" name="tags[]" value="ASMR">Audio</label>
    <input type="hidden" name="tags[]" value="do-not-treat-hidden-selection-as-an-option">`, 'https://hanime1.me/search');
  const schema = env.run(scripts.filterSchema);
  assert.equal(schema.options.genre[1].value,'3DCG');
  assert.equal(schema.tagGroups.Attributes[0].value,'1080p');
  assert.equal(schema.tagGroups.Attributes[1].label,'Smooth');
  assert.equal(schema.tagGroups['Other group'][0].value,'ASMR');
  assert.deepEqual(Array.from(schema.years),['2026','2025']);
  assert.equal(schema.customDate,true);
  assert.equal(JSON.stringify(schema).includes('private-'),false);
  assert.equal(JSON.stringify(schema).includes('do-not-treat-hidden'),false);
  const data = getCatalog({pageUrl:'https://hanime1.me/search',snapshot:{searchState:'empty',searchPageReady:true,cards:[],searchFilters:schema}}).data;
  assert.equal(data.searchFilters.tagGroups.Attributes[0].label,'Full HD');
});

test('detail tag targets use actual first-party filter URLs and reject unrelated targets', () => {
  const env = documentFor(`<meta property="og:title" content="Current"><div class="video-tags-wrapper">
    <div class="single-video-tag"><a href="/search?tags%5B%5D=Wire+tag">Displayed tag</a></div>
    <div class="single-video-tag"><a href="https://other.test/search?tags%5B%5D=bad">Outside</a></div>
    <div class="single-video-tag"><a href="/user/7">Profile</a></div></div>`, 'https://hanime1.me/watch?v=42');
  const data=getVideoDetail({watchUrl:'https://hanime1.me/watch?v=42',snapshot:JSON.parse(env.run(scripts.detail))}).data;
  assert.deepEqual(Object.keys(data.tagTargets),['Displayed tag']);
  assert.deepEqual(new URL(data.tagTargets['Displayed tag']).searchParams.getAll('tags[]'),['Wire tag']);
});

// R05: minimum original public structures with synthetic titles/URLs only.
const metadataCard = ({views = '4208次', rating = '97%', duration = '06:33'} = {}) => `<div class="video-item-container" title="Fixture title"><a href="/watch?v=501"><div class="thumb-container"><img class="main-thumb" src="/poster.jpg"><div class="duration">${duration}</div><div class="stats-container"><div class="stat-item">${views}</div><div class="stat-item"><i class="material-icons">thumb_up</i> ${rating}</div></div></div></a><div class="subtitle"><a href="/search?query=actual-author">Author</a><span class="subtitle-time">&nbsp;• 19分鐘前</span></div></div>`;
const primaryMetadata = (views = '6.4万次', date = '2025-12-24', desktopViews = views, desktopDate = date) => `<div class="video-details-wrapper hidden-sm hidden-md hidden-lg hidden-xl">观看次数：${views}<br>${date}</div><div class="video-description-panel"><div class="hidden-xs">观看次数：${desktopViews}<br>${desktopDate}</div></div>`;
const voteMetadata = (percent = '99%', total = '215', positive = '213', negative = '2') => `<form id="video-like-form" action="/like"><input name="_token" value="synthetic-private-token"><input name="like-status" value="1"><input name="likes-count" value="${positive}"><input name="unlikes-count" value="${negative}"><button id="video-like-btn"><div class="single-icon"><i class="material-icons-outlined">thumb_up</i>${percent}&nbsp;&nbsp;<span>(${total})</span></div></button></form>`;

test('public card metadata keeps separate labelled rating, exact views, duration and relative label', () => {
  const pageUrl='https://hanime1.me/';
  const env=documentFor(`<div class="content-padding-new">${metadataCard()}</div>`,pageUrl);
  const snapshot=JSON.parse(env.run(scripts.catalog));
  const source=snapshot.cards[0];
  assert.equal(source.ratingPercentRaw,'97%');assert.equal(source.ratingPercent,97);
  assert.equal(source.viewCountRaw,'4208次');assert.equal(source.viewCount,4208);
  const card=getCatalog({pageUrl,snapshot}).data.videos[0];
  assert.equal(card.duration,'06:33');assert.equal(card.ratingPercentRaw,'97%');assert.equal(card.ratingPercent,97);
  assert.equal(card.viewCountRaw,'4208次');assert.equal(card.viewCount,4208);
  assert.equal(card.publishedRelative,'• 19分鐘前');
  assert.equal(card.creatorNameSearchUrl,'https://hanime1.me/search?query=actual-author');
});

test('approximate card counts stay raw and missing metadata never becomes zero', () => {
  const pageUrl='https://hanime1.me/';
  for(const views of ['15.1万次','2千次']){
    const env=documentFor(`<div class="content-padding-new">${metadataCard({views})}</div>`,pageUrl);
    const card=getCatalog({pageUrl,snapshot:JSON.parse(env.run(scripts.catalog))}).data.videos[0];
    assert.equal(card.viewCountRaw,views);assert.equal(card.viewCount,null);
  }
  const searchUrl='https://hanime1.me/search?query=fixture';
  const env=documentFor('<div class="home-rows-videos-wrapper"><a href="/watch?v=501"><div class="home-rows-videos-div search-videos"><img src="/poster.jpg"></div><div class="home-rows-videos-title">Fixture</div></a></div>',searchUrl);
  const card=getCatalog({pageUrl:searchUrl,snapshot:JSON.parse(env.run(scripts.catalog))}).data.videos[0];
  for(const field of ['viewCountRaw','viewCount','ratingPercentRaw','ratingPercent','publishedRelative'])assert.equal(card[field],null);
  assert.equal(card.duration,'');
  const zero=documentFor(`<div class="content-padding-new">${metadataCard({views:'0次',rating:'0%'})}</div>`,pageUrl);
  const actualZero=getCatalog({pageUrl,snapshot:JSON.parse(zero.run(scripts.catalog))}).data.videos[0];
  assert.equal(actualZero.viewCount,0);assert.equal(actualZero.ratingPercent,0);
});

test('primary watch metrics use original scopes, deduplicate responsive blocks and whitelist public vote counts', () => {
  const pageUrl='https://hanime1.me/watch?v=501';
  const env=documentFor(`<meta property="og:title" content="Short meta"><span id="shareBtn-title">Full primary title</span>${primaryMetadata()}${voteMetadata()}<div id="related-tabcontent">${metadataCard({views:'999次',rating:'1%'})}</div>`,pageUrl);
  const snapshot=JSON.parse(env.run(scripts.detail));
  assert.equal(snapshot.title,'Full primary title');assert.equal(snapshot.viewCountRaw,'6.4万次');assert.equal(snapshot.viewCount,null);
  assert.equal(snapshot.publishedDate,'2025-12-24');assert.equal(snapshot.ratingPercentRaw,'99%');assert.equal(snapshot.ratingPercent,99);
  assert.equal(snapshot.totalVotes,215);assert.equal(snapshot.positiveVotes,213);assert.equal(snapshot.negativeVotes,2);
  assert.equal(JSON.stringify(snapshot).includes('synthetic-private-token'),false);
  assert.equal(JSON.stringify(snapshot).includes('like-status'),false);
  const detail=getVideoDetail({watchUrl:pageUrl,snapshot}).data;
  for(const key of ['viewCountRaw','viewCount','publishedDate','ratingPercentRaw','ratingPercent','totalVotes','positiveVotes','negativeVotes'])assert.equal(detail[key],snapshot[key]);
});

test('conflicting responsive primary metrics remain unknown and related metrics never fill them', () => {
  const pageUrl='https://hanime1.me/watch?v=501';
  const env=documentFor(`<span id="shareBtn-title">Fixture</span>${primaryMetadata('4208次','2025-12-24','9999次','2026-01-01')}${voteMetadata()}${voteMetadata('98%','216','214','3')}`,pageUrl);
  const snapshot=JSON.parse(env.run(scripts.detail));
  for(const key of ['viewCountRaw','viewCount','publishedDate','ratingPercentRaw','ratingPercent','totalVotes','positiveVotes','negativeVotes'])assert.equal(snapshot[key],null,key);
  const related=documentFor(`<span id="shareBtn-title">Fixture</span><div id="related-tabcontent">${metadataCard()}</div>`,pageUrl);
  const missing=JSON.parse(related.run(scripts.detail));
  for(const key of ['viewCountRaw','viewCount','publishedDate','ratingPercentRaw','ratingPercent','totalVotes','positiveVotes','negativeVotes'])assert.equal(missing[key],null,key);
});

test('public creator counts preserve labelled source values and never mix subscriber and work counts', () => {
  const pageUrl='https://hanime1.me/user/101';
  const env=documentFor(`${accountHeader}<div class="profile-content-right"><h1 class="profile-display-name">Creator</h1><div class="profile-sub-stats"><div class="profile-sub-stats-new-line">5,100 位订阅者 • 30 个视频</div></div></div><div class="content-padding-new"></div>`,pageUrl);
  const snapshot=JSON.parse(env.run(scripts.catalog));
  assert.equal(snapshot.publicProfile.subscriberCountRaw,'5,100 位订阅者');assert.equal(snapshot.publicProfile.subscriberCount,5100);
  assert.equal(snapshot.publicProfile.videoCountRaw,'30 个视频');assert.equal(snapshot.publicProfile.videoCount,30);
  const profile=getCatalog({pageUrl,snapshot}).data.publicProfile;
  assert.equal(profile.subscriberCountRaw,'5,100 位订阅者');assert.equal(profile.subscriberCount,5100);
  assert.equal(profile.videoCountRaw,'30 个视频');assert.equal(profile.videoCount,30);
  const approximate=documentFor('<div class="profile-content-right"><h1 class="profile-display-name">Creator</h1><div class="profile-sub-stats-new-line">1.2万 位订阅者 • 0 个视频</div></div>',pageUrl);
  const raw=JSON.parse(approximate.run(scripts.catalog)).publicProfile;
  assert.equal(raw.subscriberCountRaw,'1.2万 位订阅者');assert.equal(raw.subscriberCount,null);assert.equal(raw.videoCount,0);
});

test('invalid responsive dates and conflicting public profile labels never fall back to one good-looking block', () => {
  const watchUrl='https://hanime1.me/watch?v=501';
  const watch=documentFor(`<span id="shareBtn-title">Fixture</span>${primaryMetadata('4208次','2025-02-29','4208次','2025-12-24')}`,watchUrl);
  assert.equal(JSON.parse(watch.run(scripts.detail)).publishedDate,null);
  const pageUrl='https://hanime1.me/user/101';
  const profile=documentFor('<div class="profile-content-right"><h1 class="profile-display-name">Creator</h1><div class="profile-sub-stats-new-line">5,100 位订阅者 • 30 个视频</div><div class="profile-sub-stats-new-line">5,101 位订阅者 • 31 个视频</div></div>',pageUrl);
  const snapshot=JSON.parse(profile.run(scripts.catalog));
  for(const field of ['subscriberCountRaw','subscriberCount','videoCountRaw','videoCount'])assert.equal(snapshot.publicProfile[field],null);
  assert.equal(snapshot.publicProfile.summary,'');
});

test('episode preparation reads a detached exact-identity document without navigating or executing scripts',async()=>{
 const {DOMParser:BaseParser}=require('linkedom');
 class DOMParser extends BaseParser { parseFromString(...args){const doc=super.parseFromString(...args);Object.defineProperty(doc,'forms',{get:()=>Array.from(doc.querySelectorAll('form'))});return doc;} }
 const env=documentFor('<h1>Current untouched video</h1>','https://hanime1.me/watch?v=7');
 const context={...env, DOMParser,AbortController,setTimeout,clearTimeout,
   fetch:async(url,options)=>{
    assert.equal(url,'https://hanime1.me/watch?v=42');
    assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'manual');
    return {ok:true,type:'basic',headers:{get:()=>null},text:async()=>'<html><head><link rel="canonical" href="https://hanime1.me/watch?v=42"></head><body><span id="shareBtn-title">Prepared target</span><video id="player"><source src="https://media.example.test/42.mp4" size="720"></video><script>throw Error("must not execute")</script></body></html>'};
   }};
 assert.equal(vm.runInNewContext(scripts.episodeReadStart,context),true);
 for(let n=0;n<10&&env.window.__breezeEpisodeReads['episode-test'].status==='pending';n++)await new Promise(resolve=>setImmediate(resolve));
 const job=env.window.__breezeEpisodeReads['episode-test'];assert.equal(job.status,'ready');
 const snapshot=JSON.parse(job.result);assert.equal(snapshot.title,'Prepared target');assert.equal(snapshot.video.sources.length,1);
 assert.equal(env.location.href,'https://hanime1.me/watch?v=7');assert.equal(env.document.querySelector('h1').textContent,'Current untouched video');
 context.fetch=async()=>({ok:true,type:'basic',headers:{get:()=>null},text:async()=>'<link rel="canonical" href="https://hanime1.me/watch?v=99"><video></video>'});
 vm.runInNewContext(scripts.episodeReadStart,context);
 for(let n=0;n<10&&env.window.__breezeEpisodeReads['episode-test'].status==='pending';n++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(env.window.__breezeEpisodeReads['episode-test'].status,'failed');
});

test('personal preview reads only the observed owner history and returns three public cards', async () => {
  const { DOMParser } = require('linkedom');
  const html = `<a id="user-modal-trigger" href="/user/42"></a><nav class="user-nav-bar"></nav><input name="email" value="private@example.test">` +
    Array.from({length:5}, (_,i) => `<div class="user-tab-item-wrapper"><a class="video-link" href="/watch?v=${i+1}"><img src="https://image.example.test/${i}.jpg"><span class="title">Video ${i+1}</span></a></div>`).join('');
  const env = documentFor('', 'https://hanime1.me/user/42');
  let requests = 0;
  const context = {...env, DOMParser, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests++; assert.equal(url,'https://hanime1.me/user/42/histories'); assert.equal(options.credentials,'same-origin'); assert.equal(options.redirect,'error');
      return {ok:true,url,text:async()=>html}; }};
  const value = await vm.runInNewContext(scripts.personalRecent,context);
  assert.equal(value.status,'ok');assert.equal(value.snapshot.cards.length,3);assert.equal(requests,1);
  assert.deepEqual(Array.from(value.snapshot.cards, c=>c.href), ['https://hanime1.me/watch?v=1','https://hanime1.me/watch?v=2','https://hanime1.me/watch?v=3']);
  assert.doesNotMatch(JSON.stringify(value),/private@example|email|Cookie/);
  context.fetch = async url => ({ok:true,url,text:async()=>html.replace('/user/42','/user/99')});
  assert.equal((await vm.runInNewContext(scripts.personalRecent,context)).status,'unavailable');
  const emptyHeader = '<a id="user-modal-trigger" href="/user/42"></a><nav class="user-nav-bar"></nav>';
  context.fetch = async url => ({ok:true,url,text:async()=>emptyHeader});
  assert.equal((await vm.runInNewContext(scripts.personalRecent,context)).status,'unavailable');
  context.fetch = async url => ({ok:true,url,text:async()=>emptyHeader+'<p class="empty-state">没有观看记录</p>'});
  assert.equal((await vm.runInNewContext(scripts.personalRecent,context)).status,'ok');
  context.location = new URL('https://foreign.example.test/');
  assert.equal((await vm.runInNewContext(scripts.personalRecent,context)).status,'unsupported');
});
