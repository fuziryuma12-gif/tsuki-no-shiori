/* ============================================================
   月のしおり — フロントエンド v2
   メールコードでログインし、セッショントークンで端末を識別する。
   ========================================================== */

'use strict';

const LS = {
  api: 'shiori.apiUrl',
  token: 'shiori.token',
  shelf: 'shiori.lastShelfId',
  pending: 'shiori.pendingJoin'
};

const store = {
  get api() { return localStorage.getItem(LS.api) || ''; },
  set api(v) { localStorage.setItem(LS.api, v); },

  get token() { return localStorage.getItem(LS.token) || ''; },
  set token(v) { v ? localStorage.setItem(LS.token, v) : localStorage.removeItem(LS.token); },

  get lastShelf() { return localStorage.getItem(LS.shelf) || ''; },
  set lastShelf(v) { v ? localStorage.setItem(LS.shelf, v) : localStorage.removeItem(LS.shelf); },

  get pendingJoin() {
    try { return JSON.parse(localStorage.getItem(LS.pending) || 'null'); }
    catch (e) { return null; }
  },
  set pendingJoin(v) {
    v ? localStorage.setItem(LS.pending, JSON.stringify(v))
      : localStorage.removeItem(LS.pending);
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

const $ = (id) => document.getElementById(id);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/* ============================================================
   API
   ========================================================== */

async function api(action, payload) {
  if (!store.api) {
    throw new Error('GAS のウェブアプリ URL がまだ設定されていません。');
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
    throw new Error('サーバーにつながりませんでした。通信環境とURLを確かめてください。');
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error('サーバーの返答を読み取れませんでした。デプロイのアクセス権が「全員」になっているか確かめてください。');
  }

  if (!data.ok) {
    const e = new Error(data.error || '処理できませんでした。');
    e.authFailed = data.code === 'AUTH';
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
async function busy(btn, label, fn) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = was; }
}

/* ============================================================
   起動とルーティング
   ========================================================== */

window.addEventListener('DOMContentLoaded', () => {
  wireUp();
  registerServiceWorker();
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
  const route = parseHash();

  if (!store.api) {
    showGate('email');
    $('in-api').value = '';
    openSheet('sheet-settings');
    toast('最初に GAS のURLを登録してください');
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

  if (!store.token) { showGate('email'); return; }

  try {
    const d = await api('me', { token: store.token });
    S.user = d.user;
    S.shelves = d.shelves;
  } catch (err) {
    store.token = '';
    showGate('email');
    if (!err.authFailed) toast(err.message);
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
      store.lastShelf = d.shelfId;
      toast(d.alreadyMember ? 'すでに参加している本棚です' : `「${d.name}」に参加しました`);
    } catch (err) {
      toast(err.message);
    }
  }

  if (!S.shelves.length) {
    // 本棚がないアカウント（招待に失敗したときなど）。1つ用意する。
    try {
      const d = await authed('createShelf', { name: '' });
      S.shelves = d.shelves;
      store.lastShelf = d.shelfId;
    } catch (err) { toast(err.message); showGate('email'); return; }
  }

  const target = S.shelves.some((s) => s.shelfId === store.lastShelf)
    ? store.lastShelf
    : S.shelves[0].shelfId;

  await openShelf(target);
}

function showGate(step) {
  $('app').classList.add('hidden');
  $('gate').classList.remove('hidden');
  ['email', 'code', 'profile', 'invite'].forEach((s) => {
    $('step-' + s).classList.toggle('hidden', s !== step);
  });
  if (step === 'code') setTimeout(() => $('in-code').focus(), 150);
  if (step === 'email') setTimeout(() => $('in-email').focus(), 150);
  if (step === 'profile') {
    // 招待から来た人は、これから他人の本棚に入るので自分の本棚は要らない
    const joining = !!store.pendingJoin || S.shelves.length > 0;
    $('field-first-shelf').classList.toggle('hidden', joining);
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
  await busy(btn, '送っています…', async () => {
    try {
      await api('requestCode', { email });
      pendingEmail = email;
      $('ui-sent-to').textContent = email;
      $('in-code').value = '';
      showGate('code');
    } catch (err) {
      toast(err.message);
    }
  });
}

async function verifyCode(btn) {
  const code = $('in-code').value.replace(/\D/g, '');
  if (code.length !== 6) { toast('6桁のコードを入力してください'); return; }

  await busy(btn, '確認しています…', async () => {
    try {
      const d = await api('verifyCode', { email: pendingEmail, code });
      store.token = d.token;
      S.user = d.user;
      S.shelves = d.shelves;
      $('in-code').value = '';
      await afterLogin();
    } catch (err) {
      toast(err.message);
    }
  });
}

async function finishProfile(btn) {
  const name = $('in-display-name').value.trim();
  if (!name) { toast('呼び名を入れてください'); $('in-display-name').focus(); return; }

  await busy(btn, '準備しています…', async () => {
    try {
      const p = await authed('setProfile', { displayName: name });
      S.user = p.user;

      if (!S.shelves.length && !store.pendingJoin) {
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
  closeAllSheets();
  location.hash = '';
  showGate('email');
  toast('ログアウトしました');
}

/* ============================================================
   本棚を開く
   ========================================================== */

async function openShelf(shelfId) {
  try {
    const d = await api('getShelf', { shelfId, token: store.token });
    S.canEdit = d.canEdit;
    S.shelf = d.shelf;
    S.members = d.members;
    S.entries = d.entries;
    S.recs = d.recs;
    if (d.me) S.user = d.me;
    if (d.shelves && d.shelves.length) S.shelves = d.shelves;
    if (d.canEdit) store.lastShelf = shelfId;

    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    renderAll();

    const r = parseHash();
    if (r.kind === 'month') renderMonthView(r.month);
    else showView('home');
  } catch (err) {
    toast(err.message);
    if (!store.token) showGate('email');
  }
}

function renderAll() {
  $('ui-shelf-name').textContent = S.shelf.name;
  $('ui-shelf-sub').textContent = S.canEdit
    ? (S.user ? S.user.displayName + 'として記録中' : '')
    : '読むだけのモード';

  $('readonly-note').classList.toggle('hidden', S.canEdit);
  $('btn-add').classList.toggle('hidden', !S.canEdit);
  $('btn-share-open').classList.toggle('hidden', !S.canEdit);
  $('btn-ai-open').classList.toggle('hidden', !S.canEdit);
  $('btn-shelf-switch').disabled = !S.canEdit;

  renderNow();
  renderCounts();
  renderRecent();
  renderMembers();
  renderMonthStrip();
  renderRecs();
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
    ${S.canEdit && mine ? `<button class="row-edit" data-edit="${esc(e.entryId)}">直す</button>` : ''}
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

function renderRecs() {
  const body = $('ui-recs-body');
  if (!S.recs.length) {
    body.innerHTML = `<div class="blank">
      <p>おすすめはまだありません。<br>記録がいくつか集まると、傾向から選べるようになります。</p>
      ${S.canEdit ? '<button class="btn btn-primary" id="btn-recs-empty-go">おすすめを聞く</button>' : ''}
    </div>`;
    const b = $('btn-recs-empty-go');
    if (b) b.addEventListener('click', openAiSheet);
    return;
  }

  body.innerHTML = S.recs.map((r, idx) => {
    const when = r.createdAt ? r.createdAt.slice(0, 10).replace(/-/g, '.') : '';
    const by = r.by ? ' ・ ' + r.by : '';
    return `<div style="margin-bottom:26px">
      <p class="eyebrow">${esc(when + by)}${idx === 0 ? ' ・ 最新' : ''}</p>
      <div class="sug-list">${r.items.map(sugCard).join('')}</div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-paper" data-share-rec="${esc(r.recId)}">この${r.items.length}件をまとめて共有</button>
      </div>
    </div>`;
  }).join('');
}

function sugCard(it) {
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
    <button class="btn btn-line btn-block" style="margin-top:12px"
      data-share-one='${esc(JSON.stringify({ t: it.title, c: it.creator, r: it.reason }))}'>共有する</button>
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
   画面の切り替え
   ========================================================== */

function showView(name) {
  ['home', 'month', 'recs'].forEach((v) => {
    $('view-' + v).classList.toggle('hidden', v !== name);
  });
  $$('.dock button[data-nav]').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.nav === name);
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
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

async function createNewShelf(btn) {
  const name = $('in-new-shelf').value.trim();
  if (!name) { toast('本棚の名前を入れてください'); return; }
  await busy(btn, 'つくっています…', async () => {
    try {
      const d = await authed('createShelf', { name });
      S.shelves = d.shelves;
      closeSheet('sheet-shelves');
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
  $('ui-recs-body').innerHTML =
    '<div class="spinner"></div><p class="wait">これまでのしおりを読み返しています…</p>';

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
    $('ui-recs-body').innerHTML =
      `<div class="blank"><p>${esc(err.message)}</p>
       <button class="btn btn-primary" id="btn-retry-ai">もう一度ためす</button></div>`;
    const b = $('btn-retry-ai');
    if (b) b.addEventListener('click', openAiSheet);
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
   設定
   ========================================================== */

function openSettings() {
  $('in-api').value = store.api;
  const loggedIn = !!(store.token && S.user);
  $('account-box').classList.toggle('hidden', !loggedIn);
  $('btn-logout').classList.toggle('hidden', !loggedIn);
  $('logout-hint').classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    $('ui-my-name').textContent = S.user.displayName || '（未設定）';
    $('ui-my-email').textContent = S.user.email;
    $('in-rename').value = S.user.displayName || '';
  }
  openSheet('sheet-settings');
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
  $('btn-start').addEventListener('click', (ev) => finishProfile(ev.currentTarget));
  $('btn-invite-login').addEventListener('click', () => showGate('email'));
  $('btn-gate-settings').addEventListener('click', openSettings);

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
  $('btn-shelf-switch').addEventListener('click', openShelfSwitcher);
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
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-set-close').addEventListener('click', () => closeSheet('sheet-settings'));
  $('btn-rename-me').addEventListener('click', (ev) => renameMe(ev.currentTarget));
  $('btn-logout').addEventListener('click', logout);
  $('btn-set-save').addEventListener('click', () => {
    const v = $('in-api').value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(v)) {
      toast('/exec で終わるウェブアプリURLを入れてください');
      return;
    }
    const changed = v !== store.api;
    store.api = v;
    closeSheet('sheet-settings');
    toast('保存しました');
    if (changed) boot();
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
    showView(b.dataset.nav);
  });

  $$('.veil').forEach((v) => {
    v.addEventListener('click', (ev) => { if (ev.target === v) v.classList.add('hidden'); });
  });

  /* --- 委譲でまとめて拾うもの --- */
  document.addEventListener('click', (ev) => {
    const shelfBtn = ev.target.closest('[data-shelf]');
    if (shelfBtn) {
      closeSheet('sheet-shelves');
      if (shelfBtn.dataset.shelf !== S.shelf.shelfId) openShelf(shelfBtn.dataset.shelf);
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

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // オフライン対応が効かないだけで、アプリ自体は動く
    });
  });
}
