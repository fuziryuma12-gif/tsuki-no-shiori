/* ============================================================
   月のしおり — フロントエンド v2
   メールコードでログインし、セッショントークンで端末を識別する。
   ========================================================== */

'use strict';

/**
 * 接続先の GAS ウェブアプリ URL。
 * ここに書いておくと、リンクを開いた人が設定なしでそのまま使える。
 * 端末の設定画面で入れた値があれば、そちらが優先される。
 */
const DEFAULT_API =
  'https://script.google.com/macros/s/AKfycbxCRKMHQDxGtuXCf-q6YLSQuwGx9z5VR9nJw7wf1lZO2H_UbhimFUd_NETeplzbtv9F/exec';

const LS = {
  api: 'shiori.apiUrl',
  token: 'shiori.token',
  shelf: 'shiori.lastShelfId',
  pending: 'shiori.pendingJoin',
  email: 'shiori.lastEmail',
  hint: 'shiori.installHintClosed'
};

/**
 * localStorage は環境によっては例外を投げる。
 * （Safariのプライベートモード、保存容量がいっぱい、など）
 * 保存に失敗しても操作そのものは続けられるよう、ここで受け止めておく。
 * 失敗した場合はこの実行中だけメモリに持つ。
 */
const memStore = {};

function lsGet(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
  } catch (e) { /* 使えない環境 */ }
  return memStore[key] !== undefined ? memStore[key] : null;
}

function lsSet(key, value) {
  memStore[key] = value;
  try { localStorage.setItem(key, value); }
  catch (e) { /* 保存できなくても続ける */ }
}

function lsDel(key) {
  delete memStore[key];
  try { localStorage.removeItem(key); } catch (e) { /* そのまま */ }
}

const store = {
  get api() { return lsGet(LS.api) || DEFAULT_API; },
  set api(v) { lsSet(LS.api, v); },

  get token() { return lsGet(LS.token) || ''; },
  set token(v) { v ? lsSet(LS.token, v) : lsDel(LS.token); },

  get lastShelf() { return lsGet(LS.shelf) || ''; },
  set lastShelf(v) { v ? lsSet(LS.shelf, v) : lsDel(LS.shelf); },

  get lastEmail() { return lsGet(LS.email) || ''; },
  set lastEmail(v) { v ? lsSet(LS.email, v) : lsDel(LS.email); },

  get pendingJoin() {
    try { return JSON.parse(lsGet(LS.pending) || 'null'); }
    catch (e) { return null; }
  },
  set pendingJoin(v) {
    v ? lsSet(LS.pending, JSON.stringify(v)) : lsDel(LS.pending);
  }
};

/** 画面の状態 */
let S = {
  user: null,        // { userId, email, displayName }
  shelves: [],       // 所属している本棚の一覧
  canEdit: false,
  shelf: null,       // いま開いている本棚
  members: [],
  entries: [],
  recs: []
};

let editingId = null;
let formKind = 'book';
let formRating = 0;
let aiKind = 'both';
let aiScope = 'all';
let pendingEmail = '';

/* --- 一覧の絞り込み --- */
let allKind = 'all';
let allWho = 'all';
let allSort = 'new';
let allQuery = '';
let searchTimer = null;

/* --- チャット --- */
let messages = [];        // いま表示している会話
let quoted = null;        // 引用中の作品 { type, id, kind, title, creator }
let lastMsgAt = '';       // 追いかけの基準になる時刻
let chatTimer = null;     // 会話画面を開いている間の追いかけ
let unreadTimer = null;   // 赤い印の確認
let unreadByShelf = {};   // 本棚ごとの未読件数

const $ = (id) => document.getElementById(id);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/* ============================================================
   API
   ========================================================== */

async function api(action, payload) {
  if (!store.api) {
    throw new Error('接続先が設定されていません。管理者にお知らせください。');
  }
  let res;
  try {
    // text/plain で送るとプリフライトが飛ばず、GASでもそのまま受けられる。
    res = await fetch(store.api, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
      redirect: 'follow'
    });
  } catch (err) {
    throw new Error('サーバーにつながりませんでした。通信環境を確かめてください。');
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error('サーバーの返答を読み取れませんでした。時間をおいてお試しください。');
  }

  if (!data.ok) {
    const e = new Error(data.error || '処理できませんでした。');
    e.authFailed = data.code === 'AUTH';
    e.action = action;
    throw e;
  }
  return data;
}

/** トークンを添えて呼ぶ。期限切れならログイン画面に戻す。 */
async function authed(action, payload) {
  try {
    return await api(action, Object.assign({ token: store.token }, payload || {}));
  } catch (err) {
    if (err.authFailed) {
      store.token = '';
      showGate('email');
      toast(err.message);
    }
    throw err;
  }
}

/* ============================================================
   小さな道具
   ========================================================== */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function thisMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function monthParts(m) {
  const [y, mm] = String(m).split('-');
  return { year: y, month: String(Number(mm)) };
}

function stars(n) {
  n = Math.max(0, Math.min(5, Number(n) || 0));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function toast(msg) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function openSheet(id) { $(id).classList.remove('hidden'); }
function closeSheet(id) { $(id).classList.add('hidden'); }
function closeAllSheets() { $$('.veil').forEach((v) => v.classList.add('hidden')); }

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました');
  } catch (err) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('コピーしました');
  }
}

function baseUrl() { return location.origin + location.pathname; }

/** ボタンを押している間だけ文言を差し替える。 */
/** 画面全体に読み込み中を出す。通信の待ち時間を分かるようにする。 */
function showBusy(msg) {
  $('busy-msg').textContent = msg || '読み込んでいます…';
  $('busy-veil').classList.remove('hidden');
}

function hideBusy() {
  $('busy-veil').classList.add('hidden');
}

/** ログイン画面に、消えないエラーを出す。トーストだと見逃されるため。 */
function gateError(which, msg) {
  const el = $('gate-error-' + which);
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

async function busy(btn, label, fn) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  showBusy(label);
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = was; hideBusy(); }
}

/* ============================================================
   起動とルーティング
   ========================================================== */

/**
 * 想定していないエラーを黙って落とさない。
 * 「押したのに何も起きない」を見えるようにする。
 */
function reportUnexpected(err) {
  const msg = (err && (err.message || err)) + '';
  const onGate = !$('gate').classList.contains('hidden');
  if (onGate) {
    const codeVisible = !$('step-code').classList.contains('hidden');
    gateError(codeVisible ? 'code' : 'email', '予期しないエラー: ' + msg);
  } else {
    toast('予期しないエラー: ' + msg);
  }
  hideBusy();
}

window.addEventListener('error', (ev) => reportUnexpected(ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => reportUnexpected(ev.reason));

window.addEventListener('DOMContentLoaded', () => {
  wireUp();
  lockZoom();
  registerServiceWorker();
  askPersistentStorage();
  boot();
});

window.addEventListener('hashchange', () => {
  if ($('app').classList.contains('hidden')) return;
  const r = parseHash();
  if (r.kind === 'month') renderMonthView(r.month);
  else if (r.kind === 'home') showView('home');
});

function parseHash() {
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'join' && p[1] && p[2]) return { kind: 'join', shelfId: p[1], inviteKey: p[2] };
  if (p[0] === 's' && p[1]) return { kind: 'public', shelfId: p[1] };
  if (p[0] === 'm' && p[1]) return { kind: 'month', month: p[1] };
  return { kind: 'home' };
}

async function boot() {
  showBusy('読み込んでいます…');
  const route = parseHash();

  if (!store.api) {
    // 通常は app.js の DEFAULT_API が入っているので、ここに来るのは設定漏れのとき
    document.body.innerHTML =
      '<div style="padding:44px 24px;font-family:sans-serif;line-height:2;color:#33232A">' +
      '設定が完了していません。管理者にお知らせください。</div>';
    return;
  }

  // 招待リンクは、ログインの後で処理できるよう覚えておく
  if (route.kind === 'join') {
    store.pendingJoin = { shelfId: route.shelfId, inviteKey: route.inviteKey };
    history.replaceState(null, '', baseUrl());
    if (!store.token) { showGate('invite'); return; }
  }

  // 公開リンクはログイン不要
  if (route.kind === 'public') {
    await openShelf(route.shelfId);
    return;
  }

  if (!store.token) { hideBusy(); showGate('email'); return; }

  try {
    const d = await api('me', { token: store.token });
    S.user = d.user;
    S.shelves = d.shelves;
  } catch (err) {
    store.token = '';
    hideBusy();
    showGate('email');
    if (!err.authFailed) gateError('email', err.message);
    return;
  }

  await afterLogin();
}

/** ログイン直後の共通処理。招待の消化 → 本棚を開く。 */
async function afterLogin() {
  if (!S.user.displayName) { showGate('profile'); return; }

  const pending = store.pendingJoin;
  if (pending) {
    store.pendingJoin = null;
    try {
      const d = await authed('joinShelf', pending);
      S.shelves = d.shelves;
      // 着地するのは自分の本棚。招かれた本棚は「みんな」に並ぶ
      toast(d.alreadyMember
        ? `「${d.name}」は「みんな」から見られます`
        : `「${d.name}」が「みんな」に加わりました`);
    } catch (err) {
      toast(err.message);
    }
  }

  if (!S.shelves.some((s) => s.isMine)) {
    // 本棚がないアカウント（招待に失敗したときなど）。1つ用意する。
    try {
      const d = await authed('createShelf', { name: '' });
      S.shelves = d.shelves;
      store.lastShelf = d.shelfId;
    } catch (err) { toast(err.message); showGate('email'); return; }
  }

  // 1人1つの本棚。開くのは常に自分のもの。
  const mine = S.shelves.find((s) => s.isMine);
  await openShelf(mine ? mine.shelfId : S.shelves[0].shelfId);
  startUnreadPolling();
}

function showGate(step) {
  hideBusy();
  $('app').classList.add('hidden');
  $('gate').classList.remove('hidden');
  ['email', 'code', 'profile', 'invite'].forEach((s) => {
    $('step-' + s).classList.toggle('hidden', s !== step);
  });
  if (step === 'code') setTimeout(() => $('in-code').focus(), 150);
  if (step === 'email') {
    $('hint-goto-code').classList.add('hidden');
    // 前に使ったアドレスを入れておく（Safariは7日で保存が消えるため、
    // 入れ直しの手間をできるだけ減らす）
    if (!$('in-email').value && store.lastEmail) $('in-email').value = store.lastEmail;
    setTimeout(() => $('in-email').focus(), 150);
  }
  if (step === 'profile') {
    // 1人1つの本棚。招待から来た人にも、自分の本棚をつくってもらう
    const hasOwn = S.shelves.some((x) => x.isMine);
    $('field-first-shelf').classList.toggle('hidden', hasOwn);
    // 前の人の入力が残らないよう、毎回いまのユーザーから決め直す
    $('in-display-name').value = S.user?.displayName || S.user?.suggestedName || '';
    $('in-first-shelf').value = '';
    setTimeout(() => $('in-display-name').focus(), 150);
  }
}

/* ============================================================
   ログイン
   ========================================================== */

async function sendCode(btn) {
  const email = $('in-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast('メールアドレスを確かめてください');
    return;
  }
  gateError('email', '');
  await busy(btn, 'コードを送っています…', async () => {
    try {
      await api('requestCode', { email });
    } catch (err) {
      // 何が起きたか画面に残す。トーストは数秒で消えて見逃されるため
      gateError('email', err.message);
      // 送信自体は通っていることがあるので、手で進める道を出しておく
      pendingEmail = email;
      $('hint-goto-code').classList.remove('hidden');
      return;
    }
    // 送信が通ったら、何よりも先に画面を切り替える。
    // 後続の処理でつまずいても、コード入力にはたどり着けるようにする。
    pendingEmail = email;
    $('ui-sent-to').textContent = email;
    $('in-code').value = '';
    gateError('code', '');
    showGate('code');

    try { store.lastEmail = email; } catch (e) { /* 覚えられなくても支障はない */ }
  });
}

async function verifyCode(btn) {
  const code = $('in-code').value.replace(/\D/g, '');
  if (code.length !== 6) { toast('6桁のコードを入力してください'); return; }

  gateError('code', '');
  await busy(btn, 'ログインしています…', async () => {
    let d;
    try {
      d = await api('verifyCode', { email: pendingEmail, code });
    } catch (err) {
      gateError('code', err.message);
      $('in-code').value = '';
      $('in-code').focus();
      return;
    }
    store.token = d.token;
    S.user = d.user;
    S.shelves = d.shelves;
    $('in-code').value = '';
    showBusy('本棚を開いています…');
    await afterLogin();
  });
}

async function finishProfile(btn) {
  const name = $('in-display-name').value.trim();
  if (!name) { toast('呼び名を入れてください'); $('in-display-name').focus(); return; }

  await busy(btn, '準備しています…', async () => {
    try {
      const p = await authed('setProfile', { displayName: name });
      S.user = p.user;

      if (!S.shelves.some((x) => x.isMine)) {
        const shelfName = $('in-first-shelf').value.trim();
        const d = await authed('createShelf', { name: shelfName });
        S.shelves = d.shelves;
        store.lastShelf = d.shelfId;
      }
      await afterLogin();
    } catch (err) {
      toast(err.message);
    }
  });
}

async function logout() {
  if (!confirm('この端末からログアウトします。')) return;
  try { await api('logout', { token: store.token }); } catch (e) { /* 気にしない */ }
  store.token = '';
  store.lastShelf = '';
  S = { user: null, shelves: [], canEdit: false, shelf: null, members: [], entries: [], recs: [] };
  stopChatPolling();
  if (unreadTimer) { clearInterval(unreadTimer); unreadTimer = null; }
  messages = []; lastMsgAt = ''; unreadByShelf = {}; clearQuote();
  closeAllSheets();
  location.hash = '';
  showGate('email');
  toast('ログアウトしました');
}

/* ============================================================
   本棚を開く
   ========================================================== */

async function openShelf(shelfId) {
  const quiet = !!S.shelf;   // 2回目以降は画面が残っているので静かに
  if (!quiet) showBusy('本棚を開いています…');
  try {
    const d = await api('getShelf', { shelfId, token: store.token });
    S.canEdit = d.canEdit;
    S.canWrite = d.canWrite !== undefined ? d.canWrite : d.canEdit;
    S.myRole = d.myRole || null;
    S.shelf = d.shelf;
    S.members = d.members;
    S.entries = d.entries;
    S.recs = d.recs;
    if (d.me) S.user = d.me;
    if (d.shelves && d.shelves.length) S.shelves = d.shelves;
    if (d.canEdit) store.lastShelf = shelfId;
    // 未読はまとめて返ってくるので、ここで通信を追加しない
    if (d.unreadAll) unreadByShelf = d.unreadAll;
    unreadByShelf[shelfId] = d.unread || 0;

    // 本棚を移ったら会話も入れ替える
    messages = [];
    lastMsgAt = '';

    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    renderAll();
    maybeShowInstallHint();

    const r = parseHash();
    if (r.kind === 'month') renderMonthView(r.month);
    else showView('home');
  } catch (err) {
    toast(err.message);
    if (!store.token) showGate('email');
  } finally {
    hideBusy();
  }
}

function renderAll() {
  $('ui-shelf-name').textContent = S.shelf.name;

  // 読むだけの人には、なぜ書けないのかを出す
  const note = $('readonly-note');
  const owner = S.members.find((m) => m.role === 'owner');
  if (!S.canWrite) {
    note.textContent = owner
      ? `${owner.displayName}さんの本棚です。回覧板にコメントを残せます。`
      : '共有された本棚を見ています。記録の追加はできません。';
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }

  $('btn-add').classList.toggle('hidden', !S.canWrite);
  $('btn-share-open').classList.toggle('hidden', !(S.shelf && S.shelf.isOwner));
  $('btn-ai-open').classList.toggle('hidden', !S.canEdit);
  $('btn-nav-people').classList.toggle('hidden', !S.user);
  $('btn-see-all').classList.toggle('hidden', S.entries.length === 0);

  renderBoardTile();
  renderNow();
  renderCounts();
  renderRecent();
  renderMembers();
  renderMonthStrip();
  renderRecs();
  renderUnread();
}

function renderNow() {
  const m = thisMonth();
  const p = monthParts(m);
  $('ui-now-month').innerHTML = esc(p.month) + '<small>月</small>';

  const list = S.entries.filter((e) => e.month === m);
  const books = list.filter((e) => e.kind === 'book').length;
  const films = list.filter((e) => e.kind === 'movie').length;

  $('ui-now-count').textContent = list.length
    ? p.year + '年 ・ 本' + books + ' 映画' + films
    : p.year + '年';

  const ul = $('ui-now-list');
  ul.innerHTML = list.map((e) => entryRow(e)).join('');
  ul.classList.toggle('hidden', list.length === 0);
  $('ui-now-empty').classList.toggle('hidden', list.length > 0);
}

function renderCounts() {
  $('ui-book-count').innerHTML =
    S.entries.filter((e) => e.kind === 'book').length + '<span>冊</span>';
  $('ui-movie-count').innerHTML =
    S.entries.filter((e) => e.kind === 'movie').length + '<span>本</span>';
}

function renderRecent() {
  const ul = $('ui-recent-list');
  const list = S.entries.slice(0, 6);
  ul.innerHTML = list.length
    ? list.map((e) => entryRow(e, true)).join('')
    : '<li class="rec-row"><span class="rec-meta">まだ記録がありません。</span></li>';
}

function entryRow(e, withMonth) {
  const mine = S.user && e.userId === S.user.userId;
  const who = S.members.length > 1 ? e.byName : '';
  const meta = [
    e.creator,
    withMonth ? monthParts(e.month).year + '.' + monthParts(e.month).month : '',
    who
  ].filter(Boolean).join(' ・ ');

  return `<li class="rec-row">
    <span class="kind-chip${e.kind === 'movie' ? ' is-movie' : ''}">${e.kind === 'movie' ? '映画' : '本'}</span>
    <span class="rec-body">
      <span class="rec-title">${esc(e.title)}</span>
      ${meta ? `<span class="rec-meta">${esc(meta)}</span>` : ''}
      ${e.note ? `<span class="rec-note">${esc(e.note)}</span>` : ''}
    </span>
    ${e.rating ? `<span class="stars">${stars(e.rating)}</span>` : ''}
    ${S.canEdit && S.members.length > 1
      ? `<button class="row-talk" data-talk='${esc(JSON.stringify({ type: 'entry', id: e.entryId, kind: e.kind, title: e.title, creator: e.creator }))}'>コメント</button>`
      : ''}
    ${S.canWrite && mine ? `<button class="row-edit" data-edit="${esc(e.entryId)}">直す</button>` : ''}
  </li>`;
}

function renderMembers() {
  $('ui-members').innerHTML = S.members
    .map((m) => `<span class="member-dot">${esc(m.displayName)}</span>`)
    .join('');
}

function renderMonthStrip() {
  const counts = {};
  S.entries.forEach((e) => { counts[e.month] = (counts[e.month] || 0) + 1; });

  const months = [];
  const d = new Date();
  for (let i = 0; i < 12; i++) {
    months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    d.setMonth(d.getMonth() - 1);
  }
  Object.keys(counts).forEach((m) => { if (months.indexOf(m) === -1) months.push(m); });
  months.sort().reverse();

  $('ui-month-strip').innerHTML = months.map((m) => {
    const p = monthParts(m);
    const n = counts[m] || 0;
    return `<button class="month-card${n ? ' is-on' : ''}" data-month="${m}">
      <i>${p.year}</i><b>${p.month}月</b><em>${n ? n + '件' : '—'}</em>
    </button>`;
  }).join('');
}

function renderMonthView(month) {
  const list = S.entries.filter((e) => e.month === month);
  const p = monthParts(month);
  $('ui-month-eyebrow').textContent = p.year;
  $('ui-month-title').textContent = p.month + '月のしおり';
  $('ui-month-list').innerHTML = list.length
    ? list.map((e) => entryRow(e)).join('')
    : '<li class="rec-row"><span class="rec-meta">この月の記録はまだありません。</span></li>';
  showView('month');
}

/* ---------- おすすめ ---------- */

/** 「2026.08.24」のような表示に。当日なら「今日」。 */
function recWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  if (same) return '今日 ' + String(d.getHours()) + ':' + String(d.getMinutes()).padStart(2, '0');
  return iso.slice(0, 10).replace(/-/g, '.');
}

function renderRecs() {
  const body = $('ui-recs-body');

  // 何度でも聞けることが分かるよう、ボタンは常に一番上に置く
  const askBtn = S.canWrite
    ? `<button class="btn btn-primary btn-block" id="btn-ask-again">
         ${S.recs.length ? 'もう一度聞く' : 'おすすめを聞く'}
       </button>`
    : '';

  if (!S.recs.length) {
    body.innerHTML = `<div class="blank">
      <p>おすすめはまだありません。<br>記録がいくつか集まると、傾向から選べるようになります。</p>
      ${askBtn}
    </div>`;
    const b = $('btn-ask-again');
    if (b) b.addEventListener('click', openAiSheet);
    return;
  }

  const list = S.recs.map((r, idx) => {
    const by = r.by ? ' ・ ' + r.by : '';
    const kindLabel = r.kind === 'book' ? '本' : r.kind === 'movie' ? '映画' : '本と映画';
    const head = idx === 0
      ? `<p class="eyebrow">最新 ・ ${esc(recWhen(r.createdAt))}${esc(by)}</p>`
      : `<p class="eyebrow">${esc(recWhen(r.createdAt))}${esc(by)} ・ ${esc(kindLabel)}</p>`;

    // 過去の分は畳んでおく。開くまでは場所を取らない
    const cards = `<div class="sug-list">${r.items.map((it) => sugCard(it, r.recId)).join('')}</div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-paper" data-share-rec="${esc(r.recId)}">この${r.items.length}件をまとめて共有</button>
      </div>`;

    if (idx === 0) {
      return `<div class="rec-block">${head}${cards}</div>`;
    }
    return `<details class="rec-block rec-past">
      <summary>${head}<span class="rec-count">${r.items.length}件</span></summary>
      <div style="margin-top:12px">${cards}</div>
    </details>`;
  }).join('');

  body.innerHTML = `
    ${askBtn ? `<div class="rec-ask">${askBtn}</div>` : ''}
    ${list}
    ${S.recs.length > 1 ? '<p class="rec-note">これまでのおすすめは5回分まで残ります。</p>' : ''}
  `;

  const b = $('btn-ask-again');
  if (b) b.addEventListener('click', openAiSheet);
}

function sugCard(it, recId) {
  return `<article class="sug">
    <div class="sug-head">
      <span class="kind-chip${it.kind === 'movie' ? ' is-movie' : ''}">${it.kind === 'movie' ? '映画' : '本'}</span>
      <div style="min-width:0">
        <div class="sug-title">${esc(it.title)}</div>
        <div class="sug-meta">${esc([it.creator, it.year].filter(Boolean).join(' ・ '))}</div>
      </div>
    </div>
    <p class="sug-reason">${esc(it.reason)}</p>
    <span class="sug-mood">${esc(it.mood || '')}</span>
    <div class="btn-row" style="margin-top:12px">
      ${S.canEdit && S.members.length > 1
        ? `<button class="btn btn-line" data-talk='${esc(JSON.stringify({ type: 'rec', id: recId, kind: it.kind, title: it.title, creator: it.creator }))}'>これにコメント</button>`
        : ''}
      <button class="btn btn-line"
        data-share-one='${esc(JSON.stringify({ t: it.title, c: it.creator, r: it.reason }))}'>共有する</button>
    </div>
  </article>`;
}

async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; }
    catch (err) { if (err && err.name === 'AbortError') return; }
  }
  await copyText(text);
}


/* ============================================================
   はなす（本棚のチャット）
   ============================================================
   会話は本棚ごとに1本。作品を引用したメッセージは、
   引用時点の題名を写し取ってあるので、元の記録が消えても読める。
   ========================================================== */

function fmtTime(iso) {
  const d = new Date(iso);
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}

function fmtDay(iso) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today.getTime() - 864e5);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return '今日';
  if (same(d, y)) return 'きのう';
  return (d.getFullYear() === today.getFullYear() ? '' : d.getFullYear() + '年 ') +
         (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function renderChat() {
  const box = $('ui-chat-log');
  if (!messages.length) {
    box.innerHTML = `<div class="chat-empty">
      まだ会話はありません。<br>
      記録やおすすめの「話す」から、作品を引用して始められます。
    </div>`;
    return;
  }

  let lastDay = '';
  box.innerHTML = messages.map((m) => {
    const mine = S.user && m.userId === S.user.userId;
    const day = fmtDay(m.createdAt);
    const sep = day !== lastDay ? `<div class="chat-day">${esc(day)}</div>` : '';
    lastDay = day;

    // 吹き出しは本文だけ改行を活かすので、引用部分は1行に詰めて書く
    const ref = m.ref
      ? `<span class="msg-ref">` +
        `<span class="kind-chip${m.ref.kind === 'movie' ? ' is-movie' : ''}">${m.ref.kind === 'movie' ? '映画' : '本'}</span>` +
        `<span class="msg-ref-body"><b>${esc(m.ref.title)}</b>` +
        (m.ref.creator ? `<i>${esc(m.ref.creator)}</i>` : '') +
        `</span></span>`
      : '';

    return `${sep}<div class="msg${mine ? ' is-mine' : ''}${m.ref ? ' has-ref' : ''}">
      ${mine ? '' : `<span class="msg-who">${esc(m.byName)}</span>`}
      <span class="msg-bubble">${ref}<span class="msg-text">${esc(m.body)}</span></span>
      <span class="msg-time">${esc(fmtTime(m.createdAt))}</span>
    </div>`;
  }).join('');
}

function scrollChatToEnd(smooth) {
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  });
}

/** 会話を取り込む。after があれば差分だけ足す。 */
function mergeMessages(list) {
  if (!list || !list.length) return false;
  const seen = {};
  messages.forEach((m) => { seen[m.msgId] = true; });
  let added = 0;
  list.forEach((m) => {
    if (seen[m.msgId]) return;
    messages.push(m); added++;
  });
  if (!added) return false;
  messages.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  lastMsgAt = messages[messages.length - 1].createdAt;
  return true;
}

async function openChat() {
  const owner = S.members.find((m) => m.role === 'owner');
  $('ui-board-title').textContent = S.shelf.isOwner
    ? '自分の本棚のコメント'
    : (owner ? `${owner.displayName}さんの本棚のコメント` : 'コメント');
  $('btn-board-back').textContent = S.shelf.isOwner ? '自分の本棚へ' : 'この本棚に戻る';
  showView('chat');
  if (!messages.length) {
    $('ui-chat-log').innerHTML = '<div class="spinner"></div>';
  }
  await pullMessages(true);
  startChatPolling();
  markChatRead();
  setTimeout(() => $('in-chat').focus(), 120);
}

async function pullMessages(full) {
  try {
    const d = await authed('getMessages', {
      shelfId: S.shelf.shelfId,
      after: full ? '' : lastMsgAt
    });
    if (full) { messages = []; lastMsgAt = ''; }
    const changed = mergeMessages(d.messages);
    if (full || changed) {
      renderChat();
      if (full) scrollChatToEnd(false);
      else scrollChatToEnd(true);
    }
    if (changed && !full) markChatRead();
  } catch (err) {
    if (full) {
      $('ui-chat-log').innerHTML =
        `<div class="chat-empty">${esc(err.message)}</div>`;
    }
    // 追いかけの失敗は黙って見送る。次の周期で取り直す。
  }
}

/**
 * 会話画面を見ている間だけ、10秒ごとに新しい発言を取りに行く。
 * 画面が隠れたら止める（GASの実行時間を無駄に使わないため）。
 */
function startChatPolling() {
  stopChatPolling();
  chatTimer = setInterval(() => {
    if (document.hidden) return;
    if ($('view-chat').classList.contains('hidden')) { stopChatPolling(); return; }
    pullMessages(false);
  }, 10000);
}

function stopChatPolling() {
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
}

async function sendMessage(btn) {
  const text = $('in-chat').value.trim();
  if (!text) { $('in-chat').focus(); return; }

  await busy(btn, '…', async () => {
    try {
      const d = await authed('postMessage', {
        shelfId: S.shelf.shelfId,
        body: text,
        ref: quoted || undefined
      });
      $('in-chat').value = '';
      autoGrow($('in-chat'));
      clearQuote();
      mergeMessages([d.message]);
      renderChat();
      scrollChatToEnd(true);
      unreadByShelf[S.shelf.shelfId] = 0;
      renderUnread();
    } catch (err) { toast(err.message); }
  });
}

async function markChatRead() {
  if (!lastMsgAt) return;
  unreadByShelf[S.shelf.shelfId] = 0;
  renderUnread();
  try { await authed('markRead', { shelfId: S.shelf.shelfId, at: lastMsgAt }); }
  catch (err) { /* 次に開いたときに直る */ }
}

/* ---------- 引用 ---------- */

function setQuote(ref) {
  quoted = ref;
  $('ui-quote').classList.remove('hidden');
  $('ui-quote-kind').textContent = ref.kind === 'movie' ? '映画' : '本';
  $('ui-quote-kind').classList.toggle('is-movie', ref.kind === 'movie');
  $('ui-quote-title').textContent = ref.title;
  $('ui-quote-creator').textContent = ref.creator || '';
}

function clearQuote() {
  quoted = null;
  $('ui-quote').classList.add('hidden');
}

async function talkAbout(ref) {
  setQuote(ref);
  await openChat();
  scrollChatToEnd(false);
  $('in-chat').focus();
}

/* ---------- 未読の赤い印 ---------- */

/**
 * 未読の見せ方は立場で違う。
 *   自分の本棚（オーナー）… ホームのコメントタイルに印
 *   共有された本棚（見る人）… 「みんな」の一覧に「コメント◯件」
 */
function renderUnread() {
  if (S.shelf) renderBoardTile();

  // タブの印は「自分の本棚」に来たコメントだけを見る
  const mine = S.shelves.find((x) => x.isMine);
  const mineUnread = mine ? (unreadByShelf[mine.shelfId] || 0) : 0;
  $('ui-unread-dot').classList.toggle('hidden', mineUnread === 0);

  // 共有された本棚に未読があれば「みんな」タブにも印を出す
  const others = S.shelves.filter((x) => !x.isMine)
    .reduce((a, x) => a + (unreadByShelf[x.shelfId] || 0), 0);
  $('ui-people-dot').classList.toggle('hidden', others === 0);

  if (!$('view-people').classList.contains('hidden')) renderPeople();
}

/** 赤い印だけを軽く確認する。会話画面を見ていないときの巡回。 */
async function checkUnread() {
  if (!S.canEdit || !S.user) return;
  try {
    const d = await authed('checkUnread', {});
    unreadByShelf = d.unread || {};
    renderUnread();
  } catch (err) { /* 黙って見送る */ }
}

function startUnreadPolling() {
  if (unreadTimer) clearInterval(unreadTimer);
  unreadTimer = setInterval(() => {
    if (document.hidden) return;
    if (!$('view-chat').classList.contains('hidden')) return; // 回覧板を見ている間は不要
    checkUnread();
  }, 60000);
}

/** 入力欄を中身に合わせて伸ばす。 */
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}


/* ============================================================
   一覧（この本棚のすべて）
   ============================================================
   記録が増えると「最近の6件」だけでは足りなくなるので、
   絞り込みと並べ替えでたどれるようにする。
   ========================================================== */

function openAll() {
  renderWhoChips();
  renderAllList();
  showView('all');
}

/** 記録した人での絞り込み。ひとりの本棚では出さない。 */
function renderWhoChips() {
  const box = $('filter-who');
  if (S.members.length < 2) { box.innerHTML = ''; return; }
  box.innerHTML = '<button class="chip' + (allWho === 'all' ? ' is-on' : '') + '" data-who="all">みんな</button>' +
    S.members.map((m) =>
      `<button class="chip${allWho === m.userId ? ' is-on' : ''}" data-who="${esc(m.userId)}">${esc(m.displayName)}</button>`
    ).join('');
}

function filteredEntries() {
  const q = allQuery.trim().toLowerCase();
  let list = S.entries.slice();

  if (allKind !== 'all') list = list.filter((e) => e.kind === allKind);
  if (allWho !== 'all') list = list.filter((e) => e.userId === allWho);
  if (q) {
    list = list.filter((e) =>
      (e.title + ' ' + e.creator + ' ' + e.note + ' ' + (e.tags || []).join(' '))
        .toLowerCase().includes(q)
    );
  }

  if (allSort === 'old') {
    list.sort((a, b) => (a.month === b.month
      ? (a.createdAt < b.createdAt ? -1 : 1)
      : (a.month < b.month ? -1 : 1)));
  } else if (allSort === 'rating') {
    list.sort((a, b) => (b.rating - a.rating) || (a.month < b.month ? 1 : -1));
  } else if (allSort === 'title') {
    list.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  }
  // 'new' は S.entries が既に新しい順なのでそのまま

  return list;
}

function renderAllList() {
  const list = filteredEntries();
  const books = list.filter((e) => e.kind === 'book').length;
  const films = list.length - books;

  $('ui-all-count').textContent = list.length
    ? `${list.length}件（本${books} ・ 映画${films}）／ 全${S.entries.length}件`
    : `全${S.entries.length}件のうち、条件に合うものはありません`;

  $('ui-all-list').innerHTML = list.length
    ? list.map((e) => entryRow(e, true)).join('')
    : '<li class="all-empty">見つかりませんでした。<br>言葉を変えるか、絞り込みを外してみてください。</li>';
}


/* ============================================================
   みんなの本棚
   ============================================================
   招待でつながった本棚だけが並ぶ。
   自分がつくったものと、招かれたものを分けて見せる。
   ========================================================== */

function roleLabel(role) {
  return role === 'owner' ? '自分の本棚' : '見るだけ';
}

function shelfCard(s) {
  const on = S.shelf && s.shelfId === S.shelf.shelfId;
  const unread = unreadByShelf[s.shelfId] || 0;
  const sub = [
    s.ownerName ? s.ownerName + 'さん' : null,
    s.entryCount + '件の記録'
  ].filter(Boolean).join(' ・ ');

  return `<button class="shelf-card${on ? ' is-on' : ''}" data-shelf="${esc(s.shelfId)}">
    <span class="mark" aria-hidden="true"></span>
    <span class="shelf-card-body">
      <b>${esc(s.name)}</b>
      <span>${esc(sub)}</span>
    </span>
    ${unread ? `<span class="role-tag is-unread">コメント${unread}件</span>` : ''}
  </button>`;
}

function renderPeople() {
  const others = S.shelves.filter((s) => !s.isMine);

  $('ui-people-body').innerHTML = others.length
    ? others.map(shelfCard).join('')
    : `<div class="blank">
        <p>まだ共有されている本棚はありません。<br>
        友人に招待リンクをもらうと、その人の本棚がここに並びます。</p>
      </div>`;
}

/* ============================================================
   画面の切り替え
   ========================================================== */


/** ホームのコメントタイル。件数と未読を出す。 */
function renderBoardTile() {
  const n = messages.length;
  const unread = unreadByShelf[S.shelf.shelfId] || 0;
  const solo = S.members.length < 2;

  const lede = solo
    ? '共有すると、見た人がここにコメントを残せます。'
    : unread ? `新しいコメントが${unread}件あります。`
    : n ? `これまでに${n}件のコメント。`
    : 'まだコメントはありません。';

  $('ui-board-lede').textContent = lede;
  $('ui-tile-dot').classList.toggle('hidden', unread === 0);
  $('btn-open-board').textContent = unread ? `コメントを読む（${unread}）` : '回覧板をひらく';
}

/**
 * 「コメント」タブ。
 * 自分の本棚に来たコメントを見る場所なので、
 * 他の人の本棚を開いていたら自分のものに切り替えてから開く。
 */
async function openMyBoard() {
  const mine = S.shelves.find((x) => x.isMine);
  if (mine && (!S.shelf || S.shelf.shelfId !== mine.shelfId)) {
    await openShelf(mine.shelfId);
  }
  await openChat();
}

/** 「本棚」タブ。他の人の本棚を見ていたら、自分のものに戻す。 */
async function goHome() {
  const mine = S.shelves.find((x) => x.isMine);
  if (mine && (!S.shelf || S.shelf.shelfId !== mine.shelfId)) {
    await openShelf(mine.shelfId);
  } else {
    showView('home');
  }
}

function showView(name) {
  ['home', 'month', 'recs', 'chat', 'all', 'people', 'account'].forEach((v) => {
    $('view-' + v).classList.toggle('hidden', v !== name);
  });
  if (name !== 'chat') stopChatPolling();

  // 回覧板の画面は「コメント」タブとして光らせる
  const navName = name === 'chat' ? 'board' : (name === 'month' || name === 'all' ? 'home' : name);
  $$('.dock button[data-nav]').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.nav === navName);
  });
  if (name !== 'chat') window.scrollTo({ top: 0, behavior: 'instant' });
}

/* ============================================================
   本棚の切り替え
   ========================================================== */

function openShelfSwitcher() {
  $('ui-shelf-list').innerHTML = S.shelves.map((s) => `
    <button class="shelf-row${s.shelfId === S.shelf.shelfId ? ' is-on' : ''}" data-shelf="${esc(s.shelfId)}">
      <span class="mark" aria-hidden="true"></span>
      <span class="shelf-row-body">
        <b>${esc(s.name)}</b>
        <span>${s.entryCount}件${s.role === 'owner' ? ' ・ 自分の本棚' : ' ・ 参加中'}${s.isPublic ? ' ・ 公開中' : ''}</span>
      </span>
    </button>`).join('');
  $('in-new-shelf').value = '';
  openSheet('sheet-shelves');
}

async function createNewShelf(btn, inputId) {
  const el = $(inputId || 'in-new-shelf');
  const name = el.value.trim();
  if (!name) { toast('本棚の名前を入れてください'); return; }
  await busy(btn, 'つくっています…', async () => {
    try {
      const d = await authed('createShelf', { name });
      S.shelves = d.shelves;
      closeSheet('sheet-shelves');
      el.value = '';
      await openShelf(d.shelfId);
      toast(`「${d.name}」をつくりました`);
    } catch (err) { toast(err.message); }
  });
}

/* ============================================================
   記録フォーム
   ========================================================== */

function openEntry(entry) {
  editingId = entry ? entry.entryId : null;
  formKind = entry ? entry.kind : 'book';
  formRating = entry ? entry.rating : 0;

  $('entry-heading').textContent = entry ? 'しおりを直す' : 'しおりを挟む';
  $('in-title').value = entry ? entry.title : '';
  $('in-creator').value = entry ? entry.creator : '';
  $('in-month').value = entry ? entry.month : thisMonth();
  $('in-note').value = entry ? entry.note : '';
  $('btn-entry-delete').classList.toggle('hidden', !entry);

  syncKind();
  renderStars();
  openSheet('sheet-entry');
  setTimeout(() => $('in-title').focus(), 120);
}

function syncKind() {
  $$('#seg-kind button').forEach((b) => b.classList.toggle('is-on', b.dataset.kind === formKind));
  $('lbl-creator').textContent = formKind === 'movie' ? '監督' : '著者';
  $('lbl-month').textContent = formKind === 'movie' ? '観た月' : '読み終えた月';
}

function renderStars() {
  $('rate-stars').innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<button type="button" data-star="${n}" class="${n <= formRating ? 'is-on' : ''}" aria-label="${n}">★</button>`)
    .join('');
}

async function saveEntry(btn) {
  const title = $('in-title').value.trim();
  if (!title) { toast('タイトルを入れてください'); $('in-title').focus(); return; }

  const entry = {
    kind: formKind,
    title,
    creator: $('in-creator').value.trim(),
    month: $('in-month').value || thisMonth(),
    rating: formRating,
    note: $('in-note').value.trim()
  };

  await busy(btn, '保存中…', async () => {
    try {
      if (editingId) {
        await authed('updateEntry', { shelfId: S.shelf.shelfId, entryId: editingId, entry });
        toast('直しました');
      } else {
        await authed('addEntry', { shelfId: S.shelf.shelfId, entry });
        toast('しおりを挟みました');
      }
      closeSheet('sheet-entry');
      await openShelf(S.shelf.shelfId);
    } catch (err) { toast(err.message); }
  });
}

async function deleteEntry() {
  if (!editingId) return;
  if (!confirm('この記録を消します。戻せません。')) return;
  try {
    await authed('deleteEntry', { shelfId: S.shelf.shelfId, entryId: editingId });
    closeSheet('sheet-entry');
    toast('消しました');
    await openShelf(S.shelf.shelfId);
  } catch (err) { toast(err.message); }
}

/* ============================================================
   おすすめの生成
   ========================================================== */

function openAiSheet() {
  $('field-ai-scope').classList.toggle('hidden', S.members.length < 2);
  openSheet('sheet-ai');
}

async function runRecommend() {
  const mood = $('in-mood').value.trim();
  closeSheet('sheet-ai');
  showView('recs');
  // 履歴は残したまま、上に「考え中」を差し込む
  renderRecs();
  const wait = document.createElement('div');
  wait.id = 'ui-rec-wait';
  wait.innerHTML = '<div class="spinner"></div><p class="wait">これまでのしおりを読み返しています…</p>';
  $('ui-recs-body').prepend(wait);

  try {
    const d = await authed('recommend', {
      shelfId: S.shelf.shelfId,
      kind: aiKind,
      mood,
      onlyMine: aiScope === 'mine'
    });
    S.recs = [d.rec].concat(S.recs).slice(0, 5);
    renderRecs();
  } catch (err) {
    // それまでの履歴は消さず、上にお知らせだけ出す
    renderRecs();
    const box = document.createElement('div');
    box.className = 'blank';
    box.style.marginBottom = '18px';
    box.innerHTML = `<p>${esc(err.message)}</p>
      <button class="btn btn-primary" id="btn-retry-ai">もう一度ためす</button>`;
    $('ui-recs-body').prepend(box);
    $('btn-retry-ai').addEventListener('click', openAiSheet);
  }
}

/* ============================================================
   共有
   ========================================================== */

function openShare() {
  const s = S.shelf;
  $('ui-invite-url').textContent = baseUrl() + '#/join/' + s.shelfId + '/' + s.inviteKey;
  $('ui-public-url').textContent = baseUrl() + '#/s/' + s.shelfId;

  const on = !!s.isPublic;
  $$('#seg-public button').forEach((b) => {
    b.classList.toggle('is-on', (b.dataset.public === 'on') === on);
  });
  $('public-box').classList.toggle('hidden', !on);
  renderMemberAdmin();
  openSheet('sheet-share');
}

async function setPublic(enabled) {
  try {
    await authed('setPublic', { shelfId: S.shelf.shelfId, isPublic: enabled });
    S.shelf.isPublic = enabled;
    $$('#seg-public button').forEach((b) => {
      b.classList.toggle('is-on', (b.dataset.public === 'on') === enabled);
    });
    $('public-box').classList.toggle('hidden', !enabled);
    toast(enabled ? '公開しました' : '公開をやめました');
  } catch (err) { toast(err.message); }
}


/* ============================================================
   メンバーを外す（オーナーのみ）
   ========================================================== */

function renderMemberAdmin() {
  const box = $('ui-member-admin');
  if (!box) return;
  const canKick = S.shelf.isOwner && S.members.length > 1;

  box.innerHTML = S.members.map((m) => {
    const me = S.user && m.userId === S.user.userId;
    const owner = m.role === 'owner';
    return `<div class="member-row">
      <b>${esc(m.displayName)}</b>
      ${owner ? '<span class="member-tag">つくった人</span>' : '<span class="member-tag">見ている人</span>'}
      ${me ? '<span class="member-tag">あなた</span>' : ''}
      ${canKick && !me
        ? `<button class="member-kick" data-kick="${esc(m.userId)}" data-kickname="${esc(m.displayName)}">外す</button>`
        : ''}
    </div>`;
  }).join('');
}

async function kickMember(userId, name) {
  const ok = confirm(
    `${name} さんをこの本棚から外します。\n\n` +
    'その人が書いた記録と発言は本棚に残ります。\n' +
    'もう一度招きたいときは、招待リンクを渡せば戻れます。'
  );
  if (!ok) return;

  try {
    await authed('removeMember', { shelfId: S.shelf.shelfId, userId: userId });
    toast(`${name} さんを外しました`);
    await openShelf(S.shelf.shelfId);
    renderMemberAdmin();
  } catch (err) { toast(err.message); }
}

/* ============================================================
   アカウント削除
   ========================================================== */

let deleteArmed = false;

async function openDeleteAccount() {
  deleteArmed = false;
  $('btn-delete-go').textContent = '削除する';
  $('ui-delete-step').textContent = '押すともう一度確認します。';
  $('ui-delete-summary').innerHTML = '<div class="spinner"></div>';
  openSheet('sheet-delete');

  try {
    const d = await authed('deletionPreview', {});
    const rows = [
      ['あなたの記録', d.entryCount + '件'],
      ['あなたがつくった本棚', d.ownedShelfCount + '個'],
      ['参加している他の人の本棚', d.joinedShelfCount + '個']
    ];

    let html = '<ul class="del-list">' +
      rows.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join('') +
      '</ul>';

    if (d.ownedShelfCount > 0 && d.affectedPeople > 0) {
      html += `<p class="del-warn">
        あなたがつくった本棚は、参加している${esc(d.affectedPeople)}人の記録ごと消えます。
        消える記録は全部で${esc(d.totalEntriesLost)}件です。<br>
        残したい場合は、先にその人に本棚を作り直してもらってください。
      </p>`;
    }
    html += '<p class="del-warn">元に戻すことはできません。</p>';
    $('ui-delete-summary').innerHTML = html;
  } catch (err) {
    $('ui-delete-summary').innerHTML = `<p class="del-warn">${esc(err.message)}</p>`;
  }
}

async function deleteAccount(btn) {
  // 一度目は身構えるだけ。二度目で実行する。
  if (!deleteArmed) {
    deleteArmed = true;
    btn.textContent = '本当に削除する';
    $('ui-delete-step').textContent = 'これが最後の確認です。もう一度押すと消えます。';
    return;
  }

  await busy(btn, '削除しています…', async () => {
    try {
      await authed('deleteAccount', { confirm: '削除' });
      store.token = '';
      store.lastShelf = '';
      store.pendingJoin = null;
      stopChatPolling();
      if (unreadTimer) clearInterval(unreadTimer);
      closeAllSheets();
      document.body.innerHTML =
        '<div class="gate"><div class="gate-inner" style="text-align:center">' +
        '<div class="gate-mark" aria-hidden="true"></div>' +
        '<h1>ありがとうございました</h1>' +
        '<p class="gate-lede">アカウントと記録を削除しました。<br>' +
        'また記録したくなったら、いつでも戻ってきてください。</p></div></div>';
    } catch (err) { toast(err.message); }
  });
}

/* ============================================================
   設定
   ========================================================== */

function openAccount() {
  if (S.user) {
    $('ui-my-name').textContent = S.user.displayName || '（未設定）';
    $('ui-my-email').textContent = S.user.email;
    $('in-rename').value = S.user.displayName || '';
  }
  showView('account');
}

async function renameMe(btn) {
  const name = $('in-rename').value.trim();
  if (!name) { toast('呼び名を入れてください'); return; }
  await busy(btn, '…', async () => {
    try {
      const d = await authed('setProfile', { displayName: name });
      S.user = d.user;
      $('ui-my-name').textContent = d.user.displayName;
      if (S.shelf) await openShelf(S.shelf.shelfId);
      toast('変えました');
    } catch (err) { toast(err.message); }
  });
}

/* ============================================================
   イベント配線
   ========================================================== */

function wireUp() {
  /* --- ログイン --- */
  $('btn-send-code').addEventListener('click', (ev) => sendCode(ev.currentTarget));
  $('btn-verify').addEventListener('click', (ev) => verifyCode(ev.currentTarget));
  $('btn-resend').addEventListener('click', (ev) => {
    $('in-email').value = pendingEmail;
    sendCode(ev.currentTarget);
  });
  $('btn-back-email').addEventListener('click', () => showGate('email'));
  $('btn-goto-code').addEventListener('click', () => {
    $('ui-sent-to').textContent = pendingEmail || $('in-email').value.trim();
    gateError('code', '');
    showGate('code');
  });
  $('btn-start').addEventListener('click', (ev) => finishProfile(ev.currentTarget));
  $('btn-invite-login').addEventListener('click', () => showGate('email'));

  $('in-email').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') $('btn-send-code').click();
  });
  $('in-code').addEventListener('input', (ev) => {
    ev.target.value = ev.target.value.replace(/\D/g, '').slice(0, 6);
    if (ev.target.value.length === 6) $('btn-verify').click();
  });
  $('in-display-name').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') $('in-first-shelf').focus();
  });

  /* --- 本棚 --- */
  $('btn-shelf-switch').addEventListener('click', () => {
    renderPeople();
    showView('people');
  });
  $('btn-shelves-close').addEventListener('click', () => closeSheet('sheet-shelves'));
  $('btn-new-shelf').addEventListener('click', (ev) => createNewShelf(ev.currentTarget));

  /* --- 記録 --- */
  $('btn-add').addEventListener('click', () => openEntry(null));
  $('btn-entry-cancel').addEventListener('click', () => closeSheet('sheet-entry'));
  $('btn-entry-save').addEventListener('click', (ev) => saveEntry(ev.currentTarget));
  $('btn-entry-delete').addEventListener('click', deleteEntry);

  $('seg-kind').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-kind]');
    if (!b) return;
    formKind = b.dataset.kind;
    syncKind();
  });

  $('rate-stars').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-star]');
    if (!b) return;
    const n = Number(b.dataset.star);
    formRating = (formRating === n) ? 0 : n;
    renderStars();
  });

  /* --- AI --- */
  $('btn-ai-open').addEventListener('click', openAiSheet);
  $('btn-ai-cancel').addEventListener('click', () => closeSheet('sheet-ai'));
  $('btn-ai-go').addEventListener('click', runRecommend);
  $('seg-ai-kind').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-aikind]');
    if (!b) return;
    aiKind = b.dataset.aikind;
    $$('#seg-ai-kind button').forEach((x) => x.classList.toggle('is-on', x === b));
  });
  $('seg-ai-scope').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-aiscope]');
    if (!b) return;
    aiScope = b.dataset.aiscope;
    $$('#seg-ai-scope button').forEach((x) => x.classList.toggle('is-on', x === b));
  });

  /* --- 共有 --- */
  $('btn-share-open').addEventListener('click', openShare);
  $('btn-share-close').addEventListener('click', () => closeSheet('sheet-share'));
  $('seg-public').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-public]');
    if (!b) return;
    setPublic(b.dataset.public === 'on');
  });

  /* --- 設定 --- */
  $('btn-rename-me').addEventListener('click', (ev) => renameMe(ev.currentTarget));
  $('btn-logout').addEventListener('click', logout);

  /* --- 一覧 --- */
  $('btn-see-all').addEventListener('click', openAll);

  $('in-search').addEventListener('input', (ev) => {
    // 打つたびに描き直すと重いので、少し待ってから
    clearTimeout(searchTimer);
    const v = ev.target.value;
    searchTimer = setTimeout(() => { allQuery = v; renderAllList(); }, 180);
  });

  $('filter-kind').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-kind]');
    if (!b) return;
    allKind = b.dataset.kind;
    $$('#filter-kind .chip').forEach((x) => x.classList.toggle('is-on', x === b));
    renderAllList();
  });

  $('filter-who').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-who]');
    if (!b) return;
    allWho = b.dataset.who;
    $$('#filter-who .chip').forEach((x) => x.classList.toggle('is-on', x === b));
    renderAllList();
  });

  $('filter-sort').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sort]');
    if (!b) return;
    allSort = b.dataset.sort;
    $$('#filter-sort .chip').forEach((x) => x.classList.toggle('is-on', x === b));
    renderAllList();
  });

  /* --- アカウント削除 --- */
  $('btn-delete-open').addEventListener('click', openDeleteAccount);
  $('btn-delete-cancel').addEventListener('click', () => closeSheet('sheet-delete'));
  $('btn-delete-go').addEventListener('click', (ev) => deleteAccount(ev.currentTarget));

  /* --- はなす --- */
  $('btn-open-board').addEventListener('click', openChat);
  $('btn-board-back').addEventListener('click', () => showView('home'));
  $('btn-chat-send').addEventListener('click', (ev) => sendMessage(ev.currentTarget));
  $('btn-quote-clear').addEventListener('click', clearQuote);
  $('in-chat').addEventListener('input', (ev) => autoGrow(ev.target));
  $('in-chat').addEventListener('keydown', (ev) => {
    // PCでは Enter で送信、Shift+Enter で改行。スマホは改行のまま。
    const isDesktop = window.matchMedia('(min-width: 720px)').matches;
    if (isDesktop && ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      $('btn-chat-send').click();
    }
  });

  // 画面を戻したときに追いつく
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!$('view-chat').classList.contains('hidden')) pullMessages(false);
    else checkUnread();
  });

  /* --- ナビ --- */
  $('btn-month-back').addEventListener('click', () => {
    location.hash = '';
    showView('home');
  });

  $('dock').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-nav]');
    if (!b) return;
    location.hash = '';
    if (b.dataset.nav === 'people') { renderPeople(); showView('people'); }
    else if (b.dataset.nav === 'account') openAccount();
    else if (b.dataset.nav === 'home') goHome();
    else if (b.dataset.nav === 'board') openMyBoard();
    else showView(b.dataset.nav);
  });

  $$('.veil').forEach((v) => {
    v.addEventListener('click', (ev) => { if (ev.target === v) v.classList.add('hidden'); });
  });

  /* --- 委譲でまとめて拾うもの --- */
  document.addEventListener('click', (ev) => {
    const shelfBtn = ev.target.closest('[data-shelf]');
    if (shelfBtn) {
      // すでに開いている本棚でも、押したら画面は移す
      if (shelfBtn.dataset.shelf !== S.shelf.shelfId) openShelf(shelfBtn.dataset.shelf);
      else showView('home');
      return;
    }

    const kickBtn = ev.target.closest('[data-kick]');
    if (kickBtn) {
      kickMember(kickBtn.dataset.kick, kickBtn.dataset.kickname);
      return;
    }

    const talkBtn = ev.target.closest('[data-talk]');
    if (talkBtn) {
      let ref;
      try { ref = JSON.parse(talkBtn.dataset.talk); } catch (e) { return; }
      talkAbout(ref);
      return;
    }

    const monthBtn = ev.target.closest('[data-month]');
    if (monthBtn) { location.hash = '#/m/' + monthBtn.dataset.month; return; }

    const editBtn = ev.target.closest('[data-edit]');
    if (editBtn) {
      const e = S.entries.find((x) => x.entryId === editBtn.dataset.edit);
      if (e) openEntry(e);
      return;
    }

    const copyBtn = ev.target.closest('[data-copy]');
    if (copyBtn) { copyText($(copyBtn.dataset.copy).textContent); return; }

    const oneBtn = ev.target.closest('[data-share-one]');
    if (oneBtn) {
      let d;
      try { d = JSON.parse(oneBtn.dataset.shareOne); } catch (e) { return; }
      shareText(d.t, `『${d.t}』${d.c ? ' / ' + d.c : ''}\n${d.r}\n\n— 月のしおり`);
      return;
    }

    const allBtn = ev.target.closest('[data-share-rec]');
    if (allBtn) {
      const rec = S.recs.find((r) => r.recId === allBtn.dataset.shareRec);
      if (!rec) return;
      const body = rec.items
        .map((it, i) => `${i + 1}. 『${it.title}』${it.creator ? ' / ' + it.creator : ''}\n   ${it.reason}`)
        .join('\n\n');
      shareText(
        `月のしおり — おすすめ${rec.items.length}件`,
        `おすすめ${rec.items.length}件\n\n${body}\n\n— 月のしおり`
      );
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeAllSheets();
  });
}

/* ============================================================
   Service Worker
   ========================================================== */

/**
 * 保存領域を消さないよう申請する。
 * iOS Safari は7日間使わないと localStorage を消してしまうため、
 * ここで永続化を頼んでおく（許可されるかは端末次第）。
 */
async function askPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    if (await navigator.storage.persisted()) return;
    await navigator.storage.persist();
  } catch (err) { /* 使えない環境では何もしない */ }
}

/** ブラウザのタブで開いているなら、ホーム画面に追加を勧める。 */
function maybeShowInstallHint() {
  if (lsGet(LS.hint) === '1') return;
  // 本棚を開くたびに呼ばれるので、すでに出ていたら何もしない
  if (document.querySelector('.install-hint')) return;

  const standalone = window.matchMedia('(display-mode: standalone)').matches ||
                     window.navigator.standalone === true;
  if (standalone) return;

  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const box = document.createElement('div');
  box.className = 'install-hint';
  box.innerHTML =
    '<p>' + (ios
      ? 'Safariのままだと、7日開かないとログインが切れます。共有ボタンから<b>「ホーム画面に追加」</b>しておくと切れません。'
      : 'ホーム画面に追加しておくと、アプリのように開けてログインも長持ちします。') +
    '</p><button class="close" aria-label="閉じる">×</button>';

  box.querySelector('.close').addEventListener('click', () => {
    lsSet(LS.hint, '1');
    box.remove();
  });

  const anchor = $('readonly-note');
  anchor.parentNode.insertBefore(box, anchor.nextSibling);
}

/**
 * 指でつまんだり2回たたいたりしたときの拡大を止める。
 * iOS Safari は viewport の user-scalable=no を無視するので、
 * ここで実際の操作を受け止める必要がある。
 */
function lockZoom() {
  // 指2本でのつまみ拡大（Safari 独自のイベント）
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  });

  // 2本以上の指で触れたときも拡大させない
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  // 2回たたきによる拡大は CSS の touch-action: manipulation に任せる。
  // ここで touchend を止めると、星の連打などが効かなくなるため。
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // オフライン対応が効かないだけで、アプリ自体は動く
    });
  });
}
