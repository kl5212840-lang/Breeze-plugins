const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML, DOMParser } = require('linkedom');
const { getInfo } = require('./hanime1-native.cjs');

const scripts = JSON.parse(execFileSync('dart', ['script/lint/video_dom_scripts.dart',
  JSON.stringify(getInfo().function[0].action.payload.selectors)],
  { cwd: process.env.BREEZE_HOST_ROOT || path.resolve(__dirname, '../../../Breeze'), encoding: 'utf8' }));
const home = 'https://hanime1.me';
const watch = `${home}/watch?v=42`;
const account = '<a id="user-modal-trigger" href="/user/7">Account</a>';
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${value}">`;
const csrf = hidden('_token', 'browser-only-csrf');
const likeForm = (status = '') => `<form method="post" action="/like">${csrf}${hidden('like-foreign-id', '42')}${hidden('like-user-id', '7')}${hidden('like-status', status)}${hidden('like-is-positive','1')}</form>`;
const followForm = (status = '', artist = '12', id = '') => `<form ${id ? `id="${id}"` : ''} method="post" action="/subscribe">${csrf}${hidden('subscribe-user-id','7')}${hidden('subscribe-artist-id',artist)}${hidden('subscribe-status',status)}</form>`;
const playlistForm = `<form method="post" action="/playlist/abc">${csrf}${hidden('_method', 'PUT')}<input name="playlist-title" value="Old title"><textarea name="playlist-description">Old description</textarea><input type="checkbox" name="playlist-delete"></form>`;

class BrowserFormData {
  constructor(form) {
    this.items = [...form.querySelectorAll('input,textarea')]
      .filter(n => n.name && !n.disabled && (n.type !== 'checkbox' || n.checked))
      .map(n => [n.name, n.value || '']);
  }
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
}
function browser(body, url = watch, fetch = () => { throw Error('Unexpected request'); }) {
  const { window } = parseHTML(`<html><body>${body}</body></html>`);
  // Linkedom's window proxy shares custom globals; real documents do not.
  delete window.__breezeNativeVideoWork;
  Object.defineProperty(window.document, 'forms', { get: () => [...window.document.querySelectorAll('form')] });
  const context = { window, document: window.document, location: new URL(url), URL, URLSearchParams,
    DOMParser, FormData: BrowserFormData, AbortController, setTimeout, clearTimeout,
    HTMLInputElement: window.HTMLInputElement, Event: window.Event,
    getComputedStyle: () => ({ display: 'block' }), fetch };
  return { window, document: window.document, run: source => vm.runInNewContext(source, context) };
}
async function operation(env, page, name, payload = {}) {
  const start = env.run(`(() => { const expected = new URL(${JSON.stringify(page)}), operation = ${JSON.stringify(name)}, payload = ${JSON.stringify(payload)}; ${scripts.siteOperation} })()`);
  if (start.status !== 'pending') return start;
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setImmediate(resolve));
    const job = env.window.__breezeNativeVideoWork.jobs[start.id];
    if (!job.pending) return job.result;
  }
  throw Error('Fixture operation did not finish');
}
const response = body => new Response(body, { status: 200 });
const saveWatch = (later = false, member = false) => account + likeForm() +
  `<form id="video-save-form" action="/save">${csrf}${hidden('playlist-video-id','42')}<input type="checkbox" class="playlist-checkbox" id="save" ${later ? 'checked' : ''}><input type="checkbox" class="playlist-checkbox" id="abc" ${member ? 'checked' : ''}></form>`;
const ownedIndex = (items = [['abc', 'Existing list']], next = false) => account + '<div class="content-padding-new">' +
  items.map(([id,title]) => `<div class="playlist-card"><a href="/playlist?list=${id}"><span class="title">${title}</span></a></div>`).join('') +
  '</div>' + (next ? '<ul class="pagination"><li><a class="page-link" href="/user/7/playlists?page=2">2</a></li></ul>' : '');
const collection = (ids = [], next = '') => account + `<span id="sidebar-video-count">${ids.length}</span><div class="playlist-video-list">` +
  ids.map(id => `<div class="user-tab-item-wrapper"><a href="/watch?v=${id}">Video ${id}</a></div>`).join('') +
  '</div>' + (next ? `<ul class="pagination"><li><a class="page-link" href="${next}">Next</a></li></ul>` : '');
const login = `<form method="post" action="/login">${csrf}<input name="email" type="email"><input name="password" type="password"><input name="remember" type="checkbox"></form>`;

test('native auth metadata contains capabilities but no hidden/input values', () => {
  const env = browser(login, `${home}/login`);
  env.document.querySelector('[name=password]').value = 'never-export-password';
  const info = env.run(scripts.authMetadata);
  assert.equal(info.supported, true);
  assert.equal(info.remember, true);
  assert.equal(JSON.stringify(info).includes('browser-only-csrf'), false);
  assert.equal(JSON.stringify(info).includes('never-export-password'), false);
});
test('native login uses the existing first-party form and requestSubmit', () => {
  const env = browser(login, `${home}/login`);
  const form = env.document.querySelector('form');
  let submissions = 0;
  form.checkValidity = () => true;
  form.requestSubmit = () => submissions++;
  assert.equal(env.run(scripts.authSubmit), 'submitted');
  assert.equal(submissions, 1);
  assert.equal(form.querySelector('[name=email]').value, 'fixture@example.test');
  assert.equal(form.querySelector('[name=password]').value, 'synthetic-password');
  assert.equal(form.querySelector('[name=_token]').value, 'browser-only-csrf');
});
for (const [name, html, url] of [
  ['captcha', login + '<div class="cf-turnstile"></div>', `${home}/login`],
  ['unknown required field', login.replace('</form>', '<input required name="otp"></form>'), `${home}/login`],
  ['external action', login.replace('action="/login"', 'action="https://other.test/login"'), `${home}/login`],
  ['insecure origin', login, 'http://hanime1.me/login'],
  ['hidden email', login.replace('type="email"', 'type="hidden"'), `${home}/login`],
  ['disabled password', login.replace('name="password"', 'disabled name="password"'), `${home}/login`],
  ['duplicate email', login.replace('</form>', '<input name="email" type="email"></form>'), `${home}/login`],
  ['query action', login.replace('action="/login"', 'action="/login?next=other"'), `${home}/login`],
]) test(`auth keeps ${name} on the site instead of pretending native support`, () => {
  assert.equal(browser(html, url).run(scripts.authMetadata).supported, false);
});
test('plain registration form is native-capable without copying csrf', () => {
  const env = browser(login.replaceAll('/login', '/register').replace('</form>', '<input name="name"></form>'), `${home}/register`);
  assert.equal(env.run(scripts.authMetadata).supported, true);
  assert.equal(env.run(scripts.authMetadata).mode, 'register');
});
test('changed document refuses credentials without a request', () => {
  assert.equal(browser(login, `${home}/register`).run(scripts.authSubmit), 'changed');
});
test('unsupported ordinary forms do not request an automatic website switch', () => {
  const env = browser(login.replace('</form>', '<input required name="otp"></form>'), `${home}/login`);
  assert.equal(env.run(scripts.authSubmit), 'unsupported');
});
test('site capabilities expose no csrf or private form ids', async () => {
  const result = await operation(browser(account + likeForm()), watch, 'state');
  assert.equal(result.canLike, true);
  assert.equal(result.liked, false);
  assert.equal(JSON.stringify(result).includes('browser-only-csrf'), false);
});
test('interaction distinguishes unknown account, signed out and an unrecognized form', async () => {
  const unknown = await operation(browser(likeForm()), watch, 'state');
  assert.equal(unknown.actor, 'unknown');
  assert.equal(unknown.capabilities.like, 'unknown');
  assert.equal(unknown.liked, null);
  const signedOut = await operation(browser('<a href="/login">Login</a>' + likeForm()), watch, 'state');
  assert.equal(signedOut.actor, 'signedOut');
  assert.equal(signedOut.capabilities.like, 'login');
  const mismatched = await operation(browser(account + likeForm().replace('value="7"', 'value="8"')), watch, 'state');
  assert.equal(mismatched.actor, 'signedIn');
  assert.equal(mismatched.canLike, false);
  assert.equal(mismatched.capabilities.like, 'unrecognized');
});

test('target-value like reads fresh state and never toggles an already satisfied request', async () => {
  let writes = 0, liked = true;
  const env = browser(account + likeForm(), watch, async (_, init) => {
    if (init.method === 'POST') {
      writes++;
      assert.equal(init.body.get('like-status'), '1');
      liked = false;
      return response('{"success":true}');
    }
    return response(account + likeForm(liked ? '1' : ''));
  });
  assert.equal((await operation(env, watch, 'like', {enabled:true})).liked, true);
  assert.equal(writes, 0);
  assert.equal((await operation(env, watch, 'like', {enabled:false})).liked, false);
  assert.equal(writes, 1);
  assert.equal((await operation(env, watch, 'like', {enabled:'true'})).status, 'invalid');
  assert.equal(writes, 1);
});

test('an explicit state refresh reads the server without mutating the visible document', async () => {
  const env = browser(account + likeForm(), watch, async (_, init) => {
    assert.notEqual(init.method, 'POST');
    return response(account + likeForm('1'));
  });
  const result = await operation(env, watch, 'refreshState');
  assert.equal(result.refreshed, true);
  assert.equal(result.liked, true);
  assert.equal(env.document.querySelector('[name=like-status]').value, '');
});

test('a document change after a fresh read prevents the pending write', async () => {
  let writes = 0;
  const env = browser(account + likeForm(), watch, async (_, init) => {
    if (init.method === 'POST') writes++;
    env.run('location.href = "https://hanime1.me/watch?v=99"');
    return response(account + likeForm());
  });
  const result = await operation(env, watch, 'like', {enabled:true});
  assert.equal(result.status, 'changed');
  assert.equal(result.writeUnconfirmed, false);
  assert.equal(writes, 0);
});

test('a read transport failure is a retryable read failure, not an uncertain write', async () => {
  const result = await operation(browser(account, watch, async () => { throw Error('offline'); }), watch, 'refreshState');
  assert.equal(result.status, 'network');
  assert.equal(result.writeUnconfirmed, false);
});

test('subscription uses the main video author form and confirms the requested value', async () => {
  let following = false, writes = 0;
  const markup = () => account + followForm('', '99') + followForm(following ? '1' : '', '12', 'video-subscribe-form');
  const env = browser(markup(), watch, async (_, init) => {
    if (init.method === 'POST') {
      writes++;
      assert.equal(init.body.get('subscribe-artist-id'), '12');
      assert.equal(init.body.get('subscribe-status'), '');
      following = true;
      return response('{"success":true}');
    }
    return response(markup());
  });
  const result = await operation(env, watch, 'follow', {enabled:true});
  assert.equal(result.status, 'ok');
  assert.equal(result.following, true);
  assert.equal(writes, 1);
  const ambiguous = await operation(browser(account + followForm('', '99') + followForm('', '12')), watch, 'state');
  assert.equal(ambiguous.canFollow, false);
});

test('an account change during a target-value read prevents a cross-account write', async () => {
  let writes = 0;
  const env = browser(account + likeForm(), watch, async (_, init) => {
    if (init.method === 'POST') writes++;
    return response(account.replace('/user/7', '/user/8') + likeForm().replace('value="7"', 'value="8"'));
  });
  const result = await operation(env, watch, 'like', {enabled:true});
  assert.equal(result.status, 'changed');
  assert.equal(result.writeUnconfirmed, false);
  assert.equal(writes, 0);
});
test('like changes only after a fresh server state confirms it', async () => {
  const calls = [];
  const env = browser(account + likeForm(), watch, async (url, init) => {
    calls.push([url, init]);
    if (init.method === 'POST') {
      assert.equal(init.body.get('_token'), 'browser-only-csrf');
      assert.equal(init.credentials, 'same-origin');
      return response('{"success":true}');
    }
    assert.equal(init.cache, 'no-store');
    return response(account + likeForm('1'));
  });
  const result = await operation(env, watch, 'like');
  assert.equal(result.status, 'ok');
  assert.equal(result.liked, true);
  assert.equal(calls.length, 2);
  assert.equal(env.document.querySelector('[name=like-status]').value, '1');
});
test('a 200 response with unchanged state is unconfirmed, not success', async () => {
  const env = browser(account + likeForm(), watch, async (_, init) => init.method === 'POST' ? response('{"success":true}') : response(account + likeForm()));
  assert.equal((await operation(env, watch, 'like')).status, 'unconfirmed');
});
test('expired account and verification failures remain distinct and do not navigate', async () => {
  for (const [status, headers, expected] of [[419, {}, 'login'], [403, {'cf-mitigated':'challenge'}, 'verification']]) {
    const env = browser(account + likeForm(), watch, async () => new Response('', {status, headers}));
    assert.equal((await operation(env, watch, 'like')).status, expected);
  }
});
test('no write is sent to a mismatched video or external form', async () => {
  for (const form of [likeForm().replace('value="42"','value="99"'), likeForm().replace('action="/like"', 'action="https://other.test/like"')]) {
    assert.equal((await operation(browser(account + form), watch, 'like')).status, 'unsupported');
  }
  assert.equal((await operation(browser(account + likeForm(), `${home}/watch?v=9`), watch, 'like')).status, 'changed');
});
const commentHtml = `<form action="/createComment" method="post">${csrf}${hidden('comment-user-id','7')}${hidden('comment-foreign-id','42')}${hidden('comment-type','video')}<textarea name="comment-text"></textarea></form><div id="comment-start"><div><div class="comment-index-text"><a>Example person</a><span>Today</span></div><div class="comment-index-text">Visible plain text</div></div><div class="load-replies-btn">Replies</div><div id="reply-section-wrapper-12"></div><hr></div>`;
test('comments are plain bounded native data with reply metadata, not html or tokens', async () => {
  const env = browser(account, watch, async () => response(JSON.stringify({comments:commentHtml})));
  const result = await operation(env, watch, 'comments');
  assert.equal(result.status, 'ok');
  assert.equal(result.items[0].text, 'Visible plain text');
  assert.equal(result.items[0].hasReplies, true);
  assert.equal(result.canPost, true);
  assert.equal(JSON.stringify(result).includes('browser-only-csrf'), false);
});
test('comment author excludes a nested timestamp while retaining styled name', async () => {
  const html = commentHtml.replace('<a>Example person</a><span>Today</span>', '<a><strong>Example person</strong> <span>Today</span></a>');
  const env = browser(account, watch, async () => response(JSON.stringify({comments:html})));
  const result = await operation(env, watch, 'comments');
  assert.equal(result.items[0].author, 'Example person');
  assert.equal(result.items[0].time, 'Today');
});
test('comment submit uses the actual loaded form; explicit rejection is not success', async () => {
  const env = browser(account, watch, async (_, init) => init.method === 'POST'
    ? response('{"success":false}') : response(JSON.stringify({comments:commentHtml})));
  assert.equal((await operation(env, watch, 'comment', {text:'User typed comment'})).status, 'rejected');
});
test('playlist editor requires matching site form and does not export csrf', async () => {
  const url = `${home}/playlist?list=abc`;
  const result = await operation(browser(account + playlistForm, url), url, 'playlistState');
  assert.equal(result.supported, true);
  assert.equal(result.title, 'Old title');
  assert.equal(result.canDelete, true);
  assert.equal(JSON.stringify(result).includes('browser-only-csrf'), false);
  assert.equal((await operation(browser(account + playlistForm.replace('/playlist/abc','/playlist/other'), url), url, 'playlistState')).supported, false);
});
// Synthetic wire-intent regressions execute the actual Dart-exported body.
// No real request is sent; these cannot stand in for site or device acceptance.
for (const variant of ['unchecked checkbox', 'checked checkbox', 'hidden delete', 'duplicate delete values']) {
  test(`playlist update excludes deletion intent from ${variant} and verifies fresh fields`, async () => {
    const url = `${home}/playlist?list=abc`, writes = [], reads = [];
    let source = playlistForm;
    if (variant === 'hidden delete') source = source.replace('type="checkbox" name="playlist-delete"', 'type="hidden" name="playlist-delete" value="on"');
    if (variant === 'duplicate delete values') source = source.replace('</form>', hidden('playlist-delete','on') + hidden('playlist-delete','unexpected') + '</form>');
    const fresh = playlistForm.replace('Old title','New title').replace('Old description','New description');
    const env = browser(account + source, url, async (target, init) => {
      if (init.method === 'POST') { writes.push({target, init}); return response('{"success":true}'); }
      reads.push({target, init}); return response(account + fresh);
    });
    if (variant === 'checked checkbox') {
      const control = env.document.querySelector('[name="playlist-delete"]');
      control.checked = true;
      control.value = 'on';
    }
    assert.equal((await operation(env, url, 'updatePlaylist', {
      title:'New title', description:'New description', 'playlist-delete':'on',
    })).status, 'ok');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].target, `${home}/playlist/abc`);
    const {body, headers} = writes[0].init;
    assert.deepEqual(body.getAll('playlist-delete'), []);
    assert.equal(body.get('_method'), 'PUT');
    assert.equal(body.get('_token'), 'browser-only-csrf');
    assert.equal(body.get('playlist-title'), 'New title');
    assert.equal(body.get('playlist-description'), 'New description');
    assert.equal(headers['X-CSRF-TOKEN'], 'browser-only-csrf');
    assert.equal(reads.length, 1);
    assert.equal(reads[0].target, url);
    assert.equal(reads[0].init.cache, 'no-store');
  });
}
for (const variant of ['unchecked checkbox', 'duplicate delete values']) {
  test(`playlist deletion explicitly sends one on value despite ${variant}`, async () => {
    const url = `${home}/playlist?list=abc`, writes = [], reads = [];
    const source = variant === 'duplicate delete values' ? playlistForm.replace('</form>', hidden('playlist-delete','unexpected') + hidden('playlist-delete','on') + '</form>') : playlistForm;
    const env = browser(account + source, url, async (target, init) => {
      if (init.method === 'POST') { writes.push({target, init}); return response('{"success":true}'); }
      reads.push({target, init});
      return new URL(target).pathname.endsWith('/playlists') ? response(ownedIndex([])) : new Response('', {status:404});
    });
    assert.equal((await operation(env, url, 'deletePlaylist')).status, 'ok');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].target, `${home}/playlist/abc`);
    const {body, headers} = writes[0].init;
    assert.deepEqual(body.getAll('playlist-delete'), ['on']);
    assert.equal(body.get('_method'), 'PUT');
    assert.equal(body.get('_token'), 'browser-only-csrf');
    assert.equal(body.get('playlist-title'), 'Old title');
    assert.equal(body.get('playlist-description'), 'Old description');
    assert.equal(headers['X-CSRF-TOKEN'], 'browser-only-csrf');
    assert.equal(reads.length, 2);
    assert.equal(reads[0].target, url);
    assert.equal(new URL(reads[1].target).pathname, '/user/7/playlists');
    assert.equal(reads.every(({init}) => init.cache === 'no-store'), true);
  });
}
test('playlist deletion without its original site control refuses a write', async () => {
  const url = `${home}/playlist?list=abc`;
  const source = playlistForm.replace('<input type="checkbox" name="playlist-delete">', '');
  assert.equal((await operation(browser(account + source, url), url, 'deletePlaylist')).status, 'unsupported');
});
test('playlist update still refuses unchanged fresh fields after an accepted write', async () => {
  const url = `${home}/playlist?list=abc`;
  let writes = 0;
  const env = browser(account + playlistForm, url, async (_, init) => {
    if (init.method === 'POST') { writes++; return response('{"success":true}'); }
    return response(account + playlistForm);
  });
  assert.equal((await operation(env, url, 'updatePlaylist', {title:'New title',description:'New description'})).status, 'unconfirmed');
  assert.equal(writes, 1);
});

test('comment html responses require a newly visible matching comment, not merely HTTP 200', async () => {
  let written = false, writes = 0;
  const env = browser(account, watch, async (_, init) => {
    if (init.method === 'POST') { writes++; written = true; return response(''); }
    return response(JSON.stringify({comments:written ? commentHtml.replace('Visible plain text','User typed comment') : commentHtml}));
  });
  assert.equal((await operation(env, watch, 'comment', {text:'User typed comment'})).status, 'ok');
  assert.equal(writes, 1);
});
test('reply posting uses the correct thread and never exports its csrf', async () => {
  const replyHtml = `<form method="post" action="/replyComment">${csrf}${hidden('reply-comment-id','12')}<textarea name="reply-comment-text"></textarea></form><div id="reply-start-12"><div><div class="comment-index-text"><a>Reply author</a></div><div class="comment-index-text">Reply text</div></div><div></div></div>`;
  let writes = 0;
  const env = browser(account, watch, async (_, init) => {
    if (init.method === 'POST') { writes++; assert.equal(init.body.get('reply-comment-id'),'12'); return response('{"success":true}'); }
    return response(JSON.stringify({replies:replyHtml}));
  });
  const result = await operation(env, watch, 'reply', {id:'12',text:'A user reply'});
  assert.equal(result.status, 'ok');
  assert.equal(result.canPost, true);
  assert.equal(JSON.stringify(result).includes('browser-only-csrf'), false);
  assert.equal(writes, 1);
});
test('playlist creation uses the returned checkbox ID and independently confirms that exact owned list', async () => {
  const create = `<form method="post" action="/createPlaylist">${csrf}${hidden('create-playlist-video-id','42')}<input name="playlist-title"><textarea name="playlist-description"></textarea><input name="password" value="not-a-submission-field"></form>`;
  let written = false, writes = 0;
  const env = browser(account + create, watch, async (url, init) => {
    if (init.method === 'POST') {
      writes++; assert.equal(init.body.has('password'), false); written = true; return response(JSON.stringify({checkbox:'<input class="playlist-checkbox" type="checkbox" id="new">'}));
    }
    const target = new URL(url);
    if (target.pathname === '/watch') return response(saveWatch() + create);
    if (target.pathname === '/playlist') return response(collection(['42']));
    return response(ownedIndex(written ? [['new','New list']] : []));
  });
  const result = await operation(env, watch, 'createPlaylist', {title:'New list',description:''});
  assert.equal(result.status, 'ok');
  assert.equal(result.createdId, 'new');
  assert.equal(result.lists[0].containsVideo, true);
  assert.equal(writes, 1);
});

test('playlist selection returns only real owned IDs, membership and safe pagination', async () => {
  const env = browser(saveWatch(false, true), watch, async () => response(ownedIndex([['abc','Existing list']], true)));
  const result = await operation(env, watch, 'playlists', {page:1});
  assert.equal(result.status, 'ok');
  assert.equal(result.lists[0].id, 'abc');
  assert.equal(result.lists[0].containsVideo, true);
  assert.equal(result.nextPage, 2);
  assert.equal(JSON.stringify(result).includes('browser-only-csrf'), false);
  assert.equal((await operation(env, watch, 'playlists', {page:-1})).status, 'invalid');
});

test('existing playlist membership is verified after a real save request', async () => {
  let member = false, writes = 0;
  const env = browser(saveWatch(), watch, async (url, init) => {
    const target = new URL(url);
    if (init.method === 'POST') {
      assert.equal(target.pathname, '/save');
      assert.equal(init.body.get('input_id'), 'abc');
      assert.equal(init.body.get('video_id'), '42');
      assert.equal(init.body.has('_token'), false);
      assert.equal(init.headers['X-CSRF-TOKEN'], 'browser-only-csrf');
      assert.equal(init.body.get('user_id'), '');
      writes++;
      member = init.body.get('is_checked') === 'true';
      return response('');
    }
    return response(target.pathname === '/watch' ? saveWatch(false, member) : ownedIndex());
  });
  assert.equal((await operation(env, watch, 'savePlaylist', {id:'abc',enabled:true})).status, 'unsupported');
  assert.equal(writes, 0, 'unissued client IDs are refused');
  await operation(env, watch, 'playlists');
  const added = await operation(env, watch, 'savePlaylist', {id:'abc',enabled:true});
  assert.equal(added.status, 'ok');
  assert.equal(added.lists[0].containsVideo, true);
  const removed = await operation(env, watch, 'savePlaylist', {id:'abc',enabled:false});
  assert.equal(removed.status, 'ok');
  assert.equal(removed.lists[0].containsVideo, false);
  assert.equal(writes, 2);
});

test('watch-later uses its distinct save destination and confirms both directions', async () => {
  let later = false, writes = 0;
  const env = browser(saveWatch(), watch, async (_, init) => {
    if (init.method === 'POST') {
      writes++;
      assert.equal(init.body.get('input_id'), 'save');
      later = init.body.get('is_checked') === 'true';
      return response('{"success":true}');
    }
    return response(saveWatch(later));
  });
  assert.equal((await operation(env, watch, 'watchLater', {enabled:true})).watchLater, true);
  assert.equal((await operation(env, watch, 'watchLater', {enabled:true})).watchLater, true);
  assert.equal(writes, 1, 'already satisfied requests do not write twice');
  assert.equal((await operation(env, watch, 'watchLater', {enabled:false})).watchLater, false);
  assert.equal(writes, 2);
});

test('save success flags cannot replace confirmation and explicit rejection stays distinct', async () => {
  for (const accepted of [true,false]) {
    const env = browser(saveWatch(), watch, async (_, init) => init.method === 'POST' ?
      response(JSON.stringify({success:accepted})) : response(saveWatch()));
    const result = await operation(env, watch, 'watchLater', {enabled:true});
    assert.equal(result.status, accepted ? 'unconfirmed' : 'rejected');
    assert.equal(result.writeUnconfirmed, accepted);
  }
});

test('playlist reads reject another account, outside links and wrong targets', async () => {
  for (const html of [
    ownedIndex().replace('/user/7', '/user/8'),
    ownedIndex().replace('href="/playlist?list=abc"','href="https://other.test/playlist?list=abc"'),
  ]) {
    const result = await operation(browser(saveWatch(), watch, async () => response(html)), watch, 'playlists');
    assert.equal(result.status, html.includes('/user/8') ? 'changed' : 'unsupported');
  }
});

test('missing watch checkboxes fall back to bounded real collection pages without guessing absence', async () => {
  for (const recognized of [true,false]) {
    const env = browser(account + likeForm(), watch, async url => {
      const target = new URL(url);
      if (target.pathname === '/watch') return response(account + likeForm());
      if (target.pathname.endsWith('/playlists')) return response(ownedIndex());
      if (!recognized) return response(account + '<div class="playlist-video-list"><article>Unknown card layout</article></div>');
      return response(target.searchParams.get('page') === '2' ? collection(['42']) : collection(['99'], '/playlist?list=abc&page=2'));
    });
    await operation(env, watch, 'playlists');
    const result = await operation(env, watch, 'playlistMembership', {id:'abc'});
    assert.equal(result.status, recognized ? 'ok' : 'unconfirmed');
    if (recognized) assert.equal(result.lists[0].containsVideo, true);
    assert.equal(result.writeUnconfirmed, recognized ? undefined : false);
  }
});

test('a successful create response without a new verified list is not a successful favorite', async () => {
  const create = `<form method="post" action="/createPlaylist">${csrf}${hidden('create-playlist-video-id','42')}<input name="playlist-title"><textarea name="playlist-description"></textarea></form>`;
  const env = browser(account + create, watch, async (_, init) => init.method === 'POST' ? response('{"success":true}') : response(ownedIndex()));
  const result = await operation(env, watch, 'createPlaylist', {title:'Missing new list',description:''});
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.writeUnconfirmed, true);
});

test('create then add confirms the video; a rejected second write does not permit duplicate creation', async () => {
  for (const rejected of [false,true]) {
    const create = `<form method="post" action="/createPlaylist">${csrf}${hidden('create-playlist-video-id','42')}<input name="playlist-title"><textarea name="playlist-description"></textarea></form>`;
    let created = false, member = false, writes = 0;
    const env = browser(account + create, watch, async (url, init) => {
      const target = new URL(url);
      if (init.method === 'POST') {
        writes++;
        if (target.pathname === '/createPlaylist') { created = true; return response(JSON.stringify({checkbox:'<input class="playlist-checkbox" type="checkbox" id="new">'})); }
        else {
          if (rejected) return new Response('',{status:403,headers:{'cf-mitigated':'challenge'}});
          assert.equal(init.body.get('input_id'), 'new');
          member = true;
        }
        return response('{"success":true}');
      }
      if (target.pathname === '/watch') return response(saveWatch() + create);
      if (target.pathname === '/playlist') return response(collection(member ? ['42'] : []));
      return response(ownedIndex(created ? [['new','New list']] : []));
    });
    const result = await operation(env, watch, 'createPlaylist', {title:'New list',description:''});
    assert.equal(result.status, rejected ? 'verification' : 'ok');
    assert.equal(writes, 2);
    if (rejected) assert.equal(result.writeUnconfirmed, true);
    else assert.equal(result.lists[0].containsVideo, true);
  }
});
test('a transport failure after a write is unconfirmed, never automatically retried', async () => {
  let writes = 0;
  const env = browser(account + likeForm(), watch, async () => { writes++; throw Error('fixture disconnection'); });
  assert.equal((await operation(env, watch, 'like')).status, 'unconfirmed');
  assert.equal(writes, 1);
});
test('a challenge during write confirmation preserves the uncertain mutation', async () => {
  let writes = 0;
  const env = browser(account + likeForm(), watch, async (_, init) => {
    if (init.method === 'POST') { writes++; return response('{"success":true}'); }
    return new Response('', {status:403, headers:{'cf-mitigated':'challenge'}});
  });
  const result = await operation(env, watch, 'like');
  assert.equal(result.status, 'verification');
  assert.equal(result.writeUnconfirmed, true);
  assert.equal(writes, 1);
});
test('server errors after POST cannot be called a confirmed rejection', async () => {
  const result = await operation(browser(account + likeForm(), watch,
    async () => new Response('', {status:500})), watch, 'like');
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.writeUnconfirmed, true);
});
test('signed-out comment readers retain read access with a login capability', async () => {
  const result = await operation(browser('', watch, async () => response(JSON.stringify({comments:commentHtml}))), watch, 'comments');
  assert.equal(result.status, 'ok');
  assert.equal(result.items.length, 1);
  assert.equal(result.signedIn, false);
  assert.equal(result.canPost, false);
});
test('external account links never authorize a site mutation', async () => {
  let writes = 0;
  const env = browser(account.replace('/user/7', 'https://other.test/user/7') + likeForm(), watch,
    async () => { writes++; return response(''); });
  assert.equal((await operation(env, watch, 'like')).status, 'login');
  assert.equal(writes, 0);
});
test('actual host job cancellation aborts the pending browser request', async () => {
  let aborted = 0;
  const env = browser(account, watch, async (_, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted++; reject(Error('fixture abort')); });
  }));
  const start = env.run(scripts.siteOperationStart);
  assert.equal(start.id, 'fixture-job');
  assert.equal(env.run(scripts.siteOperationCancel).status, 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, 1);
  assert.equal(Object.keys(env.window.__breezeNativeVideoWork.jobs).length, 0);
});

test('comments beyond the first 100 are read from the same revision without refetching or duplicating', async () => {
  const unit = commentHtml.match(/<div id="comment-start">([\s\S]*)<\/div>$/)[1];
  const html = commentHtml.replace(/<div id="comment-start">[\s\S]*$/, '<div id="comment-start">' +
    Array.from({length:205}, (_, i) => unit.replace('Visible plain text', `Comment ${i}`).replace('wrapper-12', `wrapper-${i+1}`)).join('') + '</div>');
  let reads = 0;
  const env = browser(account, watch, async () => { reads++; return response(JSON.stringify({comments:html})); });
  const first = await operation(env, watch, 'comments');
  assert.equal(first.items.length, 100);
  assert.equal(first.nextOffset, 100);
  const second = await operation(env, watch, 'comments', {offset:first.nextOffset,revision:first.revision});
  assert.equal(second.items[0].text, 'Comment 100');
  assert.equal(second.items.length, 100);
  const third = await operation(env, watch, 'comments', {offset:second.nextOffset,revision:second.revision});
  assert.equal(third.items.length, 5);
  assert.equal(third.items[4].text, 'Comment 204');
  assert.equal(third.nextOffset, null);
  assert.equal(reads, 1);
  const refreshed = await operation(env, watch, 'comments');
  assert.notEqual(refreshed.revision, first.revision);
  assert.equal((await operation(env, watch, 'comments', {offset:100,revision:first.revision})).status, 'stale');
  assert.equal(reads, 2, 'stale continuation cannot fetch or merge a different snapshot');
});

test('playlist creation uses a verified refreshed form and remembers confirmed membership', async () => {
  const create = `<form method="post" action="/createPlaylist">${csrf}${hidden('create-playlist-video-id','42')}<input name="playlist-title"><textarea name="playlist-description"></textarea></form>`;
  let created = false, writes = 0;
  const env = browser(account + likeForm(), watch, async (url, init) => {
    const target = new URL(url);
    if (init.method === 'POST') { writes++; created = true; return response(JSON.stringify({checkbox:'<input class="playlist-checkbox" type="checkbox" id="new">'})); }
    if (target.pathname === '/watch') return response(saveWatch() + create);
    if (target.pathname === '/playlist') return response(collection(['42']));
    return response(ownedIndex(created ? [['new','New list']] : []));
  });
  assert.equal((await operation(env, watch, 'refreshState')).canCreatePlaylist, true);
  const result = await operation(env, watch, 'createPlaylist', {title:'New list',description:''});
  assert.equal(result.status, 'ok');
  assert.equal(writes, 1, 'already added video does not issue a second save');
  assert.equal((await operation(env, watch, 'playlists')).lists[0].containsVideo, true);
});

// Derived from the 2026-10-24 first-party watch forms; identities and values are synthetic.
const ajaxVote = (liked = '', disliked = '', polarity = '1') => `<form id="video-like-form" action="/like">${csrf}${hidden('like-user-id','7')}${hidden('like-foreign-id','42')}${hidden('like-is-positive',polarity)}${hidden('like-status',liked)}${hidden('unlike-status',disliked)}${hidden('likes-count','100')}${hidden('unlikes-count','2')}</form>`;
const ajaxFollow = (status = '') => `<form id="video-subscribe-form" action="/subscribe">${csrf}${hidden('subscribe-user-id','7')}${hidden('subscribe-artist-id','12')}${hidden('subscribe-status',status)}</form>`;
const ajaxCreate = `<form id="video-create-playlist-form" action="/createPlaylist">${csrf}${hidden('create-playlist-video-id','42')}<input name="playlist-title"><textarea name="playlist-description"></textarea></form>`;
const ajaxSave = (checked = false) => `<form id="video-save-form" action="/save">${csrf}${hidden('playlist-video-id','42')}<input class="playlist-checkbox" type="checkbox" id="save" ${checked ? 'checked' : ''}><input class="playlist-checkbox" type="checkbox" id="abc"></form>`;
const ajaxWatch = (liked = '', disliked = '', followed = '', saved = false) => account + '<meta name="csrf-token" content="browser-only-csrf">' + ajaxVote(liked,disliked) + ajaxFollow(followed) + ajaxCreate + ajaxSave(saved);

test('first-party AJAX forms without method expose real vote follow and create contracts', async () => {
  const r = await operation(browser(ajaxWatch()),watch,'state');
  assert.equal(r.canLike,true); assert.equal(r.canDislike,true); assert.equal(r.canFollow,true); assert.equal(r.canCreatePlaylist,true);
  assert.equal(r.disliked,false); assert.equal(r.positiveVotes,100); assert.equal(r.negativeVotes,2); assert.equal(r.totalVotes,102);
  const bad = ajaxWatch().replace('id="video-like-form"','id="unrelated-form"');
  assert.equal((await operation(browser(bad),watch,'state')).canLike,false);
});
test('first-party vote wire keeps both current states and counts while choosing negative polarity', async () => {
  let disliked = false, writes = 0;
  const env = browser(ajaxWatch(),watch,async(_,init)=>{
    if(init.method === 'POST') {
      writes++;
      assert.equal(init.body.get('like-status'),''); assert.equal(init.body.get('unlike-status'),'');
      assert.equal(init.body.get('like-is-positive'),'0'); assert.equal(init.body.get('likes-count'),'100'); assert.equal(init.body.get('unlikes-count'),'2');
      assert.equal(init.headers['X-CSRF-TOKEN'],'browser-only-csrf');
      disliked = true; return response(JSON.stringify({likeBtn:'<div>server view</div>'}));
    }
    return response(ajaxWatch('',disliked?'1':''));
  });
  const r=await operation(env,watch,'dislike',{enabled:true});
  assert.equal(r.status,'ok');assert.equal(r.disliked,true);assert.equal(writes,1);
});
test('current OTP-gated comment branch remains readable with a separate optional publish gate', async () => {
  const html='<div id="comment-create-form-wrapper"><div data-toggle="modal" data-target="#otpVerificationModal"><input></div></div><div id="comment-start"></div>';
  const env=browser(ajaxWatch(),watch,async(url,init)=>{assert.notEqual(init.method,'POST');assert.equal(new URL(url).searchParams.get('content'),'comment-tablink');return response(JSON.stringify({comments:html,content:'comment-tablink'}));});
  const r=await operation(env,watch,'comments');assert.equal(r.status,'ok');assert.equal(r.canPost,false);assert.equal(r.postGate,'siteVerification');
});

test('canonical AJAX contracts reject duplicate fields and ambiguous forms',async()=>{
  const malformed=ajaxWatch().replace('</form>',hidden('unlike-status','')+'</form>');
  assert.equal((await operation(browser(malformed),watch,'state')).canLike,false);
  assert.equal((await operation(browser(ajaxWatch()+ajaxVote()),watch,'state')).canLike,false);
});
test('save capability needs the observed action form, not merely an account and token',async()=>{
  const r=await operation(browser(account+ajaxVote()),watch,'state');
  assert.equal(r.capabilities.watchLater,'unrecognized');
  assert.equal(r.watchLater,null);
});
test('original save protocol uses only its four target fields and the CSRF header',async()=>{
  let saved=false,writes=0;
  const env=browser(ajaxWatch(),watch,async(_,init)=>{
    if(init.method==='POST') {
      writes++;assert.deepEqual([...init.body.keys()].sort(),['input_id','is_checked','user_id','video_id']);
      assert.equal(init.body.get('input_id'),'save');assert.equal(init.body.get('is_checked'),'true');assert.equal(init.body.get('user_id'),'');
      assert.equal(init.headers['X-CSRF-TOKEN'],'browser-only-csrf');saved=true;
      return response(JSON.stringify({saveBtn:'<div>server view</div>',saveBtnMore:'<div>server view</div>'}));
    }
    return response(ajaxWatch('','','',saved));
  });
  const r=await operation(env,watch,'watchLater',{enabled:true});assert.equal(r.status,'ok');assert.equal(r.watchLater,true);assert.equal(writes,1);
});
test('a changed author in the independent subscription read cannot confirm the old target',async()=>{
  let wrote=false;
  const env=browser(ajaxWatch(),watch,async(_,init)=>{
    if(init.method==='POST'){wrote=true;return response(JSON.stringify({subscribeBtn:'<div>server view</div>'}));}
    return response(wrote?ajaxWatch('','','1').replace('name="subscribe-artist-id" value="12"','name="subscribe-artist-id" value="99"'):ajaxWatch());
  });
  const r=await operation(env,watch,'follow',{enabled:true});assert.equal(r.status,'changed');assert.equal(r.writeUnconfirmed,true);
});
test('returned create ID survives an uncertain join and read-only reconciliation never creates again',async()=>{
  let writes=0,created=false;
  const env=browser(ajaxWatch(),watch,async(url,init)=>{
    const target=new URL(url);
    if(init.method==='POST'){
      writes++;
      if(target.pathname==='/createPlaylist'){created=true;return response(JSON.stringify({checkbox:'<input class="playlist-checkbox" type="checkbox" id="new">'}));}
      return new Response('',{status:403,headers:{'cf-mitigated':'challenge'}});
    }
    if(target.pathname==='/watch')return response(ajaxWatch());
    if(target.pathname==='/playlist')return response(collection([]));
    return response(ownedIndex(created?[['new','New list']]:[]));
  });
  const result=await operation(env,watch,'createPlaylist',{title:'New list',description:''});
  assert.equal(result.createdId,'new');assert.equal(result.createdVerified,true);assert.equal(result.writeUnconfirmed,true);assert.equal(writes,2);
  const checked=await operation(env,watch,'reconcileCreatedPlaylist');
  assert.equal(checked.status,'ok');assert.equal(checked.createdId,'new');assert.equal(checked.lists[0].containsVideo,false);assert.equal(writes,2);
});
test('download choices come only from the exact video download page and do not fetch media or ads',async()=>{
  const requests=[];
  const env=browser(ajaxWatch(),watch,async(url,init)=>{
    const u=new URL(url);requests.push(u.pathname);assert.notEqual(init.method,'POST');
    if(u.pathname==='/watch')return response(ajaxWatch()+'<a id="downloadBtn" href="/download?v=42">Download</a>');
    assert.equal(u.pathname,'/download');
    return response('<table><tr><td>icon</td><td>1080p</td><td>mp4</td><td>N/A</td><td><a download data-url="https://media.example/video.mp4?secure=synthetic-signature">Download</a></td></tr><tr><td>icon</td><td>invalid</td><td>mp4</td><td>N/A</td><td><a download data-url="javascript:alert(1)">Wrong</a></td></tr></table><script>throw new Error("must never execute")</script>');
  });
  const r=await operation(env,watch,'downloadChoices');assert.equal(r.status,'ok');assert.equal(r.choices.length,1);assert.equal(r.choices[0].label,'1080p');assert.deepEqual(requests,['/watch','/download']);
});
test('download rejects another video before reading its download page',async()=>{
  let reads=0;
  const r=await operation(browser(ajaxWatch(),watch,async()=>{reads++;return response(ajaxWatch()+'<a id="downloadBtn" href="/download?v=99">Download</a>');}),watch,'downloadChoices');
  assert.equal(r.status,'unsupported');assert.equal(reads,1);
});
test('response CSRF stays inside the browser and does not become native display data',async()=>{
  let liked=false;
  const env=browser(ajaxWatch(),watch,async(_,init)=>{
    if(init.method==='POST'){liked=true;return response(JSON.stringify({csrf_token:'rotated-browser-only-csrf',likeBtn:'<div>server view</div>'}));}
    return response(ajaxWatch(liked?'1':''));
  });
  const r=await operation(env,watch,'like',{enabled:true});assert.equal(r.status,'ok');assert.equal(r.liked,true);
  assert.equal(env.document.querySelector('meta[name="csrf-token"]').getAttribute('content'),'rotated-browser-only-csrf');
  assert.equal(JSON.stringify(r).includes('rotated-browser-only-csrf'),false);
});

test('reply reading rejects mismatched server parent identity instead of showing another thread',async()=>{
  const env=browser(ajaxWatch(),watch,async()=>response(JSON.stringify({comment_id:'99',replies:'<div id="reply-start-99"></div>'})));
  const r=await operation(env,watch,'replies',{id:'12'});assert.equal(r.status,'changed');assert.equal(r.writeUnconfirmed,false);
});

test('a no-op target confirmation cannot copy an older action snapshot back into the live form',async()=>{
  let liked=false,writes=0;
  const html=()=>ajaxWatch(liked?'1':'').replace('name="likes-count" value="100"',`name="likes-count" value="${liked?101:100}"`);
  const env=browser(html(),watch,async(_,init)=>{
    if(init.method==='POST'){writes++;liked=true;return response(JSON.stringify({likeBtn:'<div>server view</div>'}));}
    return response(html());
  });
  assert.equal((await operation(env,watch,'like',{enabled:true})).liked,true);
  liked=false; // An independent server change, without rewriting the native page.
  const r=await operation(env,watch,'like',{enabled:false});
  assert.equal(r.status,'ok');assert.equal(r.liked,false);assert.equal(writes,1);
  assert.equal(env.document.querySelector('[name="like-status"]').value,'');
  assert.equal(env.document.querySelector('[name="likes-count"]').value,'100');
});
