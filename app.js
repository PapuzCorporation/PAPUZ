/* PAPUZ — клиент */
import * as K from './crypto.js';
import * as M from './media.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  me: null,
  stats: null,
  priv: null,             // CryptoKey (ECDH P-256, extractable)
  chatKeys: new Map(),    // chatId -> CryptoKey
  plain: new Map(),       // messageId -> расшифрованный текст
  preview: new Map(),     // chatId -> текст последнего сообщения
  blobs: new Map(),       // mediaId -> objectURL
  rawBlobs: new Map(),    // mediaId -> Blob (нужен для MediaSource)
  members: new Map(),     // chatId -> участники группы
  chats: [],
  activeId: null,
  peers: new Map(),
  presenceSnapshot: new Map(), // userId -> последний известный статус
  peerSheetId: null,
  peerSheetUser: null,    // профиль участника, открытый из списка группы
  messages: new Map(),
  notify: null,           // привязка Telegram и общие настройки уведомлений
  notifyCode: null,       // выданный одноразовый код, пока бот не привязан
  notifyPoll: null,
  ws: null,
  wsRetry: 0,
  typingTimers: new Map(),
};

/* ------------------------------------------------------------- утилиты */

function toast(text, ms = 2600) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

async function api(path, opts = {}) {
  const { skipAuthRedirect = false, ...rest } = opts;
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: rest.body && !(rest.body instanceof Blob) ? { 'content-type': 'application/json' } : {},
    ...rest,
  });
  if (res.status === 401) {
    state.me = null;
    if (!skipAuthRedirect) showAuth();
    throw new Error('unauthorized');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || 'Ошибка сети');
  return data;
}

const pad = (n) => String(n).padStart(2, '0');
function hhmm(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Сегодня';
  if (same(d, y)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return 'только что';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} мин назад`;
  if (diff < 864e5) return `${Math.floor(diff / 3600e3)} ч назад`;
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
function avatarEl(node, user, sizeClass = 'av-sm') {
  node.innerHTML = '';
  node.className = `av ${sizeClass}`;
  if (user?.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    node.append(img);
  } else {
    const span = document.createElement('span');
    span.className = 'av-fallback';
    span.textContent = (user?.displayName || user?.username || '?').trim()[0] || '?';
    node.append(span);
  }
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || '').join('') || '#';
}

function groupAvatar(node, chat, sizeClass = 'av-md') {
  node.innerHTML = '';
  node.className = `av grp ${sizeClass}`;
  if (chat?.avatar) {
    const img = document.createElement('img');
    img.src = chat.avatar;
    img.alt = '';
    img.loading = 'lazy';
    node.append(img);
  } else {
    const span = document.createElement('span');
    span.className = 'av-fallback';
    span.textContent = initials(chat?.title);
    node.append(span);
  }
}

function peerStatusText(peer) {
  if (!peer) return 'не в сети';
  if (peer.online) return 'в сети';
  return peer.lastSeen ? `был(а) ${relTime(peer.lastSeen)}` : 'не в сети';
}

function applyPresence(peer, data) {
  peer.online = !!data.online;
  if (!data.online) peer.lastSeen = Number(data.lastSeen) || 0;
}

/* снимок presence может прийти раньше, чем загрузятся чаты: запоминаем его */
function rememberPresence(userId, data) {
  if (!Number.isInteger(userId)) return;
  const prev = state.presenceSnapshot.get(userId);
  state.presenceSnapshot.set(userId, {
    online: !!data.online,
    lastSeen: Number(data.lastSeen) || prev?.lastSeen || 0,
  });
}

/* накладываем запомненный presence на уже загруженные чаты */
function applyStoredPresence() {
  for (const [, peer] of state.peers) {
    const s = state.presenceSnapshot.get(peer.id);
    if (s) applyPresence(peer, s);
  }
  const peer = state.peers.get(state.activeId);
  if (peer) {
    setPeerStatus(peer);
    if (!$('#sheet-peer').hidden) setPeerSheetStatus(peer);
  }
  const shown = state.peerSheetUser;
  const s = shown && state.presenceSnapshot.get(shown.id);
  if (s) {
    applyPresence(shown, s);
    setPeerSheetStatus(shown);
  }
}

/* собеседник сменил имя или аватар — обновляем без перезагрузки */
function applyProfile(u) {
  if (!u || !Number.isInteger(u.id)) return;
  let changed = false;
  for (const [, p] of state.peers) {
    if (p.id !== u.id) continue;
    p.displayName = u.displayName;
    p.username = u.username;
    p.bio = u.bio;
    p.avatar = u.avatar;
    changed = true;
  }
  for (const c of state.chats) {
    if (c.type !== 'dm' || c.peer?.id !== u.id) continue;
    c.peer.displayName = u.displayName;
    c.peer.username = u.username;
    c.peer.bio = u.bio;
    c.peer.avatar = u.avatar;
    c.title = u.displayName || u.username;
    changed = true;
  }
  const active = state.chats.find((c) => c.id === state.activeId);
  if (active?.type === 'dm' && active.peer?.id === u.id) {
    avatarEl($('#peer-avatar'), active.peer, 'av-sm');
    $('#peer-name').textContent = active.peer.displayName || active.peer.username;
  }
  const sheetPeer = state.peerSheetId ? state.peers.get(state.peerSheetId) : null;
  if (sheetPeer?.id === u.id) paintPeerSheet(sheetPeer);
  const shown = state.peerSheetUser;
  if (shown && shown.id === u.id) {
    shown.displayName = u.displayName;
    shown.username = u.username;
    shown.bio = u.bio;
    shown.avatar = u.avatar;
    if (!$('#sheet-peer').hidden) paintPeerSheet(shown);
  }
  if (changed) scheduleRenderChats();
}

/* точка присутствия в списке чатов */
function presenceBadge(peer) {
  if (!peer) return null;
  const dot = document.createElement('span');
  dot.className = 'presence-dot ' + (peer.online ? 'on' : 'off');
  dot.title = peer.online ? 'В сети' : (peer.lastSeen ? `Был(а) ${relTime(peer.lastSeen)}` : 'Не в сети');
  dot.setAttribute('aria-label', dot.title);
  return dot;
}

/* --------------------------------------------------------------- темы */

const THEME_KEY = 'papuz-theme';
const THEME_COLORS = {
  dark: '#05080a', black: '#000000', light: '#f2f6f0', copper: '#0e0906',
  neon: '#07050d', ocean: '#040b12', sakura: '#fbf4f7', simple: '#101010',
};
const THEME_NAMES = {
  dark: 'Тёмная', black: 'Глубокий чёрный', light: 'Белая', copper: 'Медь',
  neon: 'Неон', ocean: 'Океан', sakura: 'Сакура', simple: 'Простая',
};
const THEMES = Object.keys(THEME_COLORS);

/* режим снега: включается поверх любой темы */
const SNOW_ENABLED = false;

let snowBuilt = false;
function ensureSnow() {
  if (snowBuilt) return;
  const layer = document.querySelector('.snow');
  if (!layer) return;
  for (let i = 0; i < 32; i++) {
    const near = Math.random() < 0.2;
    const flake = document.createElement('i');
    const dot = document.createElement('b');
    const size = near ? (3.4 + Math.random() * 2.2) : (1.2 + Math.random() * 2.2);
    flake.style.left = (Math.random() * 100).toFixed(2) + '%';
    flake.style.width = size.toFixed(2) + 'px';
    flake.style.height = size.toFixed(2) + 'px';
    flake.style.opacity = (near ? 0.2 + Math.random() * 0.2 : 0.3 + Math.random() * 0.45).toFixed(2);
    flake.style.animationDuration = (near ? 8 + Math.random() * 6 : 12 + Math.random() * 14).toFixed(1) + 's';
    flake.style.animationDelay = (-Math.random() * 24).toFixed(1) + 's';
    flake.style.setProperty('--drift', (Math.random() * 90 - 45).toFixed(0) + 'px');
    dot.style.animationDuration = (2.6 + Math.random() * 3.8).toFixed(1) + 's';
    dot.style.animationDelay = (-Math.random() * 6).toFixed(1) + 's';
    flake.append(dot);
    layer.append(flake);
  }
  snowBuilt = true;
}

function applySnow() {
  document.documentElement.dataset.snow = SNOW_ENABLED ? 'on' : 'off';
  if (SNOW_ENABLED) ensureSnow();
}

function paintTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.dark);
  for (const btn of $$('[data-theme-set]')) {
    const on = btn.dataset.themeSet === theme;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const sub = $('#set-theme-sub');
  if (sub) sub.textContent = THEME_NAMES[theme] || THEME_NAMES.dark;
}

function applyTheme(theme, persist = true) {
  if (!THEMES.includes(theme)) theme = 'dark';
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* приватный режим */ }
  }
  paintTheme(theme);
}

$$('[data-theme-set]').forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.themeSet));
});

/* тема поменялась в другой вкладке — подхватываем без перезагрузки */
window.addEventListener('storage', (e) => {
  if (e.key === THEME_KEY && THEMES.includes(e.newValue)) applyTheme(e.newValue, false);
});

paintTheme(THEMES.includes(document.documentElement.dataset.theme)
  ? document.documentElement.dataset.theme
  : 'dark');
applySnow();

/* --------------------------------------------------------------- ключи */

const STORE = (id) => `papuz.priv.${id}`;

/* Приватный ключ держим в IndexedDB как non-extractable CryptoKey:
   из localStorage его могли забрать любой XSS или расширение. */
const KEY_DB = 'papuz-keys';
const KEY_STORE = 'priv';

function keyDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(KEY_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(KEY_STORE)) req.result.createObjectStore(KEY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB'));
  });
}

async function idbGet(id) {
  const db = await keyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readonly');
    const req = tx.objectStore(KEY_STORE).get(String(id));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('indexedDB'));
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(id, key) {
  const db = await keyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readwrite');
    tx.objectStore(KEY_STORE).put(key, String(id));
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('indexedDB')); };
  });
}

async function importPrivate(bytes, extractable = false) {
  return crypto.subtle.importKey(
    'pkcs8', bytes, { name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveBits']
  );
}

async function savePriv(key) {
  try {
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
    const nonexp = await importPrivate(pkcs8, false);
    await idbPut(state.me.id, nonexp);
    localStorage.removeItem(STORE(state.me.id));
  } catch {
    /* старые браузеры без IndexedDB: остаётся прежний путь */
    try {
      const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
      localStorage.setItem(STORE(state.me.id), btoa(String.fromCharCode(...new Uint8Array(pkcs8))));
    } catch { /* ключ не экспортируется — переживём */ }
  }
}

async function loadPriv(id) {
  try {
    const stored = await idbGet(id);
    if (stored) return stored;
  } catch { /* нет IndexedDB — пробуем localStorage */ }
  const raw = localStorage.getItem(STORE(id));
  if (!raw) return null;
  try {
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const key = await importPrivate(bytes, false);
    /* миграция: стираем сырой pkcs8 из localStorage только после записи в IndexedDB */
    let migrated = false;
    try { await idbPut(id, key); migrated = true; } catch { /* останется прежний путь */ }
    if (migrated) localStorage.removeItem(STORE(id));
    return key;
  } catch {
    return null;
  }
}

async function fingerprint(pubB64) {
  if (!pubB64) return '—';
  const bytes = Uint8Array.from(atob(pubB64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0')).join('')
    .replace(/(.{4})/g, '$1 ').trim();
}

async function getChatKey(chatId) {
  if (state.chatKeys.has(chatId)) return state.chatKeys.get(chatId);
  const peer = state.peers.get(chatId);
  if (!peer?.pubKey || !state.priv) return null;
  try {
    const key = await K.deriveChatKey(state.priv, peer.pubKey, state.me.id, peer.id);
    state.chatKeys.set(chatId, key);
    return key;
  } catch {
    return null;
  }
}

/* ключ кэша расшифровки — чат + сообщение, чтобы тексты не переезжали между чатами */
function plainKey(chatId, id) {
  return `${chatId}:${id}`;
}

async function plainOf(chatId, m) {
  if (!K.isEncrypted(m.body)) return m.body;
  const cacheKey = plainKey(chatId, m.id);
  if (state.plain.has(cacheKey)) return state.plain.get(cacheKey);
  const chatKey = await getChatKey(chatId);
  let text;
  if (!chatKey) text = '🔒 нет ключа для этого чата';
  else {
    const t = await K.decryptText(chatKey, m.body);
    text = t === null ? '🔒 не удалось расшифровать' : t;
  }
  state.plain.set(cacheKey, text);
  return text;
}

/* ---------------------------------------------------------------- вход */

let authMode = 'login';

function hideBoot() {
  $('#boot')?.remove();
}

function showAuth() {
  hideBoot();
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#auth-form').reset();
  $('#auth-error').classList.remove('show');
  if (state.ws) { state.ws.close(); state.ws = null; }
}

function showApp() {
  hideBoot();
  $('#auth').hidden = true;
  $('#app').hidden = false;
  avatarEl($('#me-avatar'), state.me, 'av-sm');
  $('#me-online').classList.add('on');
  fillProfile();
  refreshStats().then(fillProfile);
  loadNotifications();
  loadChats();
  connectWs();
}

$$('.tab').forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));

function setAuthMode(mode) {
  authMode = mode;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.mode === mode));
  $('.tabs').dataset.mode = mode;
  $('.field-pass2').hidden = mode !== 'register';
  $('#auth-submit span').textContent = mode === 'register' ? 'Создать аккаунт' : 'Войти';
  $('#f-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#auth-hint').textContent = mode === 'register'
    ? 'Пароль от 8 символов. Из него выводится ключ шифрования — потеряешь пароль, потеряешь историю.'
    : 'С возвращением. Пароль расшифрует твои ключи на этом устройстве.';
  $('#auth-error').classList.remove('show');
}

$('#f-eye').addEventListener('click', () => {
  const inp = $('#f-password');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#auth-submit');
  const err = $('#auth-error');
  err.classList.remove('show');
  btn.disabled = true;
  const label = btn.firstElementChild;
  const restore = authMode === 'register' ? 'Создать аккаунт' : 'Войти';
  if (!window.isSecureContext || !crypto?.subtle) {
    err.textContent = 'Шифрование работает только по защищённому адресу. Открой https://papuz.ru';
    err.classList.add('show');
    btn.disabled = false;
    return;
  }
  label.textContent = authMode === 'register' ? 'Создаю ключи…' : 'Открываю ключи…';

  const password = $('#f-password').value;
  try {
    if (authMode === 'register') {
      if ($('#f-password2').value !== password) {
        err.textContent = 'Пароли не совпадают';
        err.classList.add('show');
        return;
      }
      const pair = await K.createIdentity();
      const wrapped = await K.wrapIdentity(pair, password);
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          username: $('#f-username').value,
          password,
          website: $('#f-website').value,
          ...wrapped,
        }),
      });
      state.me = data.user;
      state.priv = pair.privateKey;
      await savePriv(pair.privateKey);
    } else {
      const data = await api('/api/login', {
        method: 'POST',
        skipAuthRedirect: true,
        body: JSON.stringify({ username: $('#f-username').value, password }),
      });
      state.me = data.user;
      if (data.keys) {
        state.priv = await K.unwrapIdentity(data.keys.encPriv, data.keys.kdfSalt, data.keys.kdfIter, password);
        await savePriv(state.priv);
      } else {
        // аккаунт из ранней версии — создаём ключи
        const pair = await K.createIdentity();
        const wrapped = await K.wrapIdentity(pair, password);
        await api('/api/me/keys', { method: 'POST', body: JSON.stringify(wrapped) });
        state.me.pubKey = wrapped.pubKey;
        state.priv = pair.privateKey;
        await savePriv(pair.privateKey);
      }
    }
    showApp();
  } catch (e2) {
    err.textContent = e2.message === 'unauthorized'
      ? 'Неверный ник или пароль'
      : (e2.name === 'OperationError' || /decrypt/i.test(e2.message)
          ? 'Пароль не подошёл к ключам шифрования'
          : e2.message);
    err.classList.add('show');
    $('.auth-card').animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(7px)' }, { transform: 'translateX(0)' }],
      { duration: 300, easing: 'ease-in-out' }
    );
  } finally {
    btn.disabled = false;
    label.textContent = restore;
  }
});

/* --------------------------------------------------------------- чаты */

async function loadChats() {
  const { chats } = await api('/api/chats');
  /* каналы, открытые для просмотра без подписки, не теряем при обновлении списка */
  const previews = state.chats.filter((c) => c.preview);
  state.chats = chats;
  for (const p of previews) {
    if (!chats.some((c) => c.id === p.id)) state.chats.unshift(p);
  }
  for (const c of chats) if (c.peer) state.peers.set(c.id, c.peer);
  /* API мог ответить раньше, чем presence: возвращаем свежий статус */
  applyStoredPresence();
  scheduleRenderChats();
  decryptPreviews();
  refreshActiveHeader();
}

function refreshActiveHeader() {
  const id = state.activeId;
  if (!id) return;
  const chat = state.chats.find((c) => c.id === id);
  if (!chat) {
    $('.shell').classList.remove('chat-open');
    state.activeId = null;
    $('#chat-body').hidden = true;
    $('#chat-empty').hidden = false;
    scheduleRenderChats();
    return;
  }
  syncChatNotify();
  if (chat.type === 'dm') {
    const peer = state.peers.get(chat.id) || chat.peer;
    if (peer) {
      avatarEl($('#peer-avatar'), peer, 'av-sm');
      $('#peer-name').textContent = peer.displayName || peer.username;
      setPeerStatus(peer);
    }
    applyComposerMode(chat);
    return;
  }
  $('#peer-name').textContent = chat.title;
  groupAvatar($('#peer-avatar'), chat, 'av-sm');
  updateGroupStatus(chat);
  applyComposerMode(chat);
}

const MEDIA_LABEL = { photo: 'Фото', video: 'Видео', voice: 'Голосовое', circle: 'Кружок', file: 'Файл' };

/* авторство всегда считаем по senderId — не доверяем полю mine из ответа или сокета */
function normalizeMessage(m) {
  if (m && state.me && Number.isInteger(m.senderId)) m.mine = m.senderId === state.me.id;
  return m;
}

function isMine(m) {
  return !!(state.me && m && m.senderId === state.me.id);
}

/* @упоминания: ник человека или канала становится кликабельным */
const MENTION_RE = /(^|[^\w@])@([a-z0-9_]{3,20})(?![a-z0-9_])/gi;

function fillMentions(node, text) {
  node.textContent = '';
  if (!text) return;
  let last = 0;
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text))) {
    const start = m.index + m[1].length;
    if (start > last) node.append(document.createTextNode(text.slice(last, start)));
    const name = m[2].toLowerCase();
    const ref = document.createElement('span');
    ref.className = 'mention';
    ref.dataset.username = name;
    ref.textContent = '@' + m[2];
    node.append(ref);
    last = start + 1 + m[2].length;
  }
  if (last < text.length) node.append(document.createTextNode(text.slice(last)));
}

/* служебные сообщения о составе — в каналах их не показываем */
function isChannelMemberNotice(m) {
  if (m?.kind !== 'system') return false;
  const body = m.body || '';
  return /(^|\s)добавил(а)?(\s|$)/.test(body)
    || body.endsWith(' больше не в чате')
    || body.endsWith(' из чата');
}

/* слить пачку сообщений с кэшем по id: ничего не теряем и не дублируем */
function mergeMessages(chatId, incoming) {
  const byId = new Map();
  for (const m of incoming) byId.set(m.id, normalizeMessage(m));
  for (const m of state.messages.get(chatId) || []) {
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

async function decryptPreviews() {
  const label = MEDIA_LABEL;
  let changed = false;
  for (const c of state.chats) {
    if (!c.lastMessage || state.preview.has(c.id)) continue;
    if (c.lastMessage.media) {
      state.preview.set(c.id, label[c.lastMessage.media] || 'Вложение');
      changed = true;
      continue;
    }
    if (!c.lastMessage.body) continue;
    const text = await plainOf(c.id, { id: `p${c.id}-${c.lastMessage.id}`, body: c.lastMessage.body });
    state.preview.set(c.id, text);
    changed = true;
  }
  if (changed) scheduleRenderChats();
}

let chatsFrame = 0;

/* presence и профили приходят пачкой — рисуем не чаще одного раза за кадр */
function scheduleRenderChats() {
  if (chatsFrame) return;
  chatsFrame = requestAnimationFrame(() => {
    chatsFrame = 0;
    renderChats();
  });
}

function makeChatItem(c) {
  const btn = document.createElement('button');
  btn.className = 'chat-item is-new';
  btn.dataset.chat = String(c.id);

  const avWrap = document.createElement('span');
  avWrap.className = 'chat-av';
  const av = document.createElement('span');
  avWrap.append(av);

  const body = document.createElement('div');
  body.className = 'chat-item-body';

  const top = document.createElement('div');
  top.className = 'chat-item-top';
  const name = document.createElement('span');
  name.className = 'chat-item-name';
  const time = document.createElement('span');
  time.className = 'chat-item-time';
  top.append(name, time);

  const last = document.createElement('div');
  last.className = 'chat-item-last';
  body.append(top, last);
  btn.append(avWrap, body);

  btn._ui = { av, avWrap, name, time, last, badge: null, avKey: '' };
  btn.addEventListener('click', () => openChat(c.id));
  return btn;
}

function paintChatPresence(avWrap, peer) {
  let badge = avWrap.querySelector('.presence-dot');
  if (!peer) { badge?.remove(); return; }
  if (!badge) {
    badge = presenceBadge(peer);
    if (badge) avWrap.append(badge);
    return;
  }
  badge.classList.toggle('on', !!peer.online);
  badge.classList.toggle('off', !peer.online);
  badge.title = peer.online ? 'В сети' : (peer.lastSeen ? `Был(а) ${relTime(peer.lastSeen)}` : 'Не в сети');
  badge.setAttribute('aria-label', badge.title);
}

function paintChatLast(last, c, dmPeer) {
  last.textContent = '';
  last.style.color = '';
  if (!c.lastMessage) {
    const tag = c.type === 'group' ? `${c.members} участн.` : c.type === 'channel' ? `${c.members} подписч.` : (dmPeer?.online ? 'в сети' : 'нет сообщений');
    last.textContent = tag;
    last.style.color = c.type === 'dm' && dmPeer?.online ? 'var(--mint)' : '';
    return;
  }
  if (c.lastMessage.kind === 'system') {
    if (c.type === 'channel' && isChannelMemberNotice(c.lastMessage)) {
      last.textContent = `${c.members} ${plural(c.members, 'подписчик', 'подписчика', 'подписчиков')}`;
    } else {
      last.textContent = c.lastMessage.body;
    }
    return;
  }
  let who = '';
  if (c.type !== 'channel') {
    if (c.lastMessage.mine) who = 'ты: ';
    else if (c.type === 'group') who = `${c.lastMessage.senderName}: `;
  }
  const t = document.createElement('span');
  const cached = state.preview.get(c.id);
  t.textContent = cached || (c.lastMessage.media ? 'Вложение' : 'зашифрованное сообщение');
  if (who) {
    const p = document.createElement('b');
    p.textContent = who;
    last.append(p, t);
  } else {
    last.append(t);
  }
}

function paintChatItem(btn, c, i, dmPeer) {
  const ui = btn._ui;
  btn.classList.toggle('is-active', c.id === state.activeId);
  btn.style.setProperty('--i', String(i));

  const avKey = c.type === 'dm'
    ? `d|${dmPeer?.avatar || ''}|${dmPeer?.displayName || dmPeer?.username || c.title || ''}`
    : `g|${c.avatar || ''}|${c.title || ''}`;
  if (ui.avKey !== avKey) {
    ui.avKey = avKey;
    if (c.type === 'dm') avatarEl(ui.av, dmPeer || { displayName: c.title }, 'av-md');
    else groupAvatar(ui.av, c, 'av-md');
  }
  paintChatPresence(ui.avWrap, c.type === 'dm' ? dmPeer : null);

  ui.name.textContent = c.type === 'dm' ? (dmPeer?.displayName || c.title || 'Чат') : c.title;
  ui.time.textContent = c.lastMessage ? hhmm(c.lastMessage.at) : '';
  paintChatLast(ui.last, c, dmPeer);

  const unread = Number(c.unread) || 0;
  if (unread > 0) {
    if (!ui.badge) {
      ui.badge = document.createElement('span');
      ui.badge.className = 'badge';
      btn.append(ui.badge);
    }
    ui.badge.textContent = unread > 99 ? '99+' : unread;
  } else if (ui.badge) {
    ui.badge.remove();
    ui.badge = null;
  }
}

function renderChats() {
  const list = $('#chat-list');
  if (!list) return;
  /* предпросмотр канала без подписки в списке чатов не показываем */
  const visible = state.chats.filter((c) => !c.preview);

  if (!visible.length) {
    const empty = list.querySelector('#empty-list') || buildEmpty();
    if (list.childElementCount !== 1 || list.firstElementChild !== empty) {
      list.replaceChildren(empty);
    }
    return;
  }

  const known = new Map();
  for (const el of list.children) {
    if (el.dataset.chat) known.set(el.dataset.chat, el);
  }

  const nodes = visible.map((c, i) => {
    const key = String(c.id);
    let btn = known.get(key);
    if (!btn) btn = makeChatItem(c);
    known.delete(key);
    paintChatItem(btn, c, i, c.type === 'dm' ? (state.peers.get(c.id) || c.peer) : null);
    return btn;
  });

  /* список тот же — не дёргаем DOM зря */
  const same = list.childElementCount === nodes.length
    && nodes.every((node, i) => list.children[i] === node);
  if (same) return;

  const scrollTop = list.scrollTop;
  let next = list.firstElementChild;
  for (const node of nodes) {
    if (node === next) { next = next.nextElementSibling; continue; }
    list.insertBefore(node, next);
  }
  while (next) {
    const after = next.nextElementSibling;
    next.remove();
    next = after;
  }
  if (list.scrollTop !== scrollTop) list.scrollTop = scrollTop;
}

$('#chat-list').addEventListener('animationend', (e) => {
  if (e.animationName === 'itemIn') e.target.classList.remove('is-new');
});

/* короткое появление списка — только когда возвращаемся из чата или настроек */
function replayChatsIntro() {
  const list = $('#chat-list');
  const items = list ? [...list.querySelectorAll('.chat-item')] : [];
  if (!items.length) return;
  items.forEach((el, i) => {
    el.classList.remove('is-new');
    el.style.setProperty('--i', String(i));
  });
  void list.offsetWidth;
  items.forEach((el) => el.classList.add('is-new'));
}

function buildEmpty() {
  const d = document.createElement('div');
  d.className = 'empty-list';
  d.id = 'empty-list';
  d.innerHTML = '<div class="empty-glyph">◍</div><p class="empty-title">Пока тихо</p><p class="empty-text">Найди человека по нику — и начните первое «привет».</p>';
  return d;
}

/* --------------------------------------------------------------- чат */

/* нижняя часть чата: обычный ввод, запрет писать в канале или подписка */
function applyComposerMode(chat) {
  if (!chat) return;
  const preview = !!chat.preview;
  const channelMember = chat.type === 'channel' && chat.role === 'member';
  const readOnly = preview || channelMember;
  $('#composer').hidden = preview;
  $('#ch-sub').hidden = !preview;
  $('#msg-input').disabled = readOnly;
  $('#btn-attach').hidden = readOnly;
  $('#btn-peer').hidden = preview;
  $('#btn-chat-more').hidden = preview;
  if (preview) $('#msg-input').placeholder = 'Вы не подписаны на канал';
  else if (channelMember) $('#msg-input').placeholder = 'В канале пишут только админы';
  else $('#msg-input').placeholder = 'Сообщение…';
}

async function openChat(chatId) {
  state.activeId = chatId;
  closeChatMore();
  const chat = state.chats.find((c) => c.id === chatId);
  const peer = state.peers.get(chatId) || chat?.peer || null;
  const isGroup = chat && chat.type !== 'dm';

  $('#chat-empty').hidden = true;
  $('#chat-body').hidden = false;
  $('.shell').classList.add('chat-open');
  /* при переходе в другой чат старый «печатает…» не должен висеть */
  clearTimeout(state.typingTimers.get('show'));
  $('#typing').classList.remove('on');
  $('#typing').hidden = true;

  if (isGroup) {
    groupAvatar($('#peer-avatar'), chat, 'av-sm');
    $('#peer-name').textContent = chat.title;
    $('#chat-lock').style.display = 'none';
    updateGroupStatus(chat);
    if (!chat.preview) loadMembers(chatId).catch(() => {});
  } else if (peer) {
    avatarEl($('#peer-avatar'), peer, 'av-sm');
    $('#peer-name').textContent = peer.displayName || peer.username;
    setPeerStatus(peer);
    $('#chat-lock').style.display = '';
    $('#chat-lock').classList.toggle('off', !peer.pubKey);
    $('#chat-lock').title = peer.pubKey ? 'Сквозное шифрование включено' : 'У собеседника нет ключей';
  }
  applyComposerMode(chat);
  syncChatNotify();

  scheduleRenderChats();

  if (!state.messages.has(chatId)) {
    const { messages } = await api(`/api/chats/${chatId}/messages`);
    state.messages.set(chatId, mergeMessages(chatId, messages));
  }
  /* пока грузили, могли открыть другой чат — старое сообщение сюда не рисуем */
  if (state.activeId !== chatId) return;
  await renderMessages(chatId);
  if (state.activeId === chatId && !chat?.preview) markRead(chatId);
}

function updateGroupStatus(chat) {
  const el = $('#peer-status');
  el.classList.remove('on');
  const subs = chat.type === 'channel'
    ? `${chat.members} ${plural(chat.members, 'подписчик', 'подписчика', 'подписчиков')}`
    : `${chat.members} ${plural(chat.members, 'участник', 'участника', 'участников')}`;
  const canEdit = chat.role === 'owner' || chat.role === 'admin';
  if (chat.type === 'channel' && chat.username) el.textContent = `@${chat.username} · ${subs}`;
  else if (chat.type === 'channel' && canEdit) el.textContent = `${subs} · задать юзернейм`;
  else el.textContent = subs;
}

async function loadMembers(chatId) {
  const { chat, members } = await api(`/api/chats/${chatId}/info`);
  state.members.set(chatId, members);
  const local = state.chats.find((c) => c.id === chatId);
  if (local) Object.assign(local, chat);
  if (state.activeId === chatId) updateGroupStatus(chat);
  return { chat, members };
}

function setPeerStatus(peer) {
  const el = $('#peer-status');
  el.textContent = peerStatusText(peer);
  el.classList.toggle('on', !!peer.online);
}

function setPeerSheetStatus(peer) {
  const el = $('#p-status');
  if (!el) return;
  el.textContent = peerStatusText(peer);
  const pill = el.closest('.status-pill');
  if (!pill) return;
  pill.classList.toggle('off', !peer.online);
}

/* --------------------------------------------------------- медиа в чате */

const lazyIO = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    lazyIO.unobserve(en.target);
    en.target.__load?.();
  }
}, { root: null, rootMargin: '500px 0px' });

async function mediaBlob(chatId, media) {
  const res = await fetch(`/api/media/${media.id}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Файл недоступен');
  let blob = await res.blob();
  if (media.enc) {
    const key = await getChatKey(chatId);
    if (!key) throw new Error('Нет ключа шифрования');
    blob = await M.decryptBlob(key, blob, media.mime);
  } else if (blob.type !== media.mime) {
    blob = new Blob([blob], { type: media.mime });
  }
  return blob;
}

async function mediaURL(chatId, media) {
  if (state.blobs.has(media.id)) return state.blobs.get(media.id);
  const blob = await mediaBlob(chatId, media);
  state.rawBlobs.set(media.id, blob);
  const url = URL.createObjectURL(blob);
  state.blobs.set(media.id, url);
  return url;
}

/* Firefox пишет webm с «неизвестным» размером сегмента — Chrome такой файл
   напрямую не проигрывает (ошибка сети на первой секунде). Если родной плеер
   не справился, перезагружаем тот же файл через MediaSource: он читает такой
   контейнер нормально и заодно знает длительность. */
function mseType(blob) {
  const t = blob?.type || '';
  if (!/webm/i.test(t)) return '';
  return /video/i.test(t) ? 'video/webm; codecs="vp8, opus"' : 'audio/webm; codecs="opus"';
}

async function playThroughMse(el, blob, type) {
  if (!window.MediaSource || !MediaSource.isTypeSupported(type)) return false;
  try {
    const ms = new MediaSource();
    el.src = URL.createObjectURL(ms);
    await new Promise((resolve, reject) => {
      ms.addEventListener('sourceopen', resolve, { once: true });
      setTimeout(() => reject(new Error('sourceopen')), 5000);
    });
    const sb = ms.addSourceBuffer(type);
    const data = await blob.arrayBuffer();
    await new Promise((resolve, reject) => {
      sb.addEventListener('updateend', resolve, { once: true });
      sb.addEventListener('error', () => reject(new Error('append')), { once: true });
      try { sb.appendBuffer(data); } catch (err) { reject(err); }
    });
    if (ms.readyState === 'open') ms.endOfStream();
    return true;
  } catch {
    return false;
  }
}

async function attachMedia(el, chatId, media, { autoplay = false } = {}) {
  const url = await mediaURL(chatId, media);
  const blob = state.rawBlobs.get(media.id);
  el.__mse = false;
  el.src = url;
  if (autoplay) el.play().catch(() => {});
  const type = mseType(blob);
  if (!type) return;
  const onError = async () => {
    el.removeEventListener('error', onError);
    if (el.__mse) return;
    el.__mse = true;
    const at = el.currentTime;
    if (!(await playThroughMse(el, blob, type))) return;
    try { if (at > 0.1) el.currentTime = at; } catch { /* поток ещё не готов */ }
    el.play().catch(() => {});
    if (el === player.audio) syncPlayer();
  };
  el.addEventListener('error', onError);
}

function mediaPlaceholder(text, cls = 'media-file') {
  const row = document.createElement('div');
  row.className = cls;
  const ico = document.createElement('div');
  ico.className = cls === 'media-file' ? 'f-ico' : 'ph';
  if (cls === 'media-file') ico.textContent = '!';
  const body = document.createElement('div');
  body.className = cls === 'media-file' ? 'f-body' : '';
  const name = document.createElement('div');
  name.className = cls === 'media-file' ? 'f-name' : 'a-time';
  name.textContent = text;
  body.append(name);
  row.append(ico, body);
  return row;
}

/* ------------------------------------------------------------ иконки */

const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  play: { fill: ['M6.8 5.4c0-1.1 1.2-1.7 2.1-1.1l8.3 6.6c.7.6.7 1.6 0 2.2l-8.3 6.6c-.9.7-2.1 0-2.1-1.1V5.4Z'] },
  pause: { fill: ['M8.2 4.6h2.9c.5 0 .9.4.9.9v13c0 .5-.4.9-.9.9H8.2a.9.9 0 0 1-.9-.9v-13c0-.5.4-.9.9-.9Zm5.7 0h2.9c.5 0 .9.4.9.9v13c0 .5-.4.9-.9.9h-2.9a.9.9 0 0 1-.9-.9v-13c0-.5.4-.9.9-.9Z'] },
  send: { stroke: ['M19.6 4.4 13.2 22.8 9.5 14.5 1.2 10.8Z', 'M19.6 4.4 9.5 14.5'] },
  mic: { fill: ['M12 3.2a2.95 2.95 0 0 0-2.95 2.95v5.6a2.95 2.95 0 0 0 5.9 0v-5.6A2.95 2.95 0 0 0 12 3.2Z'], stroke: ['M6.2 11.4a5.8 5.8 0 0 0 11.6 0', 'M12 17.2v3.3', 'M8.9 20.5h6.2'] },
  attach: { stroke: ['M16.6 7.6 9.2 15a3.3 3.3 0 0 0 4.6 4.6l6.3-6.3a5.4 5.4 0 0 0-7.7-7.6L6 12.1'] },
  photo: { stroke: ['M5.6 4.4h12.8a1.8 1.8 0 0 1 1.8 1.8v11.6a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8V6.2a1.8 1.8 0 0 1 1.8-1.8Z', 'M3.9 16.4 8.7 11.6l3.4 3.4 2.4-2.4 4.8 4.8', 'M15.4 8.6h.01'] },
  video: { stroke: ['M3.6 8.4A2.4 2.4 0 0 1 6 6h7a2.4 2.4 0 0 1 2.4 2.4v7.2A2.4 2.4 0 0 1 13 18H6a2.4 2.4 0 0 1-2.4-2.4Z', 'M15.4 11l4.2-2.5c.6-.3 1.4 0 1.4.8v5.4c0 .8-.8 1.1-1.4.8L15.4 13Z'] },
  file: { stroke: ['M7.2 3.6h6l4.2 4.2V20a.8.8 0 0 1-.8.8H7.2a.8.8 0 0 1-.8-.8V4.4a.8.8 0 0 1 .8-.8Z', 'M13.2 3.6v4.6h4.4'] },
  circle: { stroke: ['M12 3.7a8.3 8.3 0 1 0 0 16.6 8.3 8.3 0 0 0 0-16.6Z', 'M10.2 9.4v5.2l4.3-2.6Z'] },
  trash: { stroke: ['M5.4 7.2h13.2', 'M9.7 7.2V5.5a1.3 1.3 0 0 1 1.3-1.3h2a1.3 1.3 0 0 1 1.3 1.3v1.7', 'M7 7.2l.8 11.4a1.3 1.3 0 0 0 1.3 1.2h5.8a1.3 1.3 0 0 0 1.3-1.2L17 7.2', 'M10.4 10.7v5.6M13.6 10.7v5.6'] },
  close: { stroke: ['M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6'] },
  flip: { stroke: ['M4.4 9.8A7.9 7.9 0 0 1 18.4 8', 'M19.6 14.2A7.9 7.9 0 0 1 5.6 16', 'M4.4 5.6v4.2h4.2', 'M19.6 18.4v-4.2h-4.2'] },
  dots: { stroke: ['M12 6.1h.01', 'M12 12h.01', 'M12 17.9h.01'], wide: true },
  note: { stroke: ['M9.3 17.2V7l7.4-1.5v9.9', 'M9.3 17.2a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0Z', 'M16.7 15.4a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0Z'] },
  download: { stroke: ['M12 4v10m0 0 3.6-3.6M12 14l-3.6-3.6M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16'] },
  expand: { stroke: ['M4.5 9.5v-4a1 1 0 0 1 1-1h4M19.5 9.5v-4a1 1 0 0 0-1-1h-4M4.5 14.5v4a1 1 0 0 0 1 1h4M19.5 14.5v4a1 1 0 0 1-1 1h-4'] },
  sound: { stroke: ['M4.5 10v4h2.8l3.9 3.2V6.8L7.3 10H4.5Z', 'M15.7 8.8a4.4 4.4 0 0 1 0 6.4'] },
  mute: { stroke: ['M4.5 10v4h2.8l3.9 3.2V6.8L7.3 10H4.5Z', 'M15.5 10l4 4m0-4-4 4'] },
  check: { stroke: ['M4 12.6 8 16.6 15.4 7.4'] },
  checks: { stroke: ['M3.2 12.6 7.2 16.6 14.6 7.4', 'M11 12.6l4 4L22.4 7.4'] },
};

function icon(name, cls = '') {
  const spec = ICONS[name] || { stroke: [] };
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `ico${cls ? ' ' + cls : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  for (const d of spec.fill || []) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'currentColor');
    svg.append(p);
  }
  for (const d of spec.stroke || []) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', name === 'checks' ? '1.9' : spec.wide ? '2.6' : '1.7');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  }
  return svg;
}

function setIcon(btn, name) {
  btn.replaceChildren(icon(name));
}

function setBusy(btn) {
  btn.replaceChildren();
  btn.classList.add('busy');
}

/* --------------------------------------------------------- изображения */

function imageNode(chatId, media, onOpen, grid = false) {
  const box = document.createElement('div');
  box.className = 'media-img';
  if (grid && media.width && media.height) box.style.aspectRatio = '1 / 1';
  const ph = document.createElement('div');
  ph.className = 'ph';
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('load', () => { ph.remove(); img.classList.add('on'); });
  box.append(ph, img);
  box.__load = async () => {
    try {
      img.src = await mediaURL(chatId, media);
    } catch {
      ph.remove();
      box.append(mediaPlaceholder('Фото не открылось'));
    }
  };
  lazyIO.observe(box);
  box.addEventListener('click', () => onOpen?.(chatId, media));
  return box;
}

/* ------------------------------------------------------------- видео */

function videoNode(chatId, media) {
  const box = document.createElement('div');
  box.className = 'media-video';
  box.style.aspectRatio = media.width && media.height
    ? `${Math.min(media.width / media.height, 1.9)}`
    : '16 / 9';

  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.setAttribute('playsinline', '');

  const big = document.createElement('button');
  big.type = 'button';
  big.className = 'v-big';
  big.setAttribute('aria-label', 'Смотреть');
  big.append(icon('play'));

  const ctl = document.createElement('div');
  ctl.className = 'v-ctl';
  const track = document.createElement('div');
  track.className = 'v-track';
  const fill = document.createElement('i');
  track.append(fill);
  const time = document.createElement('span');
  time.className = 'v-time';
  time.textContent = M.clock(media.duration || 0);
  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'v-btn';
  mute.setAttribute('aria-label', 'Звук');
  mute.append(icon('sound'));
  const full = document.createElement('button');
  full.type = 'button';
  full.className = 'v-btn';
  full.setAttribute('aria-label', 'Во весь экран');
  full.append(icon('expand'));
  ctl.append(track, time, mute, full);

  box.append(v, big, ctl);

  /* первый кадр в постер — иначе Chrome рисует в углу свой значок «видео» */
  let posterDone = false;
  const grabPoster = () => {
    if (posterDone || !v.videoWidth) return;
    posterDone = true;
    try {
      const w = Math.min(720, v.videoWidth);
      const h = Math.round((w * v.videoHeight) / v.videoWidth);
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      cv.getContext('2d').drawImage(v, 0, 0, w, h);
      v.setAttribute('poster', cv.toDataURL('image/jpeg', 0.72));
    } catch { /* ignore */ }
  };
  v.addEventListener('loadeddata', () => { box.classList.add('ready'); grabPoster(); });
  v.addEventListener('seeked', grabPoster);
  v.addEventListener('error', () => {
    box.replaceWith(mediaPlaceholder('Видео не открылось'));
  });

  let ready = false;
  const sync = () => {
    const d = v.duration || media.duration || 0;
    const p = d ? Math.min(1, v.currentTime / d) : 0;
    fill.style.width = `${p * 100}%`;
    time.textContent = v.currentTime > 0.05
      ? `${M.clock(v.currentTime)} / ${M.clock(d)}`
      : M.clock(d);
    box.classList.toggle('playing', !v.paused);
    if (v.paused) setIcon(big, 'play'); else setIcon(big, 'pause');
  };

  const toggle = () => {
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  big.addEventListener('click', toggle);
  v.addEventListener('click', toggle);
  v.addEventListener('play', sync);
  v.addEventListener('pause', sync);
  v.addEventListener('timeupdate', sync);
  v.addEventListener('loadedmetadata', () => {
    ready = true;
    sync();
    try { v.currentTime = Math.min(0.04, (v.duration || 1) / 2); } catch { /* ignore */ }
  });
  v.addEventListener('ended', () => { v.currentTime = 0; sync(); });

  track.addEventListener('click', (e) => {
    e.stopPropagation();
    const d = v.duration || media.duration || 0;
    if (!d) return;
    const r = track.getBoundingClientRect();
    v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
  });
  mute.addEventListener('click', (e) => {
    e.stopPropagation();
    v.muted = !v.muted;
    setIcon(mute, v.muted ? 'mute' : 'sound');
  });
  full.addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen?.();
    else box.requestFullscreen?.().catch(() => {});
  });

  box.__load = async () => {
    try {
      v.src = media.enc ? await mediaURL(chatId, media) : `/api/media/${media.id}`;
      v.load();
    } catch {
      box.replaceWith(mediaPlaceholder('Видео не открылось'));
    }
  };
  lazyIO.observe(box);
  sync();
  return box;
}

/* ------------------------------------------------------------- плеер */

const player = { audio: null, item: null, circle: null, hooks: null, seq: 0 };

function audioEl() {
  if (player.audio) return player.audio;
  const a = new Audio();
  a.preload = 'auto';
  a.addEventListener('timeupdate', () => syncPlayer());
  a.addEventListener('durationchange', () => syncPlayer());
  a.addEventListener('play', () => syncPlayer());
  a.addEventListener('pause', () => syncPlayer());
  a.addEventListener('ended', () => { if (!player.circle) stopPlayer(); });
  player.audio = a;
  return a;
}

function knownDur(media) {
  const d = Number(media?.duration);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function playerTime() {
  if (player.circle) {
    const v = player.circle.v;
    const own = Number(v.duration);
    return {
      time: v.currentTime,
      dur: Number.isFinite(own) && own > 0 ? own : knownDur(player.circle.media),
      paused: v.paused,
    };
  }
  if (player.item && player.audio) {
    const a = player.audio;
    const own = Number(a.duration);
    return {
      time: a.currentTime,
      dur: Number.isFinite(own) && own > 0 ? own : knownDur(player.item.media),
      paused: a.paused,
    };
  }
  return null;
}

function syncPlayer() {
  const st = playerTime();
  if (!st) return;
  $('#p-fill').style.width = st.dur ? `${Math.min(100, (st.time / st.dur) * 100)}%` : '0%';
  setIcon($('#p-toggle'), st.paused ? 'play' : 'pause');
  player.hooks?.tick?.(st);
  if (!$('#aud').hidden) syncSheet(st);
}

function toggleCurrent() {
  if (player.circle) {
    const v = player.circle.v;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    return;
  }
  if (!player.item) return;
  const a = audioEl();
  if (a.paused) a.play().catch(() => {});
  else a.pause();
}

function stopPlayer() {
  const hooks = player.hooks;
  const c = player.circle;
  if (c) {
    c.v.pause();
    try { c.v.currentTime = 0; } catch { /* ignore */ }
    c.v.muted = true;
    c.v.loop = true;
    c.box.classList.remove('full', 'playing', 'paused');
    c.prog?.setAttribute('stroke-dashoffset', '305.4');
    player.circle = null;
    c.v.play().catch(() => {});
  }
  player.audio?.pause();
  player.item = null;
  player.hooks = null;
  $('#player').hidden = true;
  closeSheet();
  hooks?.reset?.();
}

async function playAudio({ chatId, media, title, sub, message, hooks }) {
  const key = `${chatId}:${media.id}`;
  const a = audioEl();
  if (player.item?.key === key) {
    if (a.paused) a.play().catch(() => {});
    else a.pause();
    return;
  }
  stopPlayer();
  const token = ++player.seq;
  try {
    await attachMedia(a, chatId, media);
  } catch {
    hooks?.reset?.();
    return toast('Не удалось включить');
  }
  if (player.seq !== token) return;
  player.item = { key, chatId, media, title, sub, message };
  player.hooks = hooks || null;
  a.muted = false;
  $('#p-title').textContent = title;
  $('#player').hidden = false;
  a.play().catch(() => {});
  syncPlayer();
}

function playCircle({ chatId, media, box, v, prog }) {
  if (player.circle?.v === v) {
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    return;
  }
  stopPlayer();
  player.circle = { chatId, media, box, v, prog };
  player.hooks = {
    tick: ({ time, dur }) => {
      prog?.setAttribute('stroke-dashoffset', String(305.4 * (1 - (dur ? Math.min(1, time / dur) : 0))));
      box.classList.toggle('playing', !v.paused);
      box.classList.toggle('paused', v.paused);
    },
  };
  v.muted = false;
  v.loop = false;
  try { v.currentTime = 0; } catch { /* ignore */ }
  box.classList.add('full');
  $('#p-title').textContent = 'Кружок';
  $('#player').hidden = false;
  v.play().catch(() => {});
  syncPlayer();
}

/* ---- верхняя плашка ---- */

$('#p-toggle').addEventListener('click', toggleCurrent);
$('#p-close').addEventListener('click', stopPlayer);
$('#p-open').addEventListener('click', () => {
  if (player.circle) {
    player.circle.box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  if (player.item) openSheet();
});

/* ---- нижняя шторка ---- */

function sheetFillMeta() {
  const it = player.item;
  if (!it) return;
  $('#aud-title').textContent = it.title;
  $('#aud-sub').textContent = it.sub || '';
  $('#aud-cover').replaceChildren(icon(it.media.kind === 'voice' ? 'mic' : 'note'));
  $('#aud-download').hidden = false;
}

function openSheet() {
  if (!player.item) return;
  sheetFillMeta();
  syncSheet(playerTime() || { time: 0, dur: 0, paused: true });
  $('#aud').hidden = false;
  $('#aud-menu').hidden = true;
}

function closeSheet() {
  $('#aud').hidden = true;
  $('#aud-menu').hidden = true;
}

function syncSheet(st) {
  const p = st.dur ? Math.min(1, st.time / st.dur) : 0;
  $('#aud-fill').style.width = `${p * 100}%`;
  $('#aud-knob').style.left = `${p * 100}%`;
  $('#aud-cur').textContent = M.clock(st.time);
  $('#aud-dur').textContent = M.clock(st.dur);
  setIcon($('#aud-big'), st.paused ? 'play' : 'pause');
}

function seekTo(clientX) {
  const r = $('#aud-bar').getBoundingClientRect();
  const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  const st = playerTime();
  const target = p * (st?.dur || 0);
  try {
    if (player.circle) player.circle.v.currentTime = target;
    else if (player.item) audioEl().currentTime = target;
  } catch { /* поток без длительности не перематывается */ }
  syncPlayer();
}

$('#aud-backdrop').addEventListener('click', closeSheet);
$('#aud-big').addEventListener('click', toggleCurrent);
$('#aud-more').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#aud-menu').hidden = !$('#aud-menu').hidden;
});
$('#aud-close').addEventListener('click', () => {
  closeSheet();
  stopPlayer();
});
const MIME_EXT = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
  'video/webm': 'webm', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif'
};

function mediaFileName(m) {
  const ext = MIME_EXT[String(m.mime || '').split(';')[0]] || 'bin';
  const base = String(m.name || '').trim();
  if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
  const label = m.kind === 'voice' ? 'Голосовое' : m.kind === 'circle' ? 'Кружок' : 'Файл';
  return `${base || `${label} ${m.id}`}.${ext}`;
}

$('#aud-download').addEventListener('click', async () => {
  const it = player.item;
  if (!it) return;
  $('#aud-menu').hidden = true;
  try {
    const blob = await mediaBlob(it.chatId, it.media);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = mediaFileName(it.media);
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  } catch (err) {
    toast(err?.message || 'Не удалось скачать');
  }
});
let seeking = false;
$('#aud-bar').addEventListener('pointerdown', (e) => {
  seeking = true;
  $('#aud-bar').setPointerCapture?.(e.pointerId);
  seekTo(e.clientX);
});
$('#aud-bar').addEventListener('pointermove', (e) => { if (seeking) seekTo(e.clientX); });
$('#aud-bar').addEventListener('pointerup', () => { seeking = false; });
$('#aud-bar').addEventListener('pointercancel', () => { seeking = false; });

/* --------------------------------------------------------- подписи */

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function stampFull(at) {
  const d = new Date(at || Date.now());
  return `${d.getDate()} ${MONTHS[d.getMonth()]}. в ${hhmm(at || Date.now())}`;
}

function senderLabel(chatId, msg) {
  if (!msg || msg.mine || msg.senderId === state.me?.id) return 'Вы';
  const chat = state.chats.find((c) => c.id === chatId);
  if (chat?.type === 'dm') return chat.peer?.name || chat.name || 'Собеседник';
  return msg.senderName || 'Участник';
}

function subtitle(chatId, msg) {
  if (!msg) return '';
  return `${senderLabel(chatId, msg)} · ${stampFull(msg.at)}`;
}

function extOf(name) {
  return (String(name || '').split('.').pop() || '').toLowerCase().slice(0, 5);
}

const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus', 'oga', 'weba', 'amr']);
function isAudio(media) {
  return String(media.mime || '').startsWith('audio/') || AUDIO_EXT.has(extOf(media.name));
}

/* ------------------------------------------------------------ кружок */

function circleNode(chatId, media, msg) {
  const box = document.createElement('div');
  box.className = 'media-circle';

  const v = document.createElement('video');
  v.playsInline = true;
  v.muted = true;
  v.loop = true;
  v.preload = 'metadata';
  v.setAttribute('playsinline', '');

  const ring = document.createElementNS(SVGNS, 'svg');
  ring.setAttribute('viewBox', '0 0 100 100');
  ring.setAttribute('class', 'c-ring');
  const track = document.createElementNS(SVGNS, 'circle');
  track.setAttribute('cx', '50');
  track.setAttribute('cy', '50');
  track.setAttribute('r', '48.6');
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'currentColor');
  track.setAttribute('stroke-width', '0.6');
  track.setAttribute('opacity', '.16');
  const prog = document.createElementNS(SVGNS, 'circle');
  prog.setAttribute('cx', '50');
  prog.setAttribute('cy', '50');
  prog.setAttribute('r', '48.6');
  prog.setAttribute('fill', 'none');
  prog.setAttribute('stroke', 'currentColor');
  prog.setAttribute('stroke-width', '0.9');
  prog.setAttribute('stroke-linecap', 'round');
  prog.setAttribute('stroke-dasharray', '305.4');
  prog.setAttribute('stroke-dashoffset', '305.4');
  prog.setAttribute('transform', 'rotate(-90 50 50)');
  prog.setAttribute('class', 'c-prog');
  ring.append(track, prog);

  const badge = document.createElement('span');
  badge.className = 'c-badge';
  badge.textContent = M.clock(media.duration || 0);
  badge.append(icon('sound', 'c-mute'));

  const tap = document.createElement('button');
  tap.type = 'button';
  tap.className = 'c-tap';
  tap.setAttribute('aria-label', 'Кружок');
  tap.append(icon('play', 'c-hint'));

  box.append(v, ring, badge, tap);

  tap.addEventListener('click', () => playCircle({ chatId, media, box, v, prog }));
  v.addEventListener('click', () => playCircle({ chatId, media, box, v, prog }));
  v.addEventListener('timeupdate', () => { if (player.circle?.v === v) syncPlayer(); });
  v.addEventListener('play', () => { if (player.circle?.v === v) syncPlayer(); });
  v.addEventListener('pause', () => { if (player.circle?.v === v) syncPlayer(); });
  v.addEventListener('ended', () => {
    if (player.circle?.v !== v) return;
    player.circle = null;
    player.hooks = null;
    $('#player').hidden = true;
    closeSheet();
    box.classList.remove('full', 'playing', 'paused');
    prog.setAttribute('stroke-dashoffset', '305.4');
    v.muted = true;
    v.loop = true;
    try { v.currentTime = 0; } catch { /* ignore */ }
    v.play().catch(() => {});
  });

  box.__load = async () => {
    try {
      await attachMedia(v, chatId, media, { autoplay: true });
    } catch {
      box.replaceWith(mediaPlaceholder('Кружок не открылся'));
    }
  };
  lazyIO.observe(box);
  return box;
}

/* ----------------------------------------------------------- голосовое */

function voiceNode(chatId, media, msg) {
  const row = document.createElement('div');
  row.className = 'media-audio';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'a-play';
  btn.setAttribute('aria-label', 'Слушать');
  btn.append(icon('play'));

  const body = document.createElement('div');
  body.className = 'a-body';

  const wave = document.createElement('div');
  wave.className = 'a-wave';
  const seed = (media.id * 2654435761) % 97;
  const bars = [];
  for (let i = 0; i < 30; i++) {
    const bar = document.createElement('i');
    bar.style.height = `${4 + ((seed + i * 37) % 15)}px`;
    wave.append(bar);
    bars.push(bar);
  }

  const meta = document.createElement('div');
  meta.className = 'a-meta';
  const time = document.createElement('span');
  time.className = 'a-time';
  time.textContent = M.clock(media.duration || 0);
  meta.append(time);

  body.append(wave, meta);
  row.append(btn, body);

  const paint = (p) => {
    const n = Math.round(bars.length * p);
    bars.forEach((b, i) => { b.classList.toggle('on', i < n); });
  };

  const hooks = {
    tick: ({ time: cur, dur, paused }) => {
      const d = dur || media.duration || 0;
      row.classList.remove('busy');
      row.classList.add('active');
      paint(d ? Math.min(1, cur / d) : 0);
      time.textContent = `${M.clock(cur)} · ${M.clock(d)}`;
      setIcon(btn, paused ? 'play' : 'pause');
    },
    reset: () => {
      row.classList.remove('busy', 'active');
      setIcon(btn, 'play');
      paint(0);
      time.textContent = M.clock(media.duration || 0);
    },
  };

  btn.addEventListener('click', () => {
    if (player.item?.key !== `${chatId}:${media.id}`) row.classList.add('busy');
    playAudio({ chatId, media, title: 'Голосовое сообщение', sub: subtitle(chatId, msg), message: msg, hooks });
  });

  wave.addEventListener('click', (e) => {
    if (player.item?.key !== `${chatId}:${media.id}`) return;
    const a = audioEl();
    if (!a.duration) return;
    const r = wave.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * a.duration;
  });
  return row;
}

/* ---------------------------------------------------------------- файл */

const EXT_CLASS = {
  pdf: 'pdf', doc: 'doc', docx: 'doc', txt: 'doc', rtf: 'doc',
  xls: 'xls', xlsx: 'xls', csv: 'xls',
  zip: 'zip', rar: 'zip', '7z': 'zip', gz: 'zip', tar: 'zip',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video',
};

function fileCard(media, ext) {
  const ico = document.createElement('span');
  ico.className = 'f-ico ' + (EXT_CLASS[ext] || 'bin');
  ico.textContent = ext || 'file';

  const body = document.createElement('span');
  body.className = 'f-body';
  const nm = document.createElement('span');
  nm.className = 'f-name';
  nm.textContent = media.name || 'файл';
  const sz = document.createElement('span');
  sz.className = 'f-size';
  sz.textContent = M.humanSize(media.size);
  body.append(nm, sz);
  return { ico, body };
}

function fileNode(media, chatId, msg) {
  const name = media.name || 'файл';
  const ext = extOf(name);

  if (isAudio(media)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'media-file is-audio';
    const { ico, body } = fileCard(media, ext);
    const btn = document.createElement('span');
    btn.className = 'f-play';
    btn.append(icon('play'));
    card.append(ico, body, btn);

    const hooks = {
      tick: ({ paused }) => {
        card.classList.add('active');
        setIcon(btn, paused ? 'play' : 'pause');
      },
      reset: () => {
        card.classList.remove('active');
        setIcon(btn, 'play');
      },
    };
    card.addEventListener('click', () => {
      playAudio({ chatId, media, title: name, sub: subtitle(chatId, msg), message: msg, hooks });
    });
    return card;
  }

  const a = document.createElement('a');
  a.className = 'media-file';
  a.href = `/api/media/${media.id}`;
  a.setAttribute('download', name);
  a.rel = 'noopener';
  const { ico, body } = fileCard(media, ext);
  const dl = document.createElement('span');
  dl.className = 'f-dl';
  dl.append(icon('download'));
  a.append(ico, body, dl);
  return a;
}

function mediaBlock(chatId, media, caption, msg) {
  const items = media.filter((m) => m.kind !== 'preview');
  const wrap = document.createElement('div');
  wrap.className = 'media-stack';
  const photos = items.filter((m) => m.kind === 'photo');
  const rest = items.filter((m) => m.kind !== 'photo');

  if (photos.length) {
    const grid = document.createElement('div');
    grid.className = 'media-grid' + (photos.length === 1 ? ' one' : '');
    for (const p of photos) grid.append(imageNode(chatId, p, openLightbox, photos.length > 1));
    wrap.append(grid);
  }
  for (const m of rest) {
    if (m.kind === 'voice') wrap.append(voiceNode(chatId, m, msg));
    else if (m.kind === 'circle') wrap.append(circleNode(chatId, m, msg));
    else if (m.kind === 'video') wrap.append(videoNode(chatId, m));
    else if (m.kind === 'file') wrap.append(fileNode(m, chatId, msg));
  }
  if (caption) {
    const cap = document.createElement('div');
    cap.className = 'cap';
    fillMentions(cap, caption);
    wrap.append(cap);
  }
  return wrap;
}

function openLightbox(chatId, media) {
  const box = $('#lightbox');
  const img = $('#lb-img');
  const video = $('#lb-video');
  img.hidden = true;
  video.hidden = true;
  video.pause?.();
  video.removeAttribute('src');
  box.hidden = false;
  document.body.style.overflow = 'hidden';
  mediaURL(chatId, media).then((url) => {
    if (media.kind === 'photo') {
      img.src = url;
      img.hidden = false;
    } else {
      video.src = media.enc ? url : `/api/media/${media.id}`;
      video.hidden = false;
      video.play().catch(() => {});
    }
  }).catch(() => toast('Не удалось открыть файл'));
}

function closeLightbox() {
  const box = $('#lightbox');
  box.hidden = true;
  $('#lb-img').removeAttribute('src');
  const v = $('#lb-video');
  v.pause();
  v.removeAttribute('src');
  $('#lb-img').hidden = true;
  v.hidden = true;
  document.body.style.overflow = '';
}

$('#lb-close').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });

/* ------------------------------------------------- отметки о прочтении */

function ticksEl(read) {
  const s = document.createElement('span');
  s.className = 'ticks' + (read ? ' read' : '');
  s.title = read ? 'прочитано' : 'отправлено';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 26 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [cls, d] of [['t1', 'M3 12.5 7 16.5 15 7'], ['t2', 'M11.5 13 15.5 17 24 6.5']]) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('class', cls);
    p.setAttribute('d', d);
    svg.append(p);
  }
  s.append(svg);
  return s;
}

function messageMeta(chatId, m) {
  const meta = document.createElement('span');
  meta.className = 'meta';
  const t = document.createElement('span');
  t.className = 'time';
  t.textContent = hhmm(m.at);
  meta.append(t);
  const chat = state.chats.find((c) => c.id === chatId);
  if (isMine(m) && chat?.type === 'dm') meta.append(ticksEl((chat.peerRead || 0) >= m.id));
  return meta;
}

function updateTicks(chatId) {
  if (chatId !== state.activeId) return;
  const chat = state.chats.find((c) => c.id === chatId);
  const read = chat?.peerRead || 0;
  for (const el of $$('#messages .msg.mine')) {
    const t = el.querySelector('.meta .ticks');
    if (!t) continue;
    const ok = Number(el.dataset.id || 0) <= read;
    t.classList.toggle('read', ok);
    t.title = ok ? 'прочитано' : 'отправлено';
  }
}

/* каждый новый рендер отменяет предыдущий: старый чат не может дописаться в открытый */
let renderSeq = 0;
let renderActiveChatId = null;

async function renderMessages(chatId, { keepScroll = false } = {}) {
  const token = ++renderSeq;
  if (chatId !== state.activeId) return;
  const wrap = $('#messages');
  wrap.innerHTML = '';
  const list = [...(state.messages.get(chatId) || [])];
  const isChannelChat = state.chats.find((c) => c.id === chatId)?.type === 'channel';
  renderActiveChatId = chatId;
  const texts = await Promise.all(list.map((m) => plainOf(chatId, m)));
  if (token !== renderSeq || chatId !== state.activeId) {
    if (token === renderSeq) renderActiveChatId = null;
    return;
  }
  /* пока расшифровывали, прилетело новое сообщение — перерисовываем с ним */
  const current = state.messages.get(chatId) || [];
  if (current.length !== list.length || current.some((m, i) => m.id !== list[i].id)) {
    return renderMessages(chatId, { keepScroll });
  }

  let lastDay = '';
  let lastSender = null;
  let lastTs = 0;

  list.forEach((m, idx) => {
    if (isChannelChat && isChannelMemberNotice(m)) { lastSender = null; return; }
    const day = dayLabel(m.at);
    if (day !== lastDay) {
      const d = document.createElement('div');
      d.className = 'msg-day';
      d.textContent = day;
      wrap.append(d);
      lastDay = day;
      lastSender = null;
    }
    if (m.kind === 'system') {
      const sys = document.createElement('div');
      sys.className = 'msg-system';
      sys.textContent = texts[idx] || m.body;
      wrap.append(sys);
      lastSender = null;
      return;
    }
    const el = document.createElement('div');
    const mine = !isChannelChat && isMine(m);
    const same = !isChannelChat && lastSender === m.senderId && m.at - lastTs < 5 * 60e3;
    el.className = `msg ${mine ? 'mine' : 'them'}${same ? ' same' : ''}`;
    el.dataset.id = String(m.id);
    if (!mine) addSenderName(el, chatId, m);
    const media = m.media || [];
    if (media.length) {
      el.classList.add('has-media');
      if (media.length === 1 && media[0].kind === 'circle' && !texts[idx]) el.classList.add('solo-circle');
      if (!texts[idx] && media.every((x) => x.kind === 'photo' || x.kind === 'video')) el.classList.add('solo-media');
      el.append(mediaBlock(chatId, media, texts[idx], m));
    } else {
      const t = document.createElement('span');
      t.className = 'txt';
      fillMentions(t, texts[idx] || '');
      el.append(t);
    }
    el.append(messageMeta(chatId, m));
    wrap.append(el);

    lastSender = m.senderId;
    lastTs = m.at;
  });
  renderActiveChatId = null;
  if (!keepScroll) requestAnimationFrame(() => {
    if (token !== renderSeq || chatId !== state.activeId) return;
    wrap.scrollTop = wrap.scrollHeight;
  });
}

/* подгрузка истории при прокрутке вверх */
let loadingOlder = false;
const noMoreHistory = new Set();

$('#messages').addEventListener('scroll', async () => {
  const wrap = $('#messages');
  if (wrap.scrollTop > 90 || loadingOlder) return;
  const chatId = state.activeId;
  if (!chatId || noMoreHistory.has(chatId)) return;
  const list = state.messages.get(chatId);
  if (!list?.length) return;
  loadingOlder = true;
  try {
    const { messages } = await api(`/api/chats/${chatId}/messages?before=${list[0].id}`);
    if (!messages.length) {
      noMoreHistory.add(chatId);
    } else {
      const prevHeight = wrap.scrollHeight;
      const prevTop = wrap.scrollTop;
      state.messages.set(chatId, mergeMessages(chatId, messages));
      await renderMessages(chatId, { keepScroll: true });
      if (chatId !== state.activeId) return;
      wrap.scrollTop = wrap.scrollHeight - prevHeight + prevTop;
    }
  } catch { /* не критично */ } finally {
    loadingOlder = false;
  }
});

function addSenderName(el, chatId, m) {
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat || chat.type === 'dm' || chat.type === 'channel') return;
  const list = state.members.get(chatId) || [];
  const sender = list.find((x) => x.id === m.senderId);
  const name = sender?.displayName || sender?.username || m.senderName;
  if (!name) return;
  const s = document.createElement('span');
  s.className = 'msg-sender';
  s.textContent = name;
  el.append(s);
}

async function appendMessage(chatId, m) {
  normalizeMessage(m);
  let list = state.messages.get(chatId);
  if (!list) {
    list = [];
    state.messages.set(chatId, list);
  }
  if (list.some((x) => x.id === m.id)) return;
  const prev = list[list.length - 1];
  list.push(m);
  const isChannelChat = state.chats.find((c) => c.id === chatId)?.type === 'channel';
  if (isChannelChat && isChannelMemberNotice(m)) return;
  const text = await plainOf(chatId, m);
  if (text) state.preview.set(chatId, text);
  const media = m.media || [];
  if (media.length && !text) state.preview.set(chatId, MEDIA_LABEL[media[0].kind] || 'Вложение');
  if (chatId !== state.activeId) return;
  /* сейчас идёт полный рендер этого чата — он сам подхватит новое сообщение */
  if (renderActiveChatId === chatId) return;

  const wrap = $('#messages');
  const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120;
  if (m.kind === 'system') {
    const sys = document.createElement('div');
    sys.className = 'msg-system';
    sys.textContent = m.body;
    wrap.append(sys);
    requestAnimationFrame(() => {
      if (chatId === state.activeId) wrap.scrollTop = wrap.scrollHeight;
    });
    return;
  }
  const el = document.createElement('div');
  const mine = !isChannelChat && isMine(m);
  const grouped = !isChannelChat && prev && prev.senderId === m.senderId && m.at - prev.at < 5 * 60e3;
  el.className = `msg ${mine ? 'mine' : 'them'}${grouped ? ' same' : ''}`;
  el.dataset.id = String(m.id);
  if (!mine) addSenderName(el, chatId, m);
  if (media.length) {
    el.classList.add('has-media');
    if (media.length === 1 && media[0].kind === 'circle' && !text) el.classList.add('solo-circle');
    if (!text && media.every((x) => x.kind === 'photo' || x.kind === 'video')) el.classList.add('solo-media');
    el.append(mediaBlock(chatId, media, text, m));
  } else {
    const t = document.createElement('span');
    t.className = 'txt';
    fillMentions(t, text || '');
    el.append(t);
  }
  el.append(messageMeta(chatId, m));
  wrap.append(el);
  if (nearBottom || mine) {
    requestAnimationFrame(() => {
      if (chatId === state.activeId) wrap.scrollTop = wrap.scrollHeight;
    });
  }
}

async function markRead(chatId) {
  if (chatId !== state.activeId) return;
  const chat = state.chats.find((c) => c.id === chatId);
  /* предпросмотр канала без подписки не отмечаем прочитанным */
  if (chat?.preview) return;
  const list = state.messages.get(chatId);
  const last = list?.[list.length - 1];
  if (!last) return;
  api(`/api/chats/${chatId}/read`, { method: 'POST', body: JSON.stringify({ id: last.id }) }).catch(() => {});
  if (chat && chat.unread) { chat.unread = 0; scheduleRenderChats(); }
}

/* --------------------------------------------------------------- отправка */

const input = $('#msg-input');
const sendBtn = $('#btn-send');

function syncSend() {
  const has = input.value.trim().length > 0;
  sendBtn.dataset.mode = has ? 'send' : 'mic';
  sendBtn.classList.toggle('is-mic', !has);
  sendBtn.classList.toggle('is-circle', !has && recKind === 'circle');
  if (has) {
    sendBtn.setAttribute('aria-label', 'Отправить');
    sendBtn.title = 'Отправить';
    setIcon(sendBtn, 'send');
  } else {
    paintMic();
  }
}

/* пустой композер: кнопка справа — голосовое или кружок.
   короткое касание переключает режим, долгое — начинает запись */
let recKind = localStorage.getItem('papuz-rec-kind') === 'circle' ? 'circle' : 'voice';
let recPressTimer = null;
let recPressLong = false;
let recPressMuteUntil = 0;

function paintMic() {
  const isCircle = recKind === 'circle';
  setIcon(sendBtn, isCircle ? 'circle' : 'mic');
  sendBtn.setAttribute('aria-label', isCircle ? 'Записать кружок' : 'Записать голосовое');
  sendBtn.title = isCircle ? 'Кружок · удерживай, чтобы записать' : 'Голосовое · удерживай, чтобы записать';
}

function clearPressTimer() {
  if (recPressTimer) { clearTimeout(recPressTimer); recPressTimer = null; }
}

sendBtn.addEventListener('pointerdown', (e) => {
  if (input.value.trim().length || !state.activeId || recState) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  recPressLong = false;
  recPressTimer = setTimeout(() => {
    recPressTimer = null;
    recPressLong = true;
    recPressMuteUntil = Date.now() + 900;
    navigator.vibrate?.(12);
    startRecording(recKind);
  }, 380);
});

sendBtn.addEventListener('pointerup', clearPressTimer);
sendBtn.addEventListener('pointerleave', clearPressTimer);
sendBtn.addEventListener('pointercancel', () => {
  clearPressTimer();
  recPressMuteUntil = Date.now() + 900;
});

sendBtn.addEventListener('click', (e) => {
  if (input.value.trim().length) return;
  e.preventDefault();
  if (!state.activeId) return;
  if (Date.now() < recPressMuteUntil) { recPressMuteUntil = 0; recPressLong = false; return; }
  recKind = recKind === 'voice' ? 'circle' : 'voice';
  try { localStorage.setItem('papuz-rec-kind', recKind); } catch { /* приватный режим */ }
  syncSend();
  navigator.vibrate?.(6);
  toast(recKind === 'circle' ? 'Режим: кружок' : 'Режим: голосовое');
});

$('#btn-attach').append(icon('attach'));
$('#p-toggle').append(icon('play'));
$('#p-close').append(icon('close'));
$('#rec-cancel').append(icon('trash'));
$('#rec-cancel2').append(icon('trash'));
$('#rec-flip').append(icon('flip'));
$('#aud-more').append(icon('dots'));
$('#aud-big').append(icon('pause'));
$$('#attach-menu [data-icon]').forEach((s) => s.append(icon(s.dataset.icon)));

syncSend();

input.addEventListener('input', () => {
  syncSend();
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  const chatId = state.activeId;
  if (chatId && state.ws?.readyState === 1) {
    const chat = state.chats.find((c) => c.id === chatId);
    if (chat?.type === 'channel') return;
    const key = `t:${chatId}`;
    if (!state.typingTimers.has(key)) {
      state.ws.send(JSON.stringify({ type: 'typing', chatId }));
      state.typingTimers.set(key, setTimeout(() => state.typingTimers.delete(key), 2500));
    }
  }
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const chatId = state.activeId;
  if (!text || !chatId) return;

  input.value = '';
  input.style.height = 'auto';
  syncSend();

  try {
    const key = await getChatKey(chatId);
    const payload = key ? await K.encryptText(key, text) : text;
    await deliver(chatId, payload, [], text);
  } catch (err) {
    input.value = text;
    syncSend();
    toast(err.message);
  }
});

/* общий путь для любого сообщения: текст + вложения */
async function deliver(chatId, payload, mediaIds, plainText = '') {
  const { message } = await api(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body: payload, media: mediaIds }),
  });
  normalizeMessage(message);
  if (message.senderId !== state.me.id) {
    toast('В этой вкладке сменился аккаунт — обновляю…');
    setTimeout(() => location.reload(), 900);
    return message;
  }
  if (plainText) {
    state.plain.set(plainKey(chatId, message.id), plainText);
    state.preview.set(chatId, plainText);
  } else if (message.media?.length) {
    state.preview.set(chatId, MEDIA_LABEL[message.media[0].kind] || 'Вложение');
  }
  await appendMessage(chatId, message);
  const chat = state.chats.find((c) => c.id === chatId);
  if (chat) {
    chat.lastMessage = { id: message.id, body: message.body, at: message.at, mine: true, media: message.media?.[0]?.kind || null };
  }
  state.chats = [chat, ...state.chats.filter((c) => c.id !== chatId)].filter(Boolean);
  scheduleRenderChats();
  return message;
}

/* ------------------------------------------------------ прикрепления */

const attachBtn = $('#btn-attach');
const attachMenu = $('#attach-menu');
const uploadsBox = $('#uploads');

attachBtn.addEventListener('click', () => {
  const open = attachMenu.hidden;
  attachMenu.hidden = !open;
  attachBtn.setAttribute('aria-expanded', String(open));
  setIcon(attachBtn, open ? 'close' : 'attach');
  attachBtn.setAttribute('aria-label', open ? 'Закрыть меню' : 'Прикрепить');
});

function closeAttach() {
  attachMenu.hidden = true;
  attachBtn.setAttribute('aria-expanded', 'false');
  setIcon(attachBtn, 'attach');
  attachBtn.setAttribute('aria-label', 'Прикрепить');
}

document.addEventListener('click', (e) => {
  if (!attachMenu.hidden && !attachMenu.contains(e.target) && e.target !== attachBtn && !attachBtn.contains(e.target)) closeAttach();
});

$$('#attach-menu button').forEach((b) => b.addEventListener('click', () => {
  closeAttach();
  const kind = b.dataset.attach;
  if (!state.activeId) return toast('Сначала выбери чат');
  if (kind === 'photo') $('#in-photo').click();
  else if (kind === 'video') $('#in-video').click();
  else if (kind === 'file') $('#in-file').click();
  else if (kind === 'voice') startRecording('voice');
  else if (kind === 'circle') startRecording('circle');
}));

function uploadRow(label) {
  uploadsBox.hidden = false;
  const row = document.createElement('div');
  row.className = 'upload';
  const text = document.createElement('span');
  text.textContent = label;
  text.style.whiteSpace = 'nowrap';
  text.style.overflow = 'hidden';
  text.style.textOverflow = 'ellipsis';
  const bar = document.createElement('span');
  bar.className = 'u-bar';
  const fill = document.createElement('i');
  bar.append(fill);
  row.append(text, bar);
  uploadsBox.append(row);
  let hideTimer = null;
  return {
    progress(p) { fill.style.width = `${Math.round(p * 100)}%`; },
    label(t) { text.textContent = t; },
    done() {
      row.classList.add('done');
      fill.style.width = '100%';
      hideTimer = setTimeout(() => { row.remove(); if (!uploadsBox.children.length) uploadsBox.hidden = true; }, 900);
    },
    fail(msg) {
      row.classList.add('err');
      text.textContent = msg;
      fill.style.width = '0%';
      const t = hideTimer;
      if (t) clearTimeout(t);
      setTimeout(() => { row.remove(); if (!uploadsBox.children.length) uploadsBox.hidden = true; }, 4000);
    },
  };
}

async function ensureChatKey(chatId) {
  const chat = state.chats.find((c) => c.id === chatId);
  if (chat && chat.type !== 'dm') return null;
  const key = await getChatKey(chatId);
  if (!key) throw new Error('У собеседника нет ключа шифрования — медиа отправить нельзя');
  return key;
}

async function uploadPlain(chatId, blob, { kind, mime, w = 0, h = 0, dur = 0, row, name = '' }) {
  const res = await M.uploadBlob({
    chatId, kind, blob, mime, enc: false, w, h, dur, name,
    onProgress: (p) => row?.progress(p),
  });
  row?.progress(1);
  return res.media;
}

async function uploadEncrypted(chatId, key, blob, { kind, mime, w = 0, h = 0, dur = 0, row, name = '' }) {
  const packed = await M.encryptBlob(key, blob);
  const res = await M.uploadBlob({
    chatId, kind, blob: packed, mime, enc: true, w, h, dur, name,
    onProgress: (p) => row?.progress(p),
  });
  row?.progress(1);
  return res.media;
}

$('#in-photo').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (files.length) await sendPhotos(files);
});

async function sendPhotos(files) {
  const chatId = state.activeId;
  if (!chatId) return;
  const picked = files.slice(0, M.LIMITS.photosPerMessage);
  if (files.length > picked.length) toast(`За раз можно ${M.LIMITS.photosPerMessage} фото`);
  let key;
  try { key = await ensureChatKey(chatId); } catch (err) { return toast(err.message); }

  const row = uploadRow(`Фото 0/${picked.length}`);
  const ids = [];
  try {
    for (let i = 0; i < picked.length; i++) {
      row.label(`Фото ${i + 1}/${picked.length}`);
      const { blob, width, height } = await M.compressImage(picked[i]);
      const media = key
        ? await uploadEncrypted(chatId, key, blob, { kind: 'photo', mime: 'image/jpeg', w: width, h: height, row })
        : await uploadPlain(chatId, blob, { kind: 'photo', mime: 'image/jpeg', w: width, h: height, row });
      ids.push(media.id);
    }
    row.done();
    await deliver(chatId, '', ids, picked.length === 1 ? 'Фото' : `${picked.length} фото`);
    state.preview.set(chatId, picked.length === 1 ? 'Фото' : `${picked.length} фото`);
  } catch (err) {
    row.fail(err.message);
    toast(err.message);
  }
}

/* видео: без перекодирования, только проверка лимитов */
$('#in-video').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const chatId = state.activeId;
  if (!chatId) return;
  const row = uploadRow('Видео');
  try {
    if (file.size > M.LIMITS.videoBytes) throw new Error('Видео больше 150 МБ');
    const meta = await M.videoMeta(file);
    if (meta.duration > M.LIMITS.videoSeconds + 1) throw new Error('Видео длиннее 5 минут');
    if (meta.width > 1920 || meta.height > 1080) throw new Error('Максимум 1080p — пересними в Full HD');
    row.label('Запись на сервер…');
    const res = await M.uploadBlob({
      chatId, kind: 'video', blob: file, mime: file.type || 'video/mp4', enc: false,
      w: meta.width, h: meta.height, dur: meta.duration, name: file.name,
      onProgress: (p) => row.progress(p),
    });
    row.done();
    await deliver(chatId, '', [res.media.id]);
    state.preview.set(chatId, 'Видео');
    scheduleRenderChats();
  } catch (err) {
    row.fail(err.message);
    toast(err.message);
  }
});

/* файлы: до 5 штук, каждый до 1 ГБ, суммарно до 2 ГБ */
$('#in-file').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (files.length) await sendFiles(files);
});

async function sendFiles(files) {
  const chatId = state.activeId;
  if (!chatId) return;
  const picked = files.slice(0, M.LIMITS.filesPerMessage);
  if (files.length > picked.length) toast('Не больше 5 файлов за раз');
  let total = 0;
  for (const f of picked) {
    if (f.size > M.LIMITS.fileBytes) return toast(`${f.name}: больше 1 ГБ`);
    total += f.size;
  }
  if (total > M.LIMITS.messageBytes) return toast('Суммарно больше 2 ГБ');

  const row = uploadRow(picked.length === 1 ? picked[0].name : `Файлы 0/${picked.length}`);
  const ids = [];
  try {
    for (let i = 0; i < picked.length; i++) {
      const f = picked[i];
      row.label(picked.length === 1 ? f.name : `Файл ${i + 1}/${picked.length}`);
      const res = await M.uploadBlob({
        chatId, kind: 'file', blob: f, name: f.name, mime: f.type || 'application/octet-stream',
        enc: false, onProgress: (p) => row.progress(p),
      });
      ids.push(res.media.id);
    }
    row.done();
    await deliver(chatId, '', ids);
    state.preview.set(chatId, picked.length === 1 ? picked[0].name : `${picked.length} файла`);
    scheduleRenderChats();
  } catch (err) {
    row.fail(err.message);
    toast(err.message);
  }
}

/* --------------------------------------------------------- запись медиа */

let recState = null;

function stopTracks(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

function pickMime(candidates) {
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function recUI(show, kind) {
  const box = $('#rec');
  box.hidden = !show;
  box.classList.toggle('is-circle', !!show && kind === 'circle');
  document.body.style.overflow = show && kind === 'circle' ? 'hidden' : '';
  document.body.classList.toggle('rec-voice', !!show && kind !== 'circle');
}

function buildWave() {
  const box = $('#rec-wave');
  if (box.childElementCount) return;
  for (let i = 0; i < 36; i++) {
    const b = document.createElement('i');
    b.style.animationDelay = `-${(i * 173) % 900}ms`;
    b.style.animationDuration = `${760 + ((i * 271) % 520)}ms`;
    box.append(b);
  }
}

function cameraStream(facing) {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1280 } },
    audio: false,
  });
}

async function startRecording(kind) {
  if (recState) return;
  const isCircle = kind === 'circle';
  let mic = null;
  let cam = null;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (isCircle) cam = await cameraStream('user');
  } catch {
    stopTracks(mic);
    stopTracks(cam);
    return toast(isCircle ? 'Нужен доступ к камере и микрофону' : 'Нет доступа к микрофону');
  }

  /* Firefox пишет только ogg/opus, Chrome — webm: перебираем всё, что умеет браузер */
  const mime = isCircle
    ? pickMime([
      'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus',
      'video/webm', 'video/ogg;codecs=opus', 'video/mp4',
    ])
    : pickMime([
      'audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/ogg',
      'audio/webm', 'audio/mp4',
    ]);
  if (!mime) {
    stopTracks(mic);
    stopTracks(cam);
    return toast('Браузер не умеет записывать');
  }

  const st = {
    kind, mic, cam, mime, chunks: [], cancelled: false, facing: 'user',
    started: Date.now(), raf: 0, tick: 0, canFlip: false,
  };
  recState = st;

  const video = $('#rec-video');
  let stream = mic;

  if (isCircle) {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 720;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#0a1a13';
    ctx.fillRect(0, 0, 720, 720);

    video.hidden = false;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = cam;
    video.play().catch(() => {});

    const draw = () => {
      st.raf = requestAnimationFrame(draw);
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const side = Math.min(vw, vh);
      ctx.save();
      if (st.facing === 'user') {
        ctx.translate(720, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, 720, 720);
      ctx.restore();
    };
    draw();

    const cap = canvas.captureStream ? canvas.captureStream(30) : null;
    st.canFlip = Boolean(cap);
    stream = new MediaStream([
      ...(cap ? cap.getVideoTracks() : cam.getVideoTracks()),
      ...mic.getAudioTracks(),
    ]);
  } else {
    video.hidden = true;
  }

  let recorder = null;
  const opts = isCircle
    ? { mimeType: mime, videoBitsPerSecond: 1_400_000, audioBitsPerSecond: 64_000 }
    : { mimeType: mime, audioBitsPerSecond: 64_000 };
  try {
    recorder = new MediaRecorder(stream, opts);
  } catch {
    /* если браузер не принял mimeType — пробуем совсем без настроек */
    try {
      recorder = new MediaRecorder(stream);
    } catch {
      stopTracks(mic);
      stopTracks(cam);
      cancelAnimationFrame(st.raf);
      video.srcObject = null;
      recState = null;
      return toast('Браузер не умеет записывать');
    }
  }
  /* что реально пишет браузер — то и отправляем (Firefox может подменить mimeType) */
  st.mime = recorder.mimeType || mime;

  st.recorder = recorder;
  const limit = isCircle ? M.LIMITS.circleSeconds : M.LIMITS.voiceSeconds;

  buildWave();
  $('#rec-timer').textContent = '0:00';
  $('#rec-time2').textContent = '0:00';
  $('#rec-ring').style.setProperty('--p', '0');
  $('#rec-hint').textContent = 'Кружок · нажми, чтобы отправить';
  $('#rec-flip').hidden = !st.canFlip;
  recUI(true, kind);

  st.tick = setInterval(() => {
    const s = (Date.now() - st.started) / 1000;
    const txt = M.clock(s);
    $('#rec-timer').textContent = txt;
    $('#rec-time2').textContent = txt;
    $('#rec-ring').style.setProperty('--p', String(Math.min(100, (s / limit) * 100)));
    if (s >= limit) finishRecording(false);
  }, 200);

  recorder.addEventListener('dataavailable', (ev) => { if (ev.data.size) st.chunks.push(ev.data); });
  recorder.addEventListener('stop', async () => {
    clearInterval(st.tick);
    cancelAnimationFrame(st.raf);
    const duration = Math.min((Date.now() - st.started) / 1000, limit);
    stopTracks(mic);
    stopTracks(cam);
    video.srcObject = null;
    recUI(false, kind);
    if (recState === st) recState = null;
    if (st.cancelled || !st.chunks.length) return;

    const blob = new Blob(st.chunks, { type: st.mime });
    const chatId = state.activeId;
    if (!chatId) return;
    const row = uploadRow(isCircle ? 'Кружок' : 'Голосовое');
    try {
      const key = await ensureChatKey(chatId);
      const media = key
        ? await uploadEncrypted(chatId, key, blob, { kind, mime: st.mime.split(';')[0], dur: duration, w: isCircle ? 720 : 0, h: isCircle ? 720 : 0, row })
        : await uploadPlain(chatId, blob, { kind, mime: st.mime.split(';')[0], dur: duration, w: isCircle ? 720 : 0, h: isCircle ? 720 : 0, row });
      row.done();
      await deliver(chatId, '', [media.id]);
      state.preview.set(chatId, isCircle ? 'Кружок' : 'Голосовое');
      scheduleRenderChats();
    } catch (err) {
      row.fail(err.message);
      toast(err.message);
    }
  });

  recorder.start(1000);
}

async function flipCamera() {
  const st = recState;
  if (!st || st.kind !== 'circle' || !st.canFlip) return;
  const video = $('#rec-video');
  const want = st.facing === 'user' ? 'environment' : 'user';
  const prevFacing = st.facing;
  const prev = st.cam;
  st.cam = null;
  stopTracks(prev);
  video.srcObject = null;

  let next = null;
  try {
    next = await cameraStream(want);
  } catch {
    try { next = await cameraStream(prevFacing); } catch { /* камеры нет */ }
    if (recState === st) toast('Не удалось переключить камеру');
  }
  if (recState !== st) {
    stopTracks(next);
    return;
  }
  if (next) {
    st.cam = next;
    st.facing = want;
    video.srcObject = next;
    video.play().catch(() => {});
  }
}

function finishRecording(cancel) {
  if (!recState) return;
  if (cancel) recState.cancelled = true;
  try { recState.recorder.stop(); } catch { /* уже остановлен */ }
}

$('#rec-stop').append(icon('send'));
$('#rec-stop2').append(icon('send'));
$('#rec-stop').addEventListener('click', () => finishRecording(false));
$('#rec-stop2').addEventListener('click', () => finishRecording(false));
$('#rec-cancel').addEventListener('click', () => finishRecording(true));
$('#rec-cancel2').addEventListener('click', () => finishRecording(true));
$('#rec-flip').addEventListener('click', flipCamera);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recState) finishRecording(true);
});

$('#btn-back').addEventListener('click', () => {
  $('.shell').classList.remove('chat-open');
  state.activeId = null;
  $('#chat-body').hidden = true;
  $('#chat-empty').hidden = false;
  scheduleRenderChats();
  requestAnimationFrame(replayChatsIntro);
});

/* --------------------------------------------------------------- поиск */

let searchTimer = null;
let resultsToken = 0;
const searchInput = $('#search');
const results = $('#results');

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { resultsToken++; results.hidden = true; results.innerHTML = ''; return; }
  searchTimer = setTimeout(() => runSearch(q), 240);
});

function resultRow(fillAvatar, title, nick, onPick) {
  const b = document.createElement('button');
  b.className = 'result';
  const av = document.createElement('span');
  fillAvatar(av);
  const meta = document.createElement('div');
  const n = document.createElement('div');
  n.className = 'result-name';
  n.textContent = title;
  const k = document.createElement('div');
  k.className = 'result-nick';
  k.textContent = nick;
  meta.append(n, k);
  b.append(av, meta);
  b.addEventListener('click', onPick);
  return b;
}

async function runSearch(q) {
  const token = ++resultsToken;
  try {
    const { users = [], channels = [] } = await api(`/api/users?q=${encodeURIComponent(q)}`);
    if (token !== resultsToken) return;
    results.innerHTML = '';
    if (!users.length && !channels.length) {
      const d = document.createElement('div');
      d.className = 'result-none';
      d.textContent = 'Никого не нашли';
      results.append(d);
    }
    for (const ch of channels) {
      const nick = `@${ch.username} · ${ch.members} ${plural(ch.members, 'подписчик', 'подписчика', 'подписчиков')}`;
      results.append(resultRow((av) => groupAvatar(av, ch, 'av-sm'), ch.title, nick, () => openChannelCard(ch)));
    }
    for (const u of users) {
      /* в поиске не показываем presence: это лишняя утечка */
      results.append(resultRow((av) => avatarEl(av, u, 'av-sm'), u.displayName, '@' + u.username, () => startChat(u)));
    }
    results.hidden = false;
  } catch (err) {
    if (token !== resultsToken) return;
    toast(err.message);
  }
}

/* отдельная страница со всеми людьми PAPUZ — кнопка с человечками */
const usersPage = $('#users-page');
const usersList = $('#users-list');

function closeUsersPage() {
  usersPage.hidden = true;
  usersList.innerHTML = '';
}

async function openUsersPage() {
  clearTimeout(searchTimer);
  searchInput.value = '';
  results.hidden = true;
  results.innerHTML = '';
  usersPage.hidden = false;
  usersList.innerHTML = '<div class="result-none">Загружаю…</div>';
  try {
    const { users = [] } = await api('/api/users?all=1');
    if (usersPage.hidden) return;
    usersList.innerHTML = '';
    if (!users.length) {
      const d = document.createElement('div');
      d.className = 'result-none';
      d.textContent = 'Пока никого нет';
      usersList.append(d);
      return;
    }
    for (const u of users) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'user-row';
      const av = document.createElement('span');
      avatarEl(av, u, 'av-md');
      const body = document.createElement('div');
      body.className = 'user-row-body';
      const n = document.createElement('div');
      n.className = 'user-row-name';
      n.textContent = u.displayName;
      const k = document.createElement('div');
      k.className = 'user-row-nick';
      k.textContent = '@' + u.username;
      body.append(n, k);
      const bio = (u.bio || '').trim();
      if (bio) {
        const d = document.createElement('div');
        d.className = 'user-row-bio';
        d.textContent = bio;
        body.append(d);
      }
      b.append(av, body);
      b.addEventListener('click', () => {
        closeUsersPage();
        startChat(u);
      });
      usersList.append(b);
    }
  } catch (err) {
    if (usersPage.hidden) return;
    closeUsersPage();
    toast(err.message);
  }
}

async function startChat(user) {
  results.hidden = true;
  searchInput.value = '';
  try {
    const { chatId, peer } = await api('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ userId: user.id }),
    });
    state.peers.set(chatId, peer);
    const existing = state.chats.find((c) => c.id === chatId);
    if (existing) existing.peer = peer;
    else state.chats.unshift({ id: chatId, type: 'dm', title: peer.displayName, peer, lastMessage: null, unread: 0 });
    state.messages.delete(chatId);
    scheduleRenderChats();
    await openChat(chatId);
    input.focus();
  } catch (err) {
    toast(err.message);
  }
}

document.addEventListener('click', (e) => {
  if (!results.hidden && !results.contains(e.target) && e.target !== searchInput) results.hidden = true;
});

/* канал из поиска: подписанный открываем как обычно, незнакомый — без подписки */
async function openChannelCard(card) {
  if (!card || !card.id) return;
  results.hidden = true;
  searchInput.value = '';
  try {
    const known = state.chats.find((c) => c.id === card.id);
    if (known) {
      await openChat(known.id);
      return;
    }
    /* подписка могла появиться на другом устройстве — сверяемся со списком */
    if (card.joined) {
      await loadChats();
      const joined = state.chats.find((c) => c.id === card.id);
      if (joined) {
        await openChat(joined.id);
        return;
      }
    }
    const chat = {
      id: card.id,
      type: 'channel',
      title: card.title,
      username: card.username,
      avatar: card.avatar || null,
      about: card.about || '',
      members: card.members || 0,
      role: null,
      ownerId: null,
      peer: null,
      preview: true,
      lastMessage: null,
      unread: 0,
    };
    state.chats = [chat, ...state.chats.filter((c) => !c.preview && c.id !== chat.id)];
    await openChat(chat.id);
  } catch (err) {
    toast(err.message);
  }
}

/* канал по юзернейму: открываем предпросмотр, подписка — отдельной кнопкой */
async function openChannelByUsername(username) {
  results.hidden = true;
  searchInput.value = '';
  try {
    const name = String(username || '').replace(/^@+/, '').toLowerCase();
    const known = state.chats.find((c) => c.type === 'channel' && c.username === name);
    if (known) {
      await openChat(known.id);
      return;
    }
    const info = await api(`/api/resolve?u=${encodeURIComponent(name)}`);
    if (info.type !== 'channel') return toast('Канал не найден');
    await openChannelCard(info.chat);
  } catch (err) {
    toast(err.message);
  }
}

/* подписка из предпросмотра: только теперь канал попадает в список чатов */
$('#ch-sub-btn').addEventListener('click', async () => {
  const chat = state.chats.find((c) => c.id === state.activeId);
  if (!chat?.preview || !chat.username) return;
  const btn = $('#ch-sub-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Подписываюсь…';
  try {
    const { chat: joined } = await api('/api/chats/join', {
      method: 'POST',
      body: JSON.stringify({ username: chat.username }),
    });
    state.chats = [joined, ...state.chats.filter((c) => c.id !== chat.id)];
    scheduleRenderChats();
    refreshActiveHeader();
    toast('Вы подписались на канал');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

/* переход по @упоминанию: человек → личный чат, канал → канал */
async function openMention(username) {
  try {
    const info = await api(`/api/resolve?u=${encodeURIComponent(username)}`);
    if (info.type === 'user') {
      if (info.user.id === state.me.id) return toast('Это ты');
      await startChat(info.user);
      return;
    }
    if (info.type === 'channel') {
      await openChannelByUsername(info.chat.username || username);
    }
  } catch (err) {
    toast(err.message);
  }
}

$('#messages').addEventListener('click', (e) => {
  const ref = e.target.closest?.('.mention');
  if (!ref) return;
  e.preventDefault();
  openMention(ref.dataset.username);
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!$('#app').hidden) searchInput.focus();
  }
  if (e.key === 'Escape') {
    if (!$('#lightbox').hidden) closeLightbox();
    else if (!attachMenu.hidden) closeAttach();
    else if (!newSheet.hidden) closeNewSheet();
    else if (!peerSheet.hidden) closePeerSheet();
    else if (!groupSheet.hidden) closeGroupSheet();
    else if (!usersPage.hidden) closeUsersPage();
    else if (!results.hidden) results.hidden = true;
    else if (!$('#sheet').hidden) {
      const view = $('#set-views .set-view.is-active');
      if (view && view.dataset.view !== 'main') setSettingsView('main');
      else closeProfile();
    }
  }
});

$('#btn-new').addEventListener('click', () => openNewSheet());
$('#btn-new-2').addEventListener('click', () => searchInput.focus());

/* --------------------------------------------------- новые чаты */

const newSheet = $('#sheet-new');
const groupSheet = $('#sheet-group');
let newType = 'group';
let pickedUsers = new Map();

function sheetOpen(el, open) {
  el.hidden = !open;
  const anyOpen = $$('.sheet').some((sheet) => !sheet.hidden);
  document.body.style.overflow = anyOpen ? 'hidden' : '';
}

function openNewSheet() {
  newType = 'group';
  pickedUsers = new Map();
  $$('#gc-type button').forEach((b) => b.classList.toggle('is-active', b.dataset.type === 'group'));
  $('#gc-name').value = '';
  $('#gc-username').value = '';
  $('#gc-username-field').hidden = true;
  $('#gc-hint').textContent = 'В группе пишут все участники.';
  $('#gc-search').value = '';
  $('#gc-results').hidden = true;
  $('#gc-results').innerHTML = '';
  $('#gc-picked').innerHTML = '';
  sheetOpen(newSheet, true);
  setTimeout(() => $('#gc-name').focus(), 60);
}

function closeNewSheet() { sheetOpen(newSheet, false); }

$('#btn-group').addEventListener('click', (e) => {
  e.stopPropagation();
  if (usersPage.hidden) openUsersPage();
  else closeUsersPage();
});
$('#users-back').addEventListener('click', closeUsersPage);
$$('[data-close-new]').forEach((el) => el.addEventListener('click', closeNewSheet));

$$('#gc-type button').forEach((b) => b.addEventListener('click', () => {
  newType = b.dataset.type;
  $$('#gc-type button').forEach((x) => x.classList.toggle('is-active', x === b));
  $('#gc-username-field').hidden = newType !== 'channel';
  if (newType === 'channel' && pickedUsers.size > 3) {
    const keep = [...pickedUsers.keys()].slice(0, 3);
    pickedUsers = new Map(keep.map((id) => [id, pickedUsers.get(id)]));
    renderPicked();
    toast('В канал можно добавить не больше 3 человек за раз');
  }
  $('#gc-hint').textContent = newType === 'channel'
    ? 'В канале пишут только админы, остальные читают. За раз — не больше 3 человек.'
    : 'В группе пишут все участники.';
}));

let gcTimer = null;
$('#gc-search').addEventListener('input', () => {
  clearTimeout(gcTimer);
  const q = $('#gc-search').value.trim();
  if (q.length < 2) { $('#gc-results').hidden = true; return; }
  gcTimer = setTimeout(() => searchForPicking(q, $('#gc-results'), (u) => addPicked(u)), 240);
});

async function searchForPicking(q, box, onPick, excludeIds = new Set()) {
  try {
    const { users } = await api(`/api/users?q=${encodeURIComponent(q)}`);
    box.innerHTML = '';
    const fresh = users.filter((u) => u.id !== state.me.id && !pickedUsers.has(u.id) && !excludeIds.has(u.id));
    if (!fresh.length) {
      const d = document.createElement('div');
      d.className = 'result-none';
      d.textContent = 'Никого не нашли';
      box.append(d);
    }
    for (const u of fresh) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'result';
      const av = document.createElement('span');
      avatarEl(av, u, 'av-sm');
      const meta = document.createElement('div');
      meta.className = 'result-name';
      meta.textContent = u.displayName;
      const nick = document.createElement('div');
      nick.className = 'result-nick';
      nick.textContent = '@' + u.username;
      const wrap = document.createElement('div');
      wrap.append(meta, nick);
      b.append(av, wrap);
      b.addEventListener('click', () => onPick(u));
      box.append(b);
    }
    box.hidden = false;
  } catch (err) {
    toast(err.message);
  }
}

function addPicked(u) {
  if (pickedUsers.has(u.id)) return;
  if (newType === 'channel' && pickedUsers.size >= 3) {
    return toast('В канал можно добавить не больше 3 человек за раз');
  }
  pickedUsers.set(u.id, u);
  $('#gc-results').hidden = true;
  $('#gc-search').value = '';
  renderPicked();
}

function renderPicked() {
  const box = $('#gc-picked');
  box.innerHTML = '';
  for (const u of pickedUsers.values()) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const name = document.createElement('span');
    name.textContent = u.displayName;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.textContent = '✕';
    x.addEventListener('click', () => { pickedUsers.delete(u.id); renderPicked(); });
    chip.append(name, x);
    box.append(chip);
  }
}

$('#gc-create').addEventListener('click', async () => {
  const title = $('#gc-name').value.trim();
  if (title.length < 2) return toast('Название от 2 символов');
  let username = null;
  if (newType === 'channel') {
    username = $('#gc-username').value.trim().replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      return toast('Юзернейм: 3–20 символов, латиница, цифры, _');
    }
    if (pickedUsers.size > 3) return toast('В канал можно добавить не больше 3 человек за раз');
  }
  const btn = $('#gc-create');
  btn.disabled = true;
  try {
    const { chat } = await api('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ title, type: newType, username, memberIds: [...pickedUsers.keys()] }),
    });
    closeNewSheet();
    state.chats.unshift(chat);
    scheduleRenderChats();
    await openChat(chat.id);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------ состав чата */

let groupChatId = null;

async function openGroupSheet(chatId) {
  groupChatId = chatId;
  let chat;
  let members;
  try {
    ({ chat, members } = await loadMembers(chatId));
  } catch (err) {
    return toast(err.message);
  }
  const isOwner = chat.role === 'owner';
  const noun = chat.type === 'channel' ? 'канал' : 'группу';
  const who = chat.type === 'channel' ? 'подписчиков' : 'участников';
  $('#g-danger').hidden = !isOwner;
  $('#g-confirm').hidden = true;
  $('#g-delete').hidden = false;
  $('#g-delete').textContent = chat.type === 'channel' ? 'Удалить канал' : 'Удалить группу';
  $('#g-leave').textContent = chat.type === 'channel' ? 'Покинуть канал' : 'Покинуть чат';
  $('#g-confirm-text').textContent = `Удалить ${noun} навсегда? Все сообщения и файлы исчезнут у ${who}.`;
  groupAvatar($('#g-avatar'), chat, 'av-xl');
  $('#g-name').textContent = chat.title;
  const canEdit = chat.role === 'owner' || chat.role === 'admin';
  const subs = chat.type === 'channel'
    ? `${members.length} ${plural(members.length, 'подписчик', 'подписчика', 'подписчиков')}`
    : `${members.length} ${plural(members.length, 'участник', 'участника', 'участников')}`;
  $('#g-sub').textContent = chat.type === 'channel'
    ? (chat.username ? `@${chat.username} · ${subs}` : (canEdit ? `юзернейм не задан · ${subs}` : subs))
    : subs;
  $('#g-about').textContent = chat.about || '';
  $('#g-about').hidden = !chat.about;
  $('#g-form').hidden = !canEdit;
  $('#g-username-field').hidden = chat.type !== 'channel';
  $('#g-username-input').value = chat.username ? '@' + chat.username : '';
  $('#g-title-input').value = chat.title;
  $('#g-about-input').value = chat.about || '';
  /* владелец и админ видят весь список; обычный подписчик — только владельца */
  const ownerOnly = chat.type === 'channel' && !canEdit;
  $('#g-members-section').classList.toggle('is-single', ownerOnly);
  $('#g-members-h').hidden = ownerOnly;
  $('#g-members-h').textContent = 'Участники';
  $('#g-add-btn').hidden = !canEdit;
  $('#g-add-wrap').hidden = true;
  $('#g-add-search').value = '';
  $('#g-add-results').hidden = true;
  renderMembers(chat, members);
  sheetOpen(groupSheet, true);
}

function closeGroupSheet() { sheetOpen(groupSheet, false); groupChatId = null; }
$$('[data-close-group]').forEach((el) => el.addEventListener('click', closeGroupSheet));

function renderMembers(chat, members) {
  const box = $('#g-members');
  box.innerHTML = '';
  const myRole = chat.role;
  const owner = members.find((m) => m.role === 'owner') || members.find((m) => m.id === chat.ownerId);
  const ownerOnly = chat.type === 'channel' && myRole !== 'owner' && myRole !== 'admin';
  const list = ownerOnly ? (owner ? [owner] : []) : members;
  for (const m of list) {
    const row = document.createElement('div');
    row.className = 'member';
    const main = document.createElement(m.id === state.me.id ? 'div' : 'button');
    main.className = 'm-main';
    if (main.tagName === 'BUTTON') {
      main.type = 'button';
      main.addEventListener('click', () => openUserSheet(m));
    }
    const av = document.createElement('span');
    avatarEl(av, m, 'av-sm');
    const body = document.createElement('span');
    body.className = 'm-body';
    const name = document.createElement('span');
    name.className = 'm-name';
    name.textContent = m.id === state.me.id ? `${m.displayName} · ты` : m.displayName;
    const isOwner = m.role === 'owner' || m.id === chat.ownerId;
    const roleEl = document.createElement('span');
    roleEl.className = 'm-role' + (isOwner || m.role !== 'member' ? ' admin' : '');
    roleEl.textContent = isOwner ? 'владелец' : m.role === 'admin' ? 'админ' : 'участник';
    body.append(name, roleEl);
    main.append(av, body);
    row.append(main);

    if (m.id !== state.me.id) {
      const canKick = !isOwner && (myRole === 'owner' || (myRole === 'admin' && m.role !== 'admin'));
      if (myRole === 'owner' && !isOwner) {
        const promo = document.createElement('button');
        promo.type = 'button';
        promo.className = 'm-act';
        promo.textContent = m.role === 'admin' ? 'снять' : 'админ';
        promo.addEventListener('click', async () => {
          await api(`/api/chats/${chat.id}/role`, { method: 'POST', body: JSON.stringify({ userId: m.id, role: m.role === 'admin' ? 'member' : 'admin' }) })
            .then(() => openGroupSheet(chat.id))
            .catch((e) => toast(e.message));
        });
        row.append(promo);
      }
      if (canKick) {
        const kick = document.createElement('button');
        kick.type = 'button';
        kick.className = 'kick m-act';
        kick.textContent = 'удалить';
        kick.addEventListener('click', async () => {
          await api(`/api/chats/${chat.id}/kick`, { method: 'POST', body: JSON.stringify({ userId: m.id }) })
            .then(() => openGroupSheet(chat.id))
            .catch((e) => toast(e.message));
        });
        row.append(kick);
      }
    }
    box.append(row);
  }
}

$('#g-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!groupChatId) return;
  const local = state.chats.find((c) => c.id === groupChatId);
  const payload = { title: $('#g-title-input').value, about: $('#g-about-input').value };
  if (local?.type === 'channel') {
    const username = $('#g-username-input').value.trim().replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      return toast('Юзернейм: 3–20 символов, латиница, цифры, _');
    }
    payload.username = username;
  }
  try {
    const { chat } = await api(`/api/chats/${groupChatId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    if (local) Object.assign(local, chat);
    scheduleRenderChats();
    if (state.activeId === groupChatId) {
      $('#peer-name').textContent = chat.title;
      groupAvatar($('#peer-avatar'), chat, 'av-sm');
      updateGroupStatus(chat);
    }
    toast('Сохранено');
    openGroupSheet(groupChatId);
  } catch (err) {
    toast(err.message);
  }
});

$('#g-add-btn').addEventListener('click', () => {
  const wrap = $('#g-add-wrap');
  wrap.hidden = !wrap.hidden;
  if (!wrap.hidden) setTimeout(() => $('#g-add-search').focus(), 50);
});

let gAddTimer = null;
$('#g-add-search').addEventListener('input', () => {
  clearTimeout(gAddTimer);
  const q = $('#g-add-search').value.trim();
  const box = $('#g-add-results');
  if (q.length < 2) { box.hidden = true; return; }
  gAddTimer = setTimeout(() => searchForPicking(q, box, async (u) => {
    try {
      await api(`/api/chats/${groupChatId}/members`, { method: 'POST', body: JSON.stringify({ userId: u.id }) });
      $('#g-add-search').value = '';
      box.hidden = true;
      openGroupSheet(groupChatId);
    } catch (err) {
      toast(err.message);
    }
  }, new Set((state.members.get(groupChatId) || []).map((m) => m.id))), 240);
});

$('#g-delete').addEventListener('click', () => {
  $('#g-delete').hidden = true;
  $('#g-confirm').hidden = false;
});

$('#g-delete-no').addEventListener('click', () => {
  $('#g-confirm').hidden = true;
  $('#g-delete').hidden = false;
});

$('#g-delete-yes').addEventListener('click', async () => {
  if (!groupChatId) return;
  const id = groupChatId;
  const chat = state.chats.find((c) => c.id === id);
  const label = chat?.type === 'channel' ? 'Канал удалён' : 'Группа удалена';
  const btn = $('#g-delete-yes');
  btn.disabled = true;
  try {
    await api(`/api/chats/${id}`, { method: 'DELETE' });
    closeGroupSheet();
    state.chats = state.chats.filter((c) => c.id !== id);
    state.messages.delete(id);
    scheduleRenderChats();
    if (state.activeId === id) {
      $('.shell').classList.remove('chat-open');
      state.activeId = null;
      $('#chat-body').hidden = true;
      $('#chat-empty').hidden = false;
    }
    toast(label);
    loadChats().catch(() => {});
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#g-leave').addEventListener('click', async () => {
  if (!groupChatId) return;
  try {
    await api(`/api/chats/${groupChatId}/leave`, { method: 'POST' });
    const id = groupChatId;
    const isChannel = state.chats.find((c) => c.id === id)?.type === 'channel';
    closeGroupSheet();
    state.chats = state.chats.filter((c) => c.id !== id);
    state.messages.delete(id);
    scheduleRenderChats();
    if (state.activeId === id) {
      $('.shell').classList.remove('chat-open');
      state.activeId = null;
      $('#chat-body').hidden = true;
      $('#chat-empty').hidden = false;
    }
    toast(isChannel ? 'Вышел из канала' : 'Вышел из чата');
  } catch (err) {
    toast(err.message);
  }
});

$('#btn-peer').addEventListener('click', () => {
  const chat = state.chats.find((c) => c.id === state.activeId);
  if (!chat) return;
  if (chat.type === 'dm') return openPeerSheet(chat);
  openGroupSheet(chat.id);
});

/* профиль собеседника в личном чате */
const peerSheet = $('#sheet-peer');

function openPeerSheet(chat) {
  const peer = chat.peer || state.peers.get(chat.id);
  if (!peer) return;
  state.peerSheetId = chat.id;
  state.peerSheetUser = null;
  paintPeerSheet(peer);
  sheetOpen(peerSheet, true);
}

function openUserSheet(user) {
  if (!user || user.id === state.me?.id) return;
  state.peerSheetId = null;
  state.peerSheetUser = user;
  paintPeerSheet(user);
  sheetOpen(peerSheet, true);
}

function paintPeerSheet(peer) {
  avatarEl($('#p-avatar'), peer, 'av-xl');
  $('#p-name').textContent = peer.displayName || peer.username;
  $('#p-nick').textContent = '@' + peer.username;
  const bio = (peer.bio || '').trim();
  $('#p-bio').textContent = bio || 'Без описания';
  $('#p-bio').classList.toggle('is-empty', !bio);
  setPeerSheetStatus(peer);
  /* «Написать» есть всегда, кроме профиля, открытого из чата
     с этим человеком: там поле ввода и так под рукой */
  $('#p-chat').hidden = !!state.peerSheetId;
  fingerprint(peer.pubKey).then((f) => {
    $('#p-enc').textContent = f === '—' ? 'у собеседника нет ключа' : `ключ: ${f}`;
  });
}

/* из профиля — сразу в личный чат */
$('#p-chat').addEventListener('click', () => {
  const user = state.peerSheetUser || state.peers.get(state.peerSheetId);
  if (!user) return;
  /* свой профиль в предпросмотре: кнопка есть, но по нажатию ничего не делаем */
  if (state.me && user.id === state.me.id) return;
  closePeerSheet();
  if (!groupSheet.hidden) closeGroupSheet();
  startChat(user);
});

/* глазик на экране «Профиль» — показать себя так, как видят другие */
$('#set-eye').addEventListener('click', () => {
  const me = state.me;
  if (!me) return;
  const preview = {
    ...me,
    displayName: ($('#pf-name-input').value || '').trim() || me.displayName,
    bio: $('#pf-bio-input').value.trim(),
  };
  state.peerSheetId = null;
  state.peerSheetUser = preview;
  paintPeerSheet(preview);
  sheetOpen(peerSheet, true);
});

function closePeerSheet() {
  state.peerSheetId = null;
  state.peerSheetUser = null;
  sheetOpen(peerSheet, false);
}
$$('[data-close-peer]').forEach((el) => el.addEventListener('click', closePeerSheet));

/* ------------------------------------------------------------- профиль */

const SET_TITLES = {
  main: 'Настройки',
  profile: 'Профиль',
  notifications: 'Уведомления',
  theme: 'Оформление',
  storage: 'Хранилище',
  crypto: 'Шифрование',
  password: 'Пароль',
  devices: 'Устройства',
};

function setSettingsView(view = 'main') {
  const views = $('#set-views');
  if (!views) return;
  if (!views.querySelector(`.set-view[data-view="${view}"]`)) view = 'main';
  for (const section of $$('#set-views .set-view')) {
    section.classList.toggle('is-active', section.dataset.view === view);
  }
  const back = $('#set-back');
  if (back) back.hidden = view === 'main';
  /* глазик «как видят другие» — только на экране «Профиль» */
  const eye = $('#set-eye');
  if (eye) eye.hidden = view !== 'profile';
  const title = $('#set-title');
  if (title) title.textContent = SET_TITLES[view] || SET_TITLES.main;
  if (view === 'notifications') {
    renderNotifications();
    loadNotifications();
  }
  if (view === 'crypto') loadCryptoMeta();
  const scroller = views.querySelector(`.set-view[data-view="${view}"] .set-scroll`);
  if (scroller) scroller.scrollTop = 0;
}

/* хэш клиента и ссылка на коммит — чтобы можно было сверить с GitHub */
async function loadCryptoMeta() {
  const el = $('#crypto-meta');
  if (!el) return;
  try {
    const res = await fetch('/client.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('no meta');
    const m = await res.json();
    if (!m?.sha256 || !m?.commit) throw new Error('bad meta');
    const version = m.version ? ` ${m.version}` : '';
    el.textContent = `app.js${version} · sha256 ${String(m.sha256).slice(0, 12)}… · `;
    const link = document.createElement('a');
    link.href = m.commitUrl || `https://github.com/PapuzCorporation/PAPUZ/commit/${m.commit}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `коммит ${String(m.commit).slice(0, 7)}`;
    el.append(link);
    el.hidden = false;
  } catch {
    el.hidden = true;
  }
}

function fillProfile() {
  const me = state.me;
  if (!me) return;
  avatarEl($('#pf-avatar'), me, 'av-lg');
  if ($('#pf-avatar-edit')) avatarEl($('#pf-avatar-edit'), me, 'av-xl');
  avatarEl($('#me-avatar'), me, 'av-sm');
  $('#pf-name').textContent = me.displayName;
  $('#pf-nick').textContent = '@' + me.username;
  $('#pf-name-input').value = me.displayName;
  $('#pf-bio-input').value = me.bio || '';
  const s = state.stats || { chats: 0, messages: 0, days: 1 };
  $('#pf-chats').textContent = s.chats;
  $('#pf-msgs').textContent = s.messages;
  $('#pf-days').textContent = s.days;
  $('#pf-days').nextElementSibling.textContent = plural(s.days, 'день', 'дня', 'дней');
  const st = state.storage;
  if (st) {
    const pct = Math.min(100, Math.round((st.used / st.quota) * 1000) / 10);
    $('#pf-storage-text').textContent = `${human(st.used)} из ${human(st.quota)} занято`;
    $('#pf-storage-fill').style.width = `${Math.max(pct, st.used ? 2 : 0)}%`;
    const sub = $('#set-storage-sub');
    if (sub) sub.textContent = `${human(st.used)} из ${human(st.quota)}`;
  }
  fingerprint(me.pubKey).then((f) => { $('#pf-key').textContent = `ключ: ${f}`; });
}

function human(bytes) {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
}

async function refreshStats() {
  try {
    const data = await api('/api/me');
    if (data.user) {
      state.me = data.user;
      state.stats = data.stats;
      state.storage = data.storage;
    }
  } catch { /* не критично */ }
}

function openProfile() {
  setSettingsView('main');
  fillProfile();
  refreshStats().then(fillProfile);
  loadDevices();
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeProfile() {
  const wasOpen = !$('#sheet').hidden;
  $('#sheet').hidden = true;
  setSettingsView('main');
  document.body.style.overflow = '';
  if (wasOpen && state.activeId === null) requestAnimationFrame(replayChatsIntro);
}

$('#btn-me').addEventListener('click', openProfile);
$$('[data-close]').forEach((el) => el.addEventListener('click', closeProfile));
$$('[data-open-view]').forEach((el) => {
  el.addEventListener('click', () => setSettingsView(el.dataset.openView));
});
$('#set-back').addEventListener('click', () => setSettingsView('main'));

/* ------------------------------------------------------- уведомления */

const NOTIFY_CATEGORIES = ['quiet', 'dm', 'groups', 'channels'];

function setSwitch(el, on) {
  el?.classList.toggle('on', !!on);
}

function notifyCategory(chat) {
  return chat.type === 'dm' ? 'dm' : chat.type === 'channel' ? 'channels' : 'groups';
}

/* почему уведомления из чата выключены, даже если сам чат не трогали */
function notifyBlockReason(chat) {
  const s = state.notify?.settings;
  if (!s || !chat) return null;
  if (s.quiet) return 'quiet';
  if (!s[notifyCategory(chat)]) return 'category';
  return null;
}

function notifySummary() {
  const n = state.notify;
  if (!n) return 'Telegram';
  if (!n.telegram?.active) return 'Telegram не привязан';
  if (n.settings?.quiet) return 'Беззвучный режим';
  return n.telegram.username ? `@${n.telegram.username}` : 'Telegram привязан';
}

function renderNotifications() {
  const n = state.notify;
  const sub = $('#set-notify-sub');
  if (sub) sub.textContent = notifySummary();
  if (!n) return;

  const linked = !!n.telegram?.active;
  const s = n.settings || { quiet: false, dm: true, groups: true, channels: true };
  if (state.notifyCode && state.notifyCode.expiresAt <= Date.now()) {
    state.notifyCode = null;
    clearInterval(state.notifyPoll);
    state.notifyPoll = null;
  }

  const status = $('#notify-link-status');
  status.textContent = linked
    ? (n.telegram.username ? `@${n.telegram.username}` : 'Привязан')
    : 'Не привязан';
  status.classList.toggle('on', linked);
  setSwitch($('#notify-link-switch'), linked);

  const card = $('#btn-notify-link');
  card.setAttribute('aria-label', linked ? 'Отвязать Telegram' : 'Привязать Telegram');
  $('#notify-body').hidden = !linked;

  const categoriesDisabled = !!s.quiet;
  $('#notify-categories-title')?.classList.toggle('is-disabled', categoriesDisabled);

  for (const key of NOTIFY_CATEGORIES) {
    const row = $(`#notify-${key}-row`);
    const on = !!s[key];
    if (row) {
      row.setAttribute('aria-checked', String(on));
      /* сам беззвучный режим не тускнеет, когда выключен */
      row.classList.toggle('is-off', key !== 'quiet' && !on);
      if (key !== 'quiet') {
        row.disabled = categoriesDisabled;
        row.classList.toggle('is-disabled', categoriesDisabled);
      }
    }
    setSwitch($(`#notify-${key}-switch`), on);
  }
  syncChatNotify();
}

async function loadNotifications({ quiet = true } = {}) {
  try {
    state.notify = await api('/api/me/notifications');
    if (state.notify.telegram?.active) {
      state.notifyCode = null;
      clearInterval(state.notifyPoll);
      state.notifyPoll = null;
    }
    renderNotifications();
    if (state.notifyCode) startNotifyPoll();
    return state.notify;
  } catch (err) {
    if (!quiet) toast(err.message);
  }
}

function startNotifyPoll() {
  if (state.notifyPoll) return;
  let tries = 0;
  state.notifyPoll = setInterval(() => {
    tries += 1;
    if (tries > 40 || !state.notifyCode) {
      clearInterval(state.notifyPoll);
      state.notifyPoll = null;
      return;
    }
    loadNotifications();
  }, 3000);
}

async function saveNotify(patch) {
  if (!state.notify) return;
  const before = { ...state.notify.settings };
  Object.assign(state.notify.settings, patch);
  renderNotifications();
  try {
    const { settings } = await api('/api/me/notifications', {
      method: 'POST',
      body: JSON.stringify(patch),
    });
    state.notify.settings = settings;
    renderNotifications();
  } catch (err) {
    state.notify.settings = before;
    renderNotifications();
    toast(err.message);
  }
}

for (const key of NOTIFY_CATEGORIES) {
  $(`#notify-${key}-row`)?.addEventListener('click', () => {
    if (!state.notify) return;
    saveNotify({ [key]: !state.notify.settings[key] });
  });
}

/* тап по карточке: привязать (открыть бота) или сразу отвязать */
$('#btn-notify-link').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled) return;

  if (state.notify?.telegram?.active) {
    btn.disabled = true;
    try {
      await api('/api/me/telegram/unlink', { method: 'POST' });
      state.notify = { ...(state.notify || {}), telegram: null };
      state.notifyCode = null;
      clearInterval(state.notifyPoll);
      state.notifyPoll = null;
      renderNotifications();
      toast('Telegram отвязан');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (state.notifyCode && state.notifyCode.expiresAt > Date.now()) {
    location.href = state.notifyCode.url;
    return;
  }

  btn.disabled = true;
  try {
    const data = await api('/api/me/telegram/link', { method: 'POST' });
    state.notifyCode = {
      code: data.code,
      url: data.url,
      expiresAt: Number(data.expiresAt) || Date.now() + 10 * 60 * 1000,
    };
    if (!state.notify) {
      state.notify = {
        bot: data.bot,
        telegram: null,
        settings: { quiet: false, dm: true, groups: true, channels: true },
      };
    }
    renderNotifications();
    startNotifyPoll();
    location.href = data.url;
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

/* вернулись из Telegram — сразу проверяем, привязался ли бот */
function refreshNotificationsIfOpen() {
  const view = $('#set-views .set-view[data-view="notifications"]');
  if (!state.notifyCode && !view?.classList.contains('is-active')) return;
  loadNotifications();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshNotificationsIfOpen();
});
window.addEventListener('focus', refreshNotificationsIfOpen);

/* -------------------------------------------- меню в шапке чата */

const chatMore = $('#chat-more');

function closeChatMore() {
  if (!chatMore || chatMore.hidden) return;
  chatMore.hidden = true;
  $('#btn-chat-more').setAttribute('aria-expanded', 'false');
}

function openChatMore() {
  const chat = state.chats.find((c) => c.id === state.activeId);
  if (!chat) return;
  syncChatNotify();
  chatMore.hidden = false;
  $('#btn-chat-more').setAttribute('aria-expanded', 'true');
}

function syncChatNotify() {
  const chat = state.chats.find((c) => c.id === state.activeId);
  const row = $('#chat-notify-toggle');
  if (!chat || !row) return;

  const linked = !!state.notify?.telegram?.active;
  const reason = notifyBlockReason(chat);
  const on = linked && chat.notify !== false && !reason;
  const title = $('#chat-notify-title');
  const sub = $('#chat-notify-sub');

  if (!linked) {
    title.textContent = 'Telegram не привязан';
    sub.textContent = 'Нажми, чтобы привязать бота';
  } else if (reason === 'quiet') {
    title.textContent = 'Беззвучный режим';
    sub.textContent = 'Сейчас не приходит ничего';
  } else if (reason === 'category') {
    const kind = chat.type === 'dm' ? 'Личные' : chat.type === 'channel' ? 'Каналы' : 'Группы';
    title.textContent = 'Уведомления выключены';
    sub.textContent = `${kind} выключены в настройках`;
  } else {
    title.textContent = on ? 'Уведомления включены' : 'Уведомления выключены';
    sub.textContent = on
      ? 'Присылать в Telegram, когда меня нет в сети'
      : 'Не присылать ничего из этого чата';
  }

  row.setAttribute('aria-checked', String(on));
  row.classList.toggle('is-off', !on);
  setSwitch($('#chat-notify-switch'), on);
}

function openNotifySettings() {
  closeChatMore();
  openProfile();
  setSettingsView('notifications');
}

$('#btn-chat-more').addEventListener('click', (e) => {
  e.stopPropagation();
  if (chatMore.hidden) openChatMore();
  else closeChatMore();
});

$('#chat-notify-toggle').addEventListener('click', async () => {
  const chat = state.chats.find((c) => c.id === state.activeId);
  if (!chat) return;
  if (!state.notify?.telegram?.active || notifyBlockReason(chat)) return openNotifySettings();

  const next = chat.notify === false;
  chat.notify = next;
  syncChatNotify();
  try {
    await api(`/api/chats/${chat.id}/notifications`, {
      method: 'POST',
      body: JSON.stringify({ enabled: next }),
    });
    toast(next ? 'Уведомления включены' : 'Больше не присылаю');
  } catch (err) {
    chat.notify = !next;
    syncChatNotify();
    toast(err.message);
  }
});

document.addEventListener('click', (e) => {
  if (chatMore.hidden) return;
  if (chatMore.contains(e.target) || $('#btn-chat-more').contains(e.target)) return;
  closeChatMore();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeChatMore();
});

$('#pf-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({
        displayName: $('#pf-name-input').value,
        bio: $('#pf-bio-input').value,
      }),
    });
    state.me = user;
    fillProfile();
    toast('Сохранено');
  } catch (err) { toast(err.message); }
});

/* --------------------------------------------------------- смена пароля */

$('#pass-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const oldP = $('#pass-old').value;
  const newP = $('#pass-new').value;
  const newP2 = $('#pass-new2').value;
  if (newP.length < 8) return toast('Новый пароль — от 8 символов');
  if (newP !== newP2) return toast('Пароли не совпадают');
  if (!state.priv) return toast('Ключи не загружены — войди заново');
  const btn = $('#pass-submit');
  btn.disabled = true;
  btn.textContent = 'Переворачиваю ключ…';
  try {
    /* state.priv теперь non-extractable: берём завёрнутый ключ с сервера
       и распаковываем его старым паролем, который человек только что ввёл */
    const { keys } = await api('/api/keys/self');
    if (!keys) throw new Error('Ключи шифрования не найдены');
    const oldKey = await K.unwrapIdentity(keys.encPriv, keys.kdfSalt, keys.kdfIter, oldP);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', oldKey);
    const wrapped = await K.wrapPrivateBytes(new Uint8Array(pkcs8), newP);
    await api('/api/me/password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: oldP, newPassword: newP, ...wrapped }),
    });
    localStorage.removeItem(STORE(state.me.id));
    state.priv = oldKey;
    await savePriv(state.priv);
    $('#pass-form').reset();
    toast('Пароль обновлён, другие устройства вышли');
    loadDevices();
  } catch (err) {
    toast(err.name === 'OperationError' || /decrypt/i.test(err.message)
      ? 'Старый пароль не подошёл к ключам шифрования'
      : err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Обновить пароль';
  }
});

/* ----------------------------------------------------------- устройства */

async function loadDevices() {
  const box = $('#devices');
  const sub = $('#set-devices-sub');
  if (sub) sub.textContent = 'Загружаю…';
  try {
    const { sessions } = await api('/api/me/sessions');
    if (sub) {
      sub.textContent = `${sessions.length} ${plural(sessions.length, 'устройство', 'устройства', 'устройств')}`;
    }
    box.innerHTML = '';
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'device';
      const body = document.createElement('div');
      body.className = 'device-body';
      const name = document.createElement('div');
      name.className = 'device-name';
      name.textContent = s.device;
      const meta = document.createElement('div');
      meta.className = 'device-meta';
      meta.textContent = s.current ? 'это устройство' : `активность ${relTime(s.lastUsed)}`;
      body.append(name, meta);
      row.append(body);
      if (s.current) {
        const now = document.createElement('span');
        now.className = 'device-now';
        now.textContent = 'сейчас';
        row.append(now);
      } else {
        const kick = document.createElement('button');
        kick.className = 'device-kick';
        kick.textContent = 'выйти';
        kick.addEventListener('click', async () => {
          await api('/api/me/sessions/revoke', { method: 'POST', body: JSON.stringify({ id: s.id }) });
          loadDevices();
        });
        row.append(kick);
      }
      box.append(row);
    }
  } catch (err) {
    if (sub) sub.textContent = 'Не удалось загрузить';
    box.innerHTML = '';
    const p = document.createElement('div');
    p.className = 'pf-p small';
    p.textContent = err.message;
    box.append(p);
  }
}

$('#btn-revoke-all').addEventListener('click', async () => {
  await api('/api/me/sessions/revoke', { method: 'POST', body: JSON.stringify({ all: true }) });
  toast('Остальные устройства вышли');
  loadDevices();
});

/* -------------------------------------------------------------- аватар */

async function compressAvatar(file) {
  let img;
  try {
    img = await createImageBitmap(file);
  } catch {
    throw new Error('Не удалось прочитать картинку');
  }
  const size = 720;
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  img.close?.();
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.86));
}

$('#av-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) return toast('Файл слишком большой');
  const t = toast('Сжимаю…', 6000);
  try {
    const blob = await compressAvatar(file);
    if (!blob) throw new Error('Не получилось сжать');
    const { avatar } = await api('/api/me/avatar', {
      method: 'PUT',
      body: blob,
      headers: { 'content-type': 'image/jpeg' },
    });
    state.me.avatar = avatar;
    fillProfile();
    clearTimeout(t);
    toast('Аватар обновлён');
  } catch (err) {
    clearTimeout(t);
    toast(err.message);
  }
});

/* ------------------------------------------------------------ выход */

function resetClientState() {
  const ws = state.ws;
  state.ws = null;
  try { ws?.close(); } catch { /* уже закрыт */ }
  closeProfile();
  state.me = null;
  state.priv = null;
  state.chats = [];
  state.messages.clear();
  state.peers.clear();
  state.presenceSnapshot.clear();
  state.chatKeys.clear();
  state.plain.clear();
  state.preview.clear();
  state.members.clear();
  closeNewSheet();
  closeGroupSheet();
  closeUsersPage();
  for (const url of state.blobs.values()) URL.revokeObjectURL(url);
  state.blobs.clear();
  state.rawBlobs.clear();
  state.activeId = null;
  state.wsRetry = 0;
}

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  resetClientState();
  showAuth();
});

/* ----------------------------------------------------------- websocket */

/* активность: серверу нужно знать, что человек реально пользуется сайтом.
   Иначе фоновая вкладка считается «в сети» и Telegram-уведомления не приходят.
   Сам статус ожидания больше нигде не показываем. */
let lastActivityAt = 0;
function reportActivity(force = false) {
  if (!state.me) return;
  const ws = state.ws;
  if (!ws || ws.readyState !== 1) return;
  const t = Date.now();
  if (!force && t - lastActivityAt < 5000) return;
  lastActivityAt = t;
  try { ws.send(JSON.stringify({ type: 'activity' })); } catch { /* сокет уже закрылся */ }
}
for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'touchmove']) {
  window.addEventListener(ev, () => reportActivity(), { passive: true });
}
document.addEventListener('scroll', () => reportActivity(), { capture: true, passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) reportActivity(true); });
window.addEventListener('focus', () => reportActivity(true));

function connectWs() {
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    const reconnect = state.wsRetry > 0;
    state.wsRetry = 0;
    setConn(true);
    /* при первом входе список уже грузится из showApp — не дублируем */
    if (reconnect) loadChats().catch(() => {});
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'chats') {
      loadChats().catch(() => {});
      return;
    }

    if (msg.type === 'message') {
      const m = normalizeMessage(msg.message);
      if (!m || !m.chatId) return;
      if (!state.messages.has(m.chatId)) {
        loadChats().catch(() => {});
        return;
      }
      appendMessage(m.chatId, m).then(() => {
        const chat = state.chats.find((c) => c.id === m.chatId);
        if (!chat) return;
        /* служебные сообщения о составе канала не трогают превью и не поднимают чат */
        if (chat.type === 'channel' && isChannelMemberNotice(m)) return;
        chat.lastMessage = {
          id: m.id, body: m.body, at: m.at, mine: isMine(m),
          media: m.media?.[0]?.kind || null,
        };
        if (m.chatId !== state.activeId && !isMine(m)) chat.unread = (chat.unread || 0) + 1;
        state.chats = [chat, ...state.chats.filter((c) => c.id !== m.chatId)];
        scheduleRenderChats();
        if (m.chatId === state.activeId) markRead(m.chatId);
      });
    }

    if (msg.type === 'read') {
      const chat = state.chats.find((c) => c.id === msg.chatId);
      if (chat && msg.userId !== state.me.id) {
        chat.peerRead = Math.max(chat.peerRead || 0, Number(msg.id) || 0);
        updateTicks(msg.chatId);
      }
      return;
    }

    if (msg.type === 'presence') {
      rememberPresence(msg.userId, msg);
      for (const [, peer] of state.peers) {
        if (peer.id === msg.userId) applyPresence(peer, msg);
      }
      const peer = state.peers.get(state.activeId);
      if (peer && peer.id === msg.userId) {
        setPeerStatus(peer);
        if (!$('#sheet-peer').hidden) setPeerSheetStatus(peer);
      }
      const shown = state.peerSheetUser;
      if (shown && shown.id === msg.userId) {
        applyPresence(shown, msg);
        setPeerSheetStatus(shown);
      }
      scheduleRenderChats();
      return;
    }

    if (msg.type === 'presence-snapshot' && Array.isArray(msg.users)) {
      state.presenceSnapshot = new Map();
      for (const s of msg.users) rememberPresence(s.userId, s);
      applyStoredPresence();
      scheduleRenderChats();
      return;
    }

    if (msg.type === 'profile' && msg.user) {
      applyProfile(msg.user);
      return;
    }

    if (msg.type === 'typing' && msg.chatId === state.activeId && msg.userId !== state.me.id
        && state.chats.find((c) => c.id === msg.chatId)?.type !== 'channel') {
      const el = $('#typing');
      el.hidden = false;
      el.classList.add('on');
      clearTimeout(state.typingTimers.get('show'));
      state.typingTimers.set('show', setTimeout(() => {
        el.classList.remove('on');
        el.hidden = true;
      }, 2600));
    }
  });

  ws.addEventListener('close', (ev) => {
    setConn(false);
    if (!state.me) return;
    /* 4001 — сессию отозвали (выход, смена пароля, «выйти на всех»). */
    if (ev.code === 4001) {
      resetClientState();
      showAuth();
      toast('Сессия завершена. Войди снова.');
      return;
    }
    state.wsRetry = Math.min(state.wsRetry + 1, 6);
    setTimeout(connectWs, 800 * state.wsRetry);
  });

  ws.addEventListener('error', () => ws.close());
}

function setConn(ok) {
  $('.pulse-dot').classList.toggle('off', !ok);
  $('#conn-state').textContent = ok ? 'подключено' : 'связь потеряна…';
}

/* сессия одна на браузер: если в другой вкладке вошли другим аккаунтом — перезагружаемся */
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !state.me) return;
  try {
    const data = await api('/api/me');
    if (!data.user || data.user.id !== state.me.id) location.reload();
  } catch { /* сеть недоступна — не трогаем */ }
});

/* -------------------------------------------------------------- эмодзи */

const EMOJI_OPTS = {
  base: '/emoji/',
  folder: 'svg',
  ext: '.svg',
  className: 'emoji',
  attributes: () => ({ draggable: 'false' }),
};

function paintEmoji(root) {
  if (!window.twemoji || !root) return;
  try { window.twemoji.parse(root, EMOJI_OPTS); } catch { /* не критично */ }
}

/* в поля ввода и служебные блоки не лезем: там текст должен остаться текстом */
const EMOJI_SKIP = 'textarea,input,script,style,select,iframe,noscript,pre,code,[contenteditable="true"]';

function emojiAllowed(node) {
  if (!node || node.nodeType !== 1) return false;
  try { return !node.closest(EMOJI_SKIP); } catch { return false; }
}

const emojiPending = new Set();
let emojiQueued = false;

function queueEmoji(node) {
  if (!emojiAllowed(node)) return;
  emojiPending.add(node);
  if (emojiQueued) return;
  emojiQueued = true;
  requestAnimationFrame(() => {
    emojiQueued = false;
    const list = [...emojiPending];
    emojiPending.clear();
    for (const n of list) {
      if (!n.isConnected || !emojiAllowed(n)) continue;
      if (n.matches('img.emoji')) continue;
      paintEmoji(n);
    }
  });
}

function watchEmoji() {
  paintEmoji(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') {
        queueEmoji(r.target.parentNode);
        continue;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType === 3) queueEmoji(n.parentNode);
        else if (n.nodeType === 1) queueEmoji(n);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}

watchEmoji();

/* ------------------------------------------------------ размер окна */

/* В мобильных браузерах адресная строка то прячется, то появляется, и
   нижняя панель ввода уезжает за край. Держим каркас ровно по видимой
   области (visualViewport), а не по layout viewport. */
function syncViewportBox() {
  const vv = window.visualViewport;
  /* при сильном зуме не сжимаем интерфейс — даём браузеру приблизить страницу */
  if (vv && vv.scale > 1.01) return;
  const root = document.documentElement;
  const top = vv ? Math.round(vv.offsetTop) : 0;
  const height = vv ? Math.round(vv.height) : window.innerHeight;
  const stamp = `${top}:${height}`;
  if (root.dataset.viewport === stamp) return;
  root.dataset.viewport = stamp;
  root.style.setProperty('--app-top', top + 'px');
  root.style.setProperty('--app-h', height + 'px');
}
let viewportRaf = 0;
function queueViewportSync() {
  if (viewportRaf) return;
  viewportRaf = requestAnimationFrame(() => {
    viewportRaf = 0;
    syncViewportBox();
  });
}
syncViewportBox();
window.addEventListener('resize', queueViewportSync);
window.addEventListener('orientationchange', () => setTimeout(syncViewportBox, 250));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', queueViewportSync);
  window.visualViewport.addEventListener('scroll', queueViewportSync);
}

/* --------------------------------------------------------------- старт */

(async function boot() {
  try {
    const data = await api('/api/me');
    if (!data.user) return showAuth();
    state.me = data.user;
    state.stats = data.stats;
    state.priv = await loadPriv(data.user.id);
    if (!state.priv) {
      // ключей на этом устройстве нет — нужен пароль
      showAuth();
      $('#f-username').value = data.user.username;
      const err = $('#auth-error');
      err.textContent = 'Ключи шифрования не найдены на этом устройстве — войди заново';
      err.classList.add('show');
      return;
    }
    showApp();
  } catch {
    showAuth();
  }
})();
