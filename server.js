'use strict';
/*
 * Obito Gaming — сайт для серверов Counter-Strike 1.6
 * Без внешних зависимостей. Нужен Node.js 22.13 или новее.
 * Запуск: node server.js   (по умолчанию http://localhost:3000)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const POLL_MS = Number(process.env.POLL_MS || 20000);
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'site.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', balance INTEGER NOT NULL DEFAULT 0,
  game_nick TEXT NOT NULL DEFAULT '', steam_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'Public', ip TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 27015, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, seconds INTEGER NOT NULL DEFAULT 0,
  frags INTEGER NOT NULL DEFAULT 0, visits INTEGER NOT NULL DEFAULT 0, first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL, last_server_id INTEGER);
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, tag TEXT NOT NULL DEFAULT 'Новость', body TEXT NOT NULL,
  created_at INTEGER NOT NULL, author_id INTEGER);
CREATE TABLE IF NOT EXISTS news_comments (
  id INTEGER PRIMARY KEY, news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS forum_cats (id INTEGER PRIMARY KEY, title TEXT NOT NULL, descr TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY, cat_id INTEGER NOT NULL REFERENCES forum_cats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_post_at INTEGER NOT NULL, views INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bans (
  id INTEGER PRIMARY KEY, nick TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
  admin_name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, descr TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 30, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_name TEXT NOT NULL,
  price INTEGER NOT NULL, days INTEGER NOT NULL DEFAULT 0, game_nick TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS topups (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
  created_at INTEGER NOT NULL, is_read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_topics_cat ON topics(cat_id, pinned DESC, last_post_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_topic ON posts(topic_id, id);
`);

/* ------------------------------------------------------------------ utils */
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = (s) => esc(s).split(/\n{2,}/).map((p) => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const icon = (id) => `<svg class="i"><use href="#${id}"/></svg>`;

/* ----------------------------------------------------------- миграции БД */
function ensureColumns(table, spec) {
  const have = new Set(all(`PRAGMA table_info(${table})`).map((c) => c.name));
  for (const [name, ddl] of spec) if (!have.has(name)) run(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
ensureColumns('users', [
  ['rank', "TEXT NOT NULL DEFAULT 'player'"],
  ['telegram', "TEXT NOT NULL DEFAULT ''"],
  ['login_fails', 'INTEGER NOT NULL DEFAULT 0'],
  ['lock_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['locked_until', 'INTEGER NOT NULL DEFAULT 0'],
  ['ban_until', 'INTEGER'],
  ['ban_reason', "TEXT NOT NULL DEFAULT ''"],
  ['donated', 'INTEGER NOT NULL DEFAULT 0'],
]);
ensureColumns('products', [['color', "TEXT NOT NULL DEFAULT ''"], ['prefix', "TEXT NOT NULL DEFAULT ''"]]);
ensureColumns('orders', [['product_id', 'INTEGER']]);
ensureColumns('sessions', [['last_seen', 'INTEGER NOT NULL DEFAULT 0']]);
ensureColumns('users', [['avatar', "TEXT NOT NULL DEFAULT ''"]]);
db.exec(`
CREATE TABLE IF NOT EXISTS user_privs (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER, name TEXT NOT NULL, prefix TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '',
  days INTEGER NOT NULL DEFAULT 30, expires_at INTEGER, granted_by INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS friends (
  id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL, UNIQUE(from_id, to_id));
CREATE TABLE IF NOT EXISTS pms (
  id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL,
  created_at INTEGER NOT NULL, read_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_user_privs ON user_privs(user_id);
CREATE INDEX IF NOT EXISTS idx_friends_to ON friends(to_id, status);
CREATE INDEX IF NOT EXISTS idx_pms_to ON pms(to_id, read_at);
`);
// старые роли превращаем в ранги: первый админ — Создатель
if (one("SELECT COUNT(*) c FROM users WHERE role='admin' AND rank<>'admin' AND rank<>'deputy'").c) {
  const first = one("SELECT MIN(id) id FROM users WHERE role='admin'").id;
  run("UPDATE users SET rank='creator' WHERE role='admin' AND id=?", first);
  run("UPDATE users SET rank='admin' WHERE role='admin' AND rank='player'");
}
run("UPDATE users SET rank='player' WHERE rank IS NULL OR rank NOT IN ('creator','deputy','admin','moderator','player')");
run("UPDATE users SET donated=IFNULL((SELECT SUM(t.amount) FROM topups t WHERE t.user_id=users.id AND t.status='paid'),0)");

const DEFAULTS = {
  site_name: 'OBITO GAMING',
  tagline_1: 'Лучшие серверы · Активные игроки',
  tagline_2: 'Присоединяйся к нам!',
  currency: 'сум',
  tz: 'Asia/Tashkent',
  topup_text: 'Укажите сумму, переведите её на карту ниже и в комментарии к переводу напишите свой логин на сайте. Баланс будет зачислен после проверки перевода.',
  contact_email: '', contact_telegram: '', contact_discord: '', contact_vk: '', link_youtube: '',
  card_number: '', card_holder: '', card_bank: '', topup_min: '100', topup_max: '999999',
  footer_quote: '«Настоящие легенды не рождаются, они становятся…»',
};
let settingsCache = null;
const S = (k) => {
  if (!settingsCache) { settingsCache = { ...DEFAULTS }; for (const r of all('SELECT key, value FROM settings')) settingsCache[r.key] = r.value; }
  return settingsCache[k] ?? '';
};
const saveSetting = (k, v) => { run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v); settingsCache = null; };

function fmtDate(ts, withTime = true) {
  if (!ts) return '—';
  const o = { timeZone: S('tz') || 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' };
  if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; o.hour12 = false; }
  try { return new Intl.DateTimeFormat('ru-RU', o).format(new Date(ts * 1000)).replace(',', ''); } catch { return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' '); }
}
function fmtHours(sec) {
  if (sec < 3600) return Math.floor(sec / 60) + ' мин.';
  return (sec / 3600).toFixed(1).replace(/\.0$/, '') + ' ч.';
}
function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const money = (n) => fmtNum(n) + ' ' + esc(S('currency'));

function avatar(x, cls = '') {
  const u = x && typeof x === 'object' ? x : null;
  const name = u ? u.username : x;
  if (u && u.avatar) return `<span class="av${cls ? ' ' + cls : ''} has-img"><img src="${esc(u.avatar)}" alt=""></span>`;
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  const ch = [...String(name)][0] || '?';
  return `<span class="av ${cls}" style="background:linear-gradient(135deg,hsl(${h},60%,62%),hsl(${(h + 40) % 360},55%,38%))">${esc(ch.toUpperCase())}</span>`;
}

/* ------------------------------------------------------------- ранги и привилегии */
const RANKS = {
  creator:   { label: 'СОЗДАТЕЛЬ', cls: 'r-creator',   w: 4 },
  deputy:    { label: 'ЗАМЕСТИТЕЛЬ', cls: 'r-deputy',  w: 3 },
  admin:     { label: 'АДМИН', cls: 'r-admin',          w: 2 },
  moderator: { label: 'МОДЕРАТОР', cls: 'r-mod',        w: 1 },
  player:    { label: 'ИГРОК', cls: 'r-player',         w: 0 },
};
const rankKey = (u) => (u && RANKS[u.rank] ? u.rank : 'player');
const rankBadge = (u) => { const k = rankKey(u); return `<span class="rank ${RANKS[k].cls}">${RANKS[k].label}</span>`; };
const isActive = (u) => u && u.ban_until > 0 && u.ban_until > now();

/* привилегии пользователя: активная (без срока или действующая) */
function activePriv(userId) {
  return one(`SELECT * FROM user_privs WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)
              ORDER BY (expires_at IS NULL) DESC, expires_at DESC, id DESC LIMIT 1`, userId, now());
}
function activePrivs(userId) {
  return all(`SELECT * FROM user_privs WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)
              ORDER BY (expires_at IS NULL) DESC, expires_at DESC, id DESC`, userId, now());
}
/* сколько осталось: «12 дн. 4 ч.» / «навсегда» / «5 ч. 20 мин.» */
function timeLeft(expires) {
  if (!expires) return 'навсегда';
  let s = expires - now();
  if (s <= 0) return 'истекла';
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d >= 365) return Math.floor(d / 365) + ' г. ' + Math.floor((d % 365) / 30) + ' мес.';
  if (d >= 30) return Math.floor(d / 30) + ' мес. ' + (d % 30) + ' дн.';
  if (d > 0) return d + ' дн. ' + h + ' ч.';
  if (h > 0) return h + ' ч. ' + m + ' мин.';
  return Math.max(1, m) + ' мин.';
}
/* цветной ник: привилегия из магазина важнее ранга */
function nickHtml(name, u, cls = '') {
  if (!u) return `<b class="nick n-player ${cls}">${esc(name)}</b>`;
  const p = u._priv !== undefined ? u._priv : activePriv(u.id);
  const color = p && p.color ? p.color : '';
  const style = color ? ` style="color:${esc(color)}"` : '';
  const pfx = p && p.prefix ? `<i class="pfx"${color ? ` style="border-color:${esc(color)};color:${esc(color)}"` : ''}>${esc(p.prefix)}</i>` : '';
  return `<b class="nick n-${rankKey(u)} ${cls}"${style}>${pfx}${esc(name)}</b>`;
}
const withPriv = (u) => { if (u && u._priv === undefined) u._priv = activePriv(u.id); return u; };
/* пакетно подтягиваем активные привилегии для списка пользователей */
function withPrivMany(list) {
  const uid = (u) => (u && (u.user_id || u.id)) || 0;
  const ids = [...new Set(list.map(uid).filter(Boolean))];
  if (ids.length) {
    const rows = all(`SELECT * FROM user_privs WHERE (expires_at IS NULL OR expires_at>?) AND user_id IN (${ids.map(() => '?').join(',')})`, now(), ...ids);
    const best = new Map();
    for (const r of rows) {
      const cur = best.get(r.user_id);
      if (!cur) best.set(r.user_id, r);
      else if (r.expires_at === null && cur.expires_at !== null) best.set(r.user_id, r);
      else if (r.expires_at !== null && cur.expires_at !== null && r.expires_at > cur.expires_at) best.set(r.user_id, r);
    }
    for (const u of list) if (u) u._priv = best.get(uid(u)) || null;
  }
  return list;
}
/* карта «ник в игре → пользователь» (для рейтинга и онлайна) */
function usersByNick() {
  const rows = all("SELECT id, username, rank, game_nick FROM users WHERE game_nick<>''");
  withPrivMany(rows);
  return new Map(rows.map((u) => [u.game_nick.toLowerCase(), u]));
}
const canMod = (ctx) => ctx.user && (isAdmin(ctx) || rankKey(ctx.user) === 'moderator');

/* список привилегий (для профиля и кабинета) */
function privRows(list, mine = false) {
  if (!list.length) return `<p class="empty-s">${mine ? 'У вас пока нет привилегий. Загляните в ' : 'Привилегий нет. '}${mine ? '<a href="/shop">магазин</a>.' : ''}</p>`;
  return `<ul class="privlist pad">${list.map((p) => {
    const left = p.expires_at ? timeLeft(p.expires_at) : null;
    const expired = p.expires_at && p.expires_at <= now();
    return `<li class="${expired ? 'off' : ''}">
      <span class="dotc"${p.color ? ` style="background:${esc(p.color)};box-shadow:0 0 8px ${esc(p.color)}"` : ''}></span>
      <div><b${p.color ? ` style="color:${esc(p.color)}"` : ''}>${esc(p.name)}</b>
        ${p.prefix ? `<i class="pfx"${p.color ? ` style="border-color:${esc(p.color)};color:${esc(p.color)}"` : ''}>${esc(p.prefix)}</i>` : ''}
        <small>${expired ? 'истекла' : 'осталось: ' + (left || 'навсегда')}</small></div></li>`;
  }).join('')}</ul>`;
}

/* выдать привилегию: продлевает действующую или создаёт новую */
function grantPriv(userId, productId, name, days, byId) {
  const p = productId ? one('SELECT * FROM products WHERE id=?', productId) : one('SELECT * FROM products WHERE name=? LIMIT 1', name);
  const d = Number.isFinite(days) && days > 0 ? days : (p && p.days ? p.days : 0);
  const exp = d > 0 ? now() + d * 86400 : null;
  const prefix = p && p.prefix ? p.prefix : '', color = p && p.color ? p.color : '';
  const same = productId
    ? one('SELECT * FROM user_privs WHERE user_id=? AND product_id=? AND (expires_at IS NULL OR expires_at>?)', userId, productId, now())
    : one('SELECT * FROM user_privs WHERE user_id=? AND name=? AND (expires_at IS NULL OR expires_at>?)', userId, name, now());
  if (same) {
    if (exp === null) run('UPDATE user_privs SET expires_at=NULL, days=0 WHERE id=?', same.id);
    else if (same.expires_at !== null) run('UPDATE user_privs SET expires_at=?, days=? WHERE id=?', same.expires_at + d * 86400, d, same.id);
  } else {
    run('INSERT INTO user_privs(user_id,product_id,name,prefix,color,days,expires_at,granted_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      userId, productId || null, String(name).slice(0, 60), prefix, color, d, exp, byId || null, now());
  }
}

/* ---- профиль игрока ---- */
function friendState(meId, otherId) {
  if (!meId || meId === otherId) return meId === otherId ? 'self' : 'none';
  const a = one('SELECT * FROM friends WHERE from_id=? AND to_id=?', meId, otherId);
  if (a) return a.status === 'accepted' ? 'friends' : 'outgoing';
  const b = one('SELECT * FROM friends WHERE from_id=? AND to_id=?', otherId, meId);
  if (b) return b.status === 'accepted' ? 'friends' : 'incoming';
  return 'none';
}
function friendsOf(id) {
  return all(`SELECT u.* FROM friends f JOIN users u ON u.id = CASE WHEN f.from_id=? THEN f.to_id ELSE f.from_id END
              WHERE f.status='accepted' AND (f.from_id=? OR f.to_id=?) ORDER BY u.username COLLATE NOCASE`, id, id, id);
}
const isOnline = (name) => liveTotals().names.has(String(name || '').toLowerCase());

/* ---- кто сейчас на сайте (по активности сессии, окно 5 минут) ---- */
const SITE_ONLINE_SEC = 300;
function siteOnlineList() {
  const t = now(), cut = t - SITE_ONLINE_SEC;
  return all(`SELECT u.*, MAX(s.last_seen) AS seen FROM sessions s JOIN users u ON u.id=s.user_id
              WHERE s.expires>? AND s.last_seen>? GROUP BY u.id ORDER BY seen DESC`, t, cut)
    .filter((u) => !isActive(u));
}
const siteOnlineCount = () => one('SELECT COUNT(DISTINCT user_id) c FROM sessions WHERE expires>? AND last_seen>?', now(), now() - SITE_ONLINE_SEC).c;
const ago = (ts) => { const m = Math.max(1, Math.round((now() - ts) / 60)); return m < 60 ? m + ' мин. назад' : Math.floor(m / 60) + ' ч. назад'; };


/* --------------------------------------------------------- passwords/auth */
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const c = crypto.scryptSync(pw, salt, 64), b = Buffer.from(h, 'hex');
  return c.length === b.length && crypto.timingSafeEqual(c, b);
}
const parseCookies = (h) => Object.fromEntries(String(h || '').split(';').map((p) => p.trim().split(/=(.*)/s).slice(0, 2)).filter((p) => p[0]).map(([k, v]) => [k, decodeURIComponent(v || '')]));
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

const hits = new Map(); // простая защита от перебора и спама
function limited(key, max, windowSec) {
  const t = now(), arr = (hits.get(key) || []).filter((x) => t - x < windowSec);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(t); hits.set(key, arr); return false;
}
setInterval(() => { const t = now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 3600)) hits.delete(k); run('DELETE FROM sessions WHERE expires < ?', t); }, 600000).unref();

/* ----------------------------------------------- опрос игровых серверов (A2S) */
const live = new Map();       // serverId -> { online, name, map, players, max, list[], checked }
const lastSeen = new Map();   // "serverId:ник" -> { score, dur }

function udp(host, port, buf, timeout = 2500) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const done = (v) => { clearTimeout(t); try { s.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done(null), timeout);
    s.once('message', (m) => done(m));
    s.once('error', () => done(null));
    s.send(buf, port, host, (err) => { if (err) done(null); });
  });
}
function cstr(b, o) { let e = b.indexOf(0, o); if (e < 0) e = b.length; return [b.toString('utf8', o, e), e + 1]; }

async function queryInfo(host, port) {
  const base = Buffer.concat([Buffer.from([255, 255, 255, 255, 0x54]), Buffer.from('Source Engine Query\0')]);
  let r = await udp(host, port, base);
  if (r && r.length >= 9 && r[4] === 0x41) r = await udp(host, port, Buffer.concat([base, r.subarray(5, 9)]));
  if (!r || r.length < 8 || r.readInt32LE(0) !== -1) return null;
  try {
    let o = 5, name, map;
    if (r[4] === 0x49) { // Source / новый формат
      o += 1; [name, o] = cstr(r, o); [map, o] = cstr(r, o); [, o] = cstr(r, o); [, o] = cstr(r, o); o += 2;
      return { name, map, players: r[o], max: r[o + 1] };
    }
    if (r[4] === 0x6d) { // GoldSource (CS 1.6 обычно отвечает так)
      [, o] = cstr(r, o); [name, o] = cstr(r, o); [map, o] = cstr(r, o); [, o] = cstr(r, o); [, o] = cstr(r, o);
      return { name, map, players: r[o], max: r[o + 1] };
    }
  } catch { /* битый пакет */ }
  return null;
}
async function queryPlayers(host, port) {
  let r = await udp(host, port, Buffer.from([255, 255, 255, 255, 0x55, 255, 255, 255, 255]));
  if (r && r.length >= 9 && r[4] === 0x41) r = await udp(host, port, Buffer.concat([Buffer.from([255, 255, 255, 255, 0x55]), r.subarray(5, 9)]));
  if (!r || r.length < 6 || r[4] !== 0x44) return null;
  const out = []; let o = 6;
  try {
    for (let i = 0; i < r[5] && o < r.length; i++) {
      o += 1; let name; [name, o] = cstr(r, o);
      const score = r.readInt32LE(o); o += 4;
      const dur = r.readFloatLE(o); o += 4;
      out.push({ name, score, duration: dur });
    }
  } catch { /* обрезанный пакет */ }
  return out;
}

const lastPoll = new Map();
async function pollServer(s) {
  const t = Date.now();
  const info = await queryInfo(s.ip, s.port);
  if (!info) { live.set(s.id, { online: false, list: [], players: 0, max: 0, map: '', name: '', checked: t }); lastPoll.delete(s.id); return; }
  const list = ((await queryPlayers(s.ip, s.port)) || []).map((p) => ({ ...p, name: p.name.trim().slice(0, 32) })).filter((p) => p.name);
  const before = live.get(s.id);
  const mapChanged = before && before.online && before.map !== info.map;
  const dt = clamp(Math.round((t - (lastPoll.get(s.id) || t - POLL_MS)) / 1000), 1, 120);
  lastPoll.set(s.id, t);
  live.set(s.id, { online: true, name: info.name, map: info.map, players: info.players, max: info.max, list, checked: t });
  const ts = now();
  try {
    tx(() => {
      for (const p of list) {
        const key = s.id + ':' + p.name.toLowerCase();
        let prev = lastSeen.get(key);
        if (mapChanged) prev = prev ? { score: 0, dur: prev.dur } : prev;
        const fresh = p.duration < dt + 5;
        let add = 0, visit = 0;
        if (prev && p.duration >= prev.dur - 1) add = p.score - prev.score;
        else if (fresh) { add = p.score; visit = 1; }
        lastSeen.set(key, { score: p.score, dur: p.duration });
        const secs = clamp(Math.round(p.duration), 1, dt);
        run(`INSERT INTO players(name,seconds,frags,visits,first_seen,last_seen,last_server_id) VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(name) DO UPDATE SET seconds=seconds+excluded.seconds, frags=MAX(0,frags+excluded.frags),
             visits=visits+excluded.visits, last_seen=excluded.last_seen, last_server_id=excluded.last_server_id`,
        p.name, secs, Math.max(0, add), visit, ts, ts, s.id);
        if (add < 0) run('UPDATE players SET frags=MAX(0,frags+?) WHERE name=?', add, p.name);
      }
    });
  } catch (e) { console.error('Ошибка записи статистики:', e.message); }
}
let polling = false;
async function pollAll() {
  if (polling) return; polling = true;
  try {
    const servers = all('SELECT * FROM servers WHERE enabled=1');
    for (const id of [...live.keys()]) if (!servers.some((s) => s.id === id)) { live.delete(id); lastPoll.delete(id); }
    await Promise.all(servers.map((s) => pollServer(s).catch((e) => console.error('poll', s.id, e.message))));
  } finally { polling = false; }
}
function liveTotals() {
  let players = 0, max = 0; const names = new Set(); const list = [];
  for (const v of live.values()) if (v.online) { players += v.players; max += v.max; for (const p of v.list) { names.add(p.name.toLowerCase()); list.push(p); } }
  list.sort((a, b) => b.duration - a.duration);
  return { players, max, names, list };
}

/* ------------------------------------------------------------- HTML layout */
const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="home" viewBox="0 0 24 24"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/></symbol>
<symbol id="server" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/></symbol>
<symbol id="chart" viewBox="0 0 24 24"><path d="M5 20V10M12 20V4M19 20v-7"/></symbol>
<symbol id="cart" viewBox="0 0 24 24"><path d="M3 4h3l2 11h10l2-8H7"/><circle cx="9" cy="19" r="1.3"/><circle cx="17" cy="19" r="1.3"/></symbol>
<symbol id="chat" viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></symbol>
<symbol id="news" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 12h8M8 15h5"/></symbol>
<symbol id="ban" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/></symbol>
<symbol id="mail" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></symbol>
<symbol id="user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></symbol>
<symbol id="users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5 6.5-5s5.7 1.5 6.5 5"/><path d="M16 5a3.5 3.5 0 010 6.5M18 15c2 .6 3.2 2.2 3.5 5"/></symbol>
<symbol id="gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></symbol>
<symbol id="power" viewBox="0 0 24 24"><path d="M12 3v8"/><path d="M6.5 6.5a8 8 0 1011 0"/></symbol>
<symbol id="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></symbol>
<symbol id="arrow" viewBox="0 0 24 24"><path d="M4 12h15M13 6l6 6-6 6"/></symbol>
<symbol id="crown" viewBox="0 0 24 24"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" fill="currentColor"/></symbol>
<symbol id="clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></symbol>
<symbol id="comment" viewBox="0 0 24 24"><path d="M4 5h16v11H10l-5 4v-4H4z"/></symbol>
<symbol id="shop" viewBox="0 0 24 24"><path d="M5 4h14l-1 6H6z"/><path d="M6 10v10h12V10M10 14h4"/></symbol>
<symbol id="shield" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></symbol>
<symbol id="globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></symbol>
<symbol id="lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></symbol>
<symbol id="pin" viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/></symbol>
<symbol id="plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
</defs></svg>`;

const NAV = [
  ['/', 'home', 'Главная', 'home'], ['/servers', 'server', 'Серверы', 'servers'], ['/stats', 'chart', 'Статистика', 'stats'],
  ['/shop', 'shop', 'Магазин', 'shop'], ['/forum', 'chat', 'Форум', 'forum'], ['/news', 'news', 'Новости', 'news'],
  ['/bans', 'ban', 'Банлист', 'bans'], ['/contacts', 'mail', 'Контакты', 'contacts'],
];

const csrfField = (ctx) => `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`;
const logoHtml = () => { const [a, ...b] = String(S('site_name') || 'OBITO GAMING').split(/\s+/); return `<b>${esc(a)}</b><i>${esc(b.join(' '))}</i>`; };
const isAdmin = (ctx) => ctx.user && (ctx.user.role === 'admin' || ['creator', 'deputy', 'admin'].includes(rankKey(ctx.user)));
const needMod = (ctx) => { if (canMod(ctx)) return false; if (!ctx.user) redirect(ctx, '/login?next=' + encodeURIComponent(ctx.url.pathname), 'Войдите, чтобы продолжить.', 'err'); else notFound(ctx); return true; };

function pickFeatured() {
  const list = all('SELECT * FROM servers WHERE enabled=1 ORDER BY sort, id');
  return list.find((s) => live.get(s.id)?.online) || list[0] || null;
}

function sidebarHtml(ctx) {
  const tot = liveTotals();
  const byNick = usersByNick();
  const rows = tot.list.slice(0, 8).map((p) => {
    const u = byNick.get(p.name.toLowerCase());
    const nm = u ? `<a class="nm" href="/u/${u.id}">${nickHtml(p.name, withPriv(u))}</a>` : `<span class="nm">${esc(p.name)}</span>`;
    return `<li>${avatar(u || p.name)}${nm}<span class="dot"></span><time>${fmtClock(p.duration)}</time></li>`;
  }).join('');
  const online = `<section class="panel"><div class="ph"><h2>${icon('users')}Игроки онлайн</h2><span class="cnt"><span data-total-online>${tot.players}</span> <small>/ <span data-total-max>${tot.max}</span></small></span></div>
    ${rows ? `<ul class="online">${rows}</ul>` : `<p class="empty-s">Сейчас на серверах никого нет.<br>Игроки появятся здесь, как только зайдут.</p>`}</section>`;
  const donors = donorsBlock(ctx);
  const quick = [
    [ctx.user ? '/cabinet' : '/login', 'user', ctx.user ? 'Личный кабинет' : 'Войти на сайт'], ['/shop', 'shop', 'Магазин привилегий'], ['/servers', 'server', 'Список серверов'],
    ['/stats', 'chart', 'Статистика'], ['/forum', 'chat', 'Форум'], ['/bans', 'ban', 'Банлист'],
  ].map(([h, i, t]) => `<li><a href="${h}">${icon(i)}${t}${icon('chev')}</a></li>`).join('');
  const f = pickFeatured();
  let info;
  if (f) {
    const L = live.get(f.id), addr = `${f.ip}:${f.port}`;
    info = `<div class="info"><div class="shot" data-art="${esc(L?.map || '')}" data-seed="${f.id + 70}"></div>
      <dl><dt>Карта:</dt><dd>${esc(L?.online ? L.map : '—')}</dd><dt>Игроки:</dt><dd>${L?.online ? `${L.players}/${L.max}` : '—'}</dd>
      <dt>IP:</dt><dd>${esc(addr)}</dd><dt>Тип:</dt><dd>${esc(f.mode)}</dd><dt>Режим:</dt><dd>Counter-Strike 1.6</dd></dl>
      <a class="btn block" href="steam://connect/${esc(addr)}" data-copy="connect ${esc(addr)}">${icon('users')}Подключиться</a></div>`;
  } else info = `<p class="empty-s">Серверы ещё не добавлены.</p>`;
  const siteOn = `<section class="panel"><div class="ph"><h2>${icon('globe')}На сайте сейчас</h2><span class="cnt ok">${icon('users')}<b data-site-online>${siteOnlineCount()}</b></span></div>
    <div class="pad"><p class="hint">Список игроков, которые сейчас открыли сайт.</p><a class="btn block" href="/online">Показать игроков</a></div></section>`;
  return `<aside class="side">${online}${siteOn}${donors}
    <section class="panel"><div class="ph"><h2>${icon('shield')}Быстрый доступ</h2></div><ul class="quick">${quick}</ul></section>
    <section class="panel"><div class="ph"><h2>Информация о сервере</h2></div>${info}</section></aside>`;
}

/* топ-5 донатов + своё место */
function donorsBlock(ctx) {
  const rows = all('SELECT id, username, rank, donated FROM users WHERE donated>0 ORDER BY donated DESC, id LIMIT 5');
  const list = rows.length ? `<ul class="donors">${rows.map((u, i) => `<li class="${i === 0 ? 'first' : ''}">
      <span class="pos">${i + 1}</span><a href="/u/${u.id}">${nickHtml(u.username, withPriv(u))}</a><b>${money(u.donated)}</b></li>`).join('')}</ul>`
    : `<p class="empty-s">Пока никто не пополнял баланс. Первый займёт место №1.</p>`;
  let mine = '';
  if (ctx.user && ctx.user.donated > 0) {
    const place = one('SELECT COUNT(*) c FROM users WHERE donated>?', ctx.user.donated).c + 1;
    mine = `<div class="myplace">Ваше место: <b>№${place}</b> <span class="muted">· вложено ${money(ctx.user.donated)}</span></div>`;
  }
  return `<section class="panel"><div class="ph"><h2>${icon('crown')}Топ донатов</h2><span class="cnt"><small>топ-5</small></span></div>${list ? `<div class="pad donors-pad">${list}${mine}</div>` : ''}</section>`;
}

function layout(ctx, { title, active = '', content, side = true }) {
  const flash = ctx.flash ? `<div class="flash ${esc(ctx.flash.type)}" role="status">${esc(ctx.flash.msg)}</div>` : '';
  const unread = ctx.user ? one('SELECT COUNT(*) c FROM pms WHERE to_id=? AND read_at=0', ctx.user.id).c : 0;
  const me = ctx.user
    ? `<div class="me">${avatar(ctx.user, 'lg')}<div class="who"><div><a class="me-name" href="/u/${ctx.user.id}">${esc(ctx.user.username)}</a> ${rankBadge(ctx.user)}</div><small>Баланс: ${money(ctx.user.balance)}</small></div>
       <a class="btn sm" href="/topup">Пополнить</a>
       <div class="ico"><a href="/messages" aria-label="Личные сообщения" title="Личные сообщения" class="msg-ico">${icon('mail')}${unread ? `<em>${unread}</em>` : ''}</a><a href="/cabinet" aria-label="Личный кабинет" title="Личный кабинет">${icon('user')}</a>${isAdmin(ctx) ? `<a href="/admin" aria-label="Админ-панель" title="Админ-панель">${icon('gear')}</a>` : ''}
       <form method="post" action="/logout">${csrfField(ctx)}<button type="submit" aria-label="Выйти" title="Выйти">${icon('power')}</button></form></div></div>`
    : `<div class="me guest"><a class="btn" href="/login">Войти</a><a class="btn solid" href="/register">Регистрация</a></div>`;
  const nav = NAV.map(([h, i, t, k]) => `<a href="${h}"${k === active ? ' aria-current="page"' : ''}>${icon(i)}${t}</a>`).join('');
  const soc = [['contact_vk', 'VK', 'ВКонтакте'], ['contact_telegram', 'TG', 'Telegram'], ['link_youtube', 'YT', 'YouTube'], ['contact_discord', 'DC', 'Discord']]
    .filter(([k]) => /^https?:\/\//i.test(S(k))).map(([k, s, n]) => `<a href="${esc(S(k))}" target="_blank" rel="noopener" aria-label="${n}">${s}</a>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(S('site_name'))}</title>
<meta name="description" content="OBITO GAMING — Counter-Strike 1.6 o‘yinchilari uchun o‘yin serverlari, yangiliklar, reytinglar va o‘yinchilar hamjamiyati.">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#06110c">
<meta property="og:title" content="${esc(title)} — ${esc(S('site_name'))}">
<meta property="og:description" content="Counter-Strike 1.6 serverlari, yangiliklar, reytinglar va o‘yinchilar hamjamiyati.">
<meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Exo+2:wght@500;600;700&family=Golos+Text:wght@400;500;600&family=Russo+One&display=swap">
<link rel="stylesheet" href="/static/style.css"><script src="/static/app.js" defer></script></head><body>${SPRITE}
<div class="rail l" aria-hidden="true"><span>${esc(S('site_name'))} · Counter-Strike 1.6</span></div><div class="rail r" aria-hidden="true"><span>Играй · Общайся · Развивайся</span></div>
<div class="wrap">
<header class="top panel"><a class="logo" href="/" aria-label="${esc(S('site_name'))}">${logoHtml()}</a>
<div class="tag"><strong>Counter-Strike 1.6</strong><span>${esc(S('tagline_1'))}</span><span>${esc(S('tagline_2'))}</span><span class="onchip">${icon('users')}На сайте: <b data-site-online>${siteOnlineCount()}</b></span></div>${me}</header>
<nav class="menu panel" aria-label="Главное меню">${nav}</nav>${flash}
${side ? `<div class="cols"><main class="stack">${content}</main>${sidebarHtml(ctx)}</div>` : `<main class="stack">${content}</main>`}
<footer class="foot panel"><a class="logo" href="/">${logoHtml()}</a>
<div class="links"><b>Играй<em>•</em>Общайся<em>•</em>Развивайся</b><span>© ${new Date().getFullYear()} ${esc(S('site_name'))}. Все права защищены.</span></div>
<div class="soc">${soc}</div><div class="quote">${esc(S('footer_quote'))}</div></footer>
</div><div class="toast" id="toast" role="status" aria-live="polite"></div></body></html>`;
}

const panel = (title, inner, { ic = '', right = '' } = {}) => `<section class="panel"><div class="ph"><h2>${ic ? icon(ic) : ''}${title}</h2>${right}</div>${inner}</section>`;
const empty = (msg, action = '') => `<div class="empty">${msg}${action ? `<div>${action}</div>` : ''}</div>`;
const field = (ctx, name, label, attrs = '') => `<label class="f"><span>${label}</span><input name="${name}" ${attrs}></label>`;

function pager(ctx, page, pages, extra = {}) {
  if (pages <= 1) return '';
  const link = (p, label, cur) => {
    const u = new URLSearchParams(ctx.url.search); u.set('page', p); for (const [k, v] of Object.entries(extra)) u.set(k, v);
    return `<a href="${ctx.url.pathname}?${u.toString()}"${cur ? ' aria-current="page"' : ''}>${label}</a>`;
  };
  const nums = []; for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - page) <= 2) nums.push(p);
  let out = page > 1 ? link(page - 1, '&lsaquo;') : '', last = 0;
  for (const p of nums) { if (p - last > 1) out += '<span>…</span>'; out += link(p, p, p === page); last = p; }
  return `<nav class="pager" aria-label="Страницы">${out}${page < pages ? link(page + 1, '&rsaquo;') : ''}</nav>`;
}

/* ------------------------------------------------------------ page parts */
function serverCard(s) {
  const L = live.get(s.id), addr = `${s.ip}:${s.port}`;
  const st = !L ? ['wait', 'ПРОВЕРКА'] : L.online ? ['on', 'ONLINE'] : ['off', 'OFFLINE'];
  return `<article class="srv panel"><div class="shot${L && !L.online ? ' dim' : ''}" data-art="${esc(L?.map || '')}" data-seed="${s.id}"></div>
  <div class="body"><div class="t"><span class="badge">${icon('shield')}</span><div><b>${esc(s.name)}</b><small>${esc(s.mode)} · ${esc(L?.online ? L.map : 'нет данных')}</small></div></div>
  <div class="st"><span class="n">${icon('users')}<span data-srv-players="${s.id}">${L?.online ? `${L.players}/${L.max}` : '—'}</span></span><span class="state ${st[0]}" data-srv-state="${s.id}">${st[1]}</span></div>
  <div class="addr">${esc(addr)}</div>
  <a class="btn block" href="steam://connect/${esc(addr)}" data-copy="connect ${esc(addr)}">Подключиться</a></div></article>`;
}

function serversBlock(ctx, limit) {
  const list = all(`SELECT * FROM servers WHERE enabled=1 ORDER BY sort, id ${limit ? 'LIMIT ' + limit : ''}`);
  if (!list.length) return panel('Серверы', empty('Серверов пока нет.', isAdmin(ctx) ? '<a class="btn solid" href="/admin/servers">Добавить сервер</a>' : 'Администратор скоро добавит их.'), { ic: 'server' });
  return `<section class="servers" id="servers" aria-label="Список серверов">${list.map(serverCard).join('')}</section>`;
}

function heroBlock(ctx) {
  const f = pickFeatured();
  let right;
  if (f) {
    const L = live.get(f.id), addr = `${f.ip}:${f.port}`;
    right = `<div class="feat"><h3>${icon('shield')}<span>${esc(f.name)}</span></h3>
      <div class="row"><span class="chip">${icon('lock')}${esc(f.mode)}</span><span class="chip">${esc(L?.online ? L.map : 'карта неизвестна')}</span>
      <span class="cnt ok">${icon('users')}${L?.online ? `${L.players}/${L.max}` : '—'}</span></div>
      <div class="ip">${icon('globe')}<span>${esc(addr)}</span></div>
      <div class="feat-foot"><a class="btn" href="steam://connect/${esc(addr)}" data-copy="connect ${esc(addr)}">Подключиться</a><span class="state ${!L ? 'wait' : L.online ? 'on' : 'off'}">${!L ? 'ПРОВЕРКА' : L.online ? 'ONLINE' : 'OFFLINE'}</span></div></div>`;
  } else {
    right = `<div class="feat"><h3>${icon('server')}<span>Сервер не добавлен</span></h3><p class="muted">${isAdmin(ctx) ? 'Добавьте IP и порт вашего сервера в админ-панели.' : 'Скоро здесь появятся наши серверы.'}</p>
      ${isAdmin(ctx) ? '<a class="btn solid" href="/admin/servers">Добавить сервер</a>' : ''}</div>`;
  }
  const heroImg = S('hero_image');
  const bgInner = heroImg ? `<img class="bgimg" src="${esc(heroImg)}" alt="">` : '';
  const bgAttrs = heroImg ? '' : ` data-art="${esc(f ? live.get(f.id)?.map || '' : '')}" data-seed="${f ? f.id + 40 : 40}"`;
  return `<section class="hero panel" aria-labelledby="hero-title"><div class="bg"${bgAttrs} aria-hidden="true">${bgInner}</div>
    <div><h1 id="hero-title">Наши сервера</h1><p>Выбери свой игровой сервер</p><a class="btn solid" href="/servers">Подробнее ${icon('arrow')}</a></div>${right}</section>`;
}

function newsBlock(limit) {
  const rows = all('SELECT n.*, (SELECT COUNT(*) FROM news_comments c WHERE c.news_id=n.id) AS cc FROM news n ORDER BY created_at DESC, id DESC LIMIT ?', limit);
  const inner = rows.length ? `<ul class="news">${rows.map((n) => `<li><div class="th" data-art="news" data-seed="${n.id}"><span>${esc([...n.tag][0] || 'N')}</span></div><div>
    <span class="tg">${esc(n.tag)}</span><h3><a href="/news/${n.id}">${esc(n.title)}</a></h3><p>${esc(n.body.replace(/\s+/g, ' ').slice(0, 120))}${n.body.length > 120 ? '…' : ''}</p>
    <div class="meta"><span>${icon('clock')}${fmtDate(n.created_at, false)}</span><span>${icon('comment')}${n.cc}</span></div></div></li>`).join('')}</ul>` : empty('Новостей пока нет.');
  return panel('Последние новости', inner, { ic: 'news', right: '<a class="more" href="/news">Все новости ' + icon('arrow') + '</a>' });
}

const SORTS = { time: ['seconds', 'По времени'], frags: ['frags', 'По фрагам'], visits: ['visits', 'По заходам'], last: ['last_seen', 'По активности'] };
function ratingBlock(ctx, { limit, page = 1, q = '', base = '/stats', anchor = '' }) {
  const sort = SORTS[ctx.query.get('sort')] ? ctx.query.get('sort') : 'time';
  const like = '%' + q.replace(/[%_]/g, '') + '%';
  const total = one('SELECT COUNT(*) c FROM players WHERE name LIKE ?', like).c;
  const pages = Math.max(1, Math.ceil(total / limit)); page = clamp(page, 1, pages);
  const rows = all(`SELECT * FROM players WHERE name LIKE ? ORDER BY ${SORTS[sort][0]} DESC, id LIMIT ? OFFSET ?`, like, limit, (page - 1) * limit);
  const onl = liveTotals().names;
  const byNick = usersByNick();
  const tabs = Object.entries(SORTS).map(([k, [, label]]) => `<a href="${base}?sort=${k}${q ? '&q=' + encodeURIComponent(q) : ''}${anchor}"${k === sort ? ' aria-current="true"' : ''}>${label}</a>`).join('');
  const body = rows.length ? `<div class="tbl"><table><thead><tr><th>#</th><th>Никнейм</th><th>Время</th><th>Фраги</th><th>Заходов</th><th>Фраг/час</th></tr></thead><tbody>
    ${rows.map((p, i) => { const n = (page - 1) * limit + i + 1; const fph = p.seconds >= 600 ? (p.frags * 3600 / p.seconds).toFixed(1) : '—';
      return `<tr${n === 1 ? ' class="top1"' : ''}><td>${n === 1 ? icon('crown') : n}</td><td><span class="pl">${avatar(byNick.get(p.name.toLowerCase()) || p.name)}${byNick.has(p.name.toLowerCase()) ? `<a href="/u/${byNick.get(p.name.toLowerCase()).id}">${nickHtml(p.name, byNick.get(p.name.toLowerCase()))}</a>` : `<b class="nick n-player">${esc(p.name)}</b>`}${onl.has(p.name.toLowerCase()) ? ' <span class="dot" title="Сейчас на сервере"></span>' : ''}</span></td>
      <td${sort === 'time' ? ' class="sorted"' : ''}>${fmtHours(p.seconds)}</td><td${sort === 'frags' ? ' class="sorted"' : ''}>${fmtNum(p.frags)}</td><td${sort === 'visits' ? ' class="sorted"' : ''}>${p.visits}</td><td>${fph}</td></tr>`; }).join('')}
    </tbody></table></div>` : empty(q ? 'Игрок с таким ником не найден.' : 'Рейтинг пока пуст. Игроки появятся здесь автоматически, как только зайдут на сервер.');
  return { sort, html: `<section class="panel" id="rating"><div class="ph"><h2>Рейтинг игроков</h2>${limit > 10 ? `<form class="search" method="get" action="${base}"><input type="hidden" name="sort" value="${sort}"><input name="q" value="${esc(q)}" placeholder="Поиск по нику" aria-label="Поиск по нику"><button class="btn sm" type="submit">Найти</button></form>` : `<a class="more" href="/stats">Вся статистика ${icon('arrow')}</a>`}</div>
    <div class="tabs">${tabs}</div>${body}${limit > 10 ? pager(ctx, page, pages) : ''}</section>` };
}

/* ----------------------------------------------------------------- router */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), handler });
const get = (p, h) => route('GET', p, h);
const post = (p, h) => route('POST', p, h);

function redirect(ctx, to, msg, type = 'ok') {
  if (msg) ctx.setCookie('flash', encodeURIComponent(JSON.stringify({ msg, type })), { maxAge: 30 });
  ctx.res.writeHead(303, { Location: to, ...ctx.extraHeaders() }); ctx.res.end(); ctx.done = true;
}
function send(ctx, status, html, type = 'text/html; charset=utf-8') {
  ctx.res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...ctx.extraHeaders() }); ctx.res.end(html); ctx.done = true;
}
const page = (ctx, opts) => send(ctx, opts.status || 200, layout(ctx, opts));
const notFound = (ctx) => page(ctx, { status: 404, title: 'Не найдено', content: panel('Страница не найдена', empty('Такой страницы нет. Проверьте адрес или вернитесь на главную.', '<a class="btn solid" href="/">На главную</a>')) });
const needLogin = (ctx) => { if (ctx.user) return false; redirect(ctx, '/login?next=' + encodeURIComponent(ctx.url.pathname), 'Войдите, чтобы продолжить.', 'err'); return true; };
const needAdmin = (ctx) => { if (isAdmin(ctx)) return false; if (!ctx.user) redirect(ctx, '/login?next=' + encodeURIComponent(ctx.url.pathname), 'Войдите как администратор.', 'err'); else notFound(ctx); return true; };
const intOr = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

get('/u/:id', (ctx) => {
  const u = one('SELECT * FROM users WHERE id=?', intOr(ctx.params.id));
  if (!u) return notFound(ctx);
  withPriv(u);
  const stat = u.game_nick ? one('SELECT * FROM players WHERE name=?', u.game_nick) : null;
  const privs = activePrivs(u.id);
  const history = all('SELECT * FROM user_privs WHERE user_id=? ORDER BY id DESC LIMIT 20', u.id);
  const fstate = ctx.user ? friendState(ctx.user.id, u.id) : 'none';
  const flist = friendsOf(u.id);
  const me = ctx.user && ctx.user.id === u.id;
  const incoming = me ? all("SELECT u.* FROM friends f JOIN users u ON u.id=f.from_id WHERE f.to_id=? AND f.status='pending'", u.id) : [];

  const tg = u.telegram ? (/^https?:\/\//i.test(u.telegram) || u.telegram.startsWith('@')
    ? `<a href="${u.telegram.startsWith('@') ? 'https://t.me/' + esc(u.telegram.slice(1)) : esc(u.telegram)}" target="_blank" rel="noopener">${esc(u.telegram)}</a>` : esc(u.telegram)) : '—';

  const head = `<section class="panel profile-head"><div class="ph">
      <div class="pwho">${avatar(u, 'lg')}<div><div class="pname">${nickHtml(u.username, u)} ${rankBadge(u)}</div>
      <small class="muted">ID #${u.id} · регистрация ${fmtDate(u.created_at, false)}${isOnline(u.game_nick) ? ' · <span class="state on">В СЕТИ</span>' : ''}</small></div></div>
      <div class="pacts">
        ${me ? `<a class="btn" href="/cabinet">Мой кабинет</a>` : ''}
        ${ctx.user && !me ? `<a class="btn solid" href="/messages/${u.id}">${icon('mail')}Написать</a>` : ''}
        ${ctx.user && !me ? fstate === 'none' ? `<form method="post" action="/u/${u.id}/friend">${csrfField(ctx)}<button class="btn" type="submit">В друзья</button></form>`
          : fstate === 'outgoing' ? `<form method="post" action="/u/${u.id}/friend/decline">${csrfField(ctx)}<button class="btn" type="submit">Запрос отправлен</button></form>`
          : fstate === 'incoming' ? `<form method="post" action="/u/${u.id}/friend/accept">${csrfField(ctx)}<button class="btn solid" type="submit">Принять запрос</button></form>
            <form method="post" action="/u/${u.id}/friend/decline">${csrfField(ctx)}<button class="btn" type="submit">Отклонить</button></form>`
          : `<form method="post" action="/u/${u.id}/friend/remove" data-confirm="Удалить из друзей?">${csrfField(ctx)}<button class="btn" type="submit">В друзьях ✓</button></form>` : ''}
      </div></div>
    <div class="pgrid">
      <p class="kv"><span>Ник в игре</span><b>${u.game_nick ? esc(u.game_nick) : '—'}</b></p>
      <p class="kv"><span>Telegram</span><b>${tg}</b></p>
      <p class="kv"><span>Привилегия</span><b>${privs.length ? privs.map((p) => p.name).join(', ') : 'нет'}</b></p>
      <p class="kv"><span>Друзья</span><b>${flist.length}</b></p>
      ${me || isAdmin(ctx) ? `<p class="kv"><span>Баланс</span><b>${money(u.balance)}</b></p>` : ''}
      <p class="kv"><span>Донатов внесено</span><b>${u.donated > 0 ? money(u.donated) : '0 ' + esc(S('currency'))}</b></p>
    </div></section>`;

  const privPanel = panel('Привилегии и срок действия', privRows(history.length ? history : privs), { ic: 'shield' });
  const statPanel = panel('Статистика в игре', stat
    ? `<div class="pad"><p class="kv"><span>Время</span><b>${fmtHours(stat.seconds)}</b></p><p class="kv"><span>Фраги</span><b>${fmtNum(stat.frags)}</b></p><p class="kv"><span>Заходов</span><b>${stat.visits}</b></p><p class="kv"><span>Фраг/час</span><b>${stat.seconds >= 600 ? (stat.frags * 3600 / stat.seconds).toFixed(1) : '—'}</b></p></div>`
    : `<p class="empty-s">Игрока с таким ником ещё нет в рейтинге.</p>`, { ic: 'chart' });
  const friendsPanel = panel(`Друзья (${flist.length})`, `${
    me && incoming.length ? `<div class="incoming">${incoming.map((f) => `<div class="inc-row">${avatar(f)}<a class="nm" href="/u/${f.id}">${nickHtml(f.username, withPriv(f))}</a>
      <form method="post" action="/u/${f.id}/friend/accept">${csrfField(ctx)}<button class="btn sm solid" type="submit">Принять</button></form>
      <form method="post" action="/u/${f.id}/friend/decline">${csrfField(ctx)}<button class="btn sm" type="submit">Отклонить</button></form></div>`).join('')}</div>` : ''
    }${flist.length
    ? `<ul class="online pad">${flist.map((f) => `<li>${avatar(f)}<a class="nm" href="/u/${f.id}">${nickHtml(f.username, f)}</a>${rankBadge(f)}<time>${isOnline(f.game_nick) ? 'в сети' : ''}</time></li>`).join('')}</ul>`
    : `<p class="empty-s">${me && incoming.length ? '' : 'Список друзей пуст. Откройте профиль другого игрока и нажмите «В друзья».'}</p>`}`, { ic: 'users' });

  const adminPanel = isAdmin(ctx) ? panel('Управление (только для администрации)', `<div class="pad stack">
      <form method="post" action="/admin/users/${u.id}/rank" class="form inl-rows">${csrfField(ctx)}
        <label class="f"><span>Ранг на сайте</span><select name="rank">${Object.entries(RANKS).map(([k, r]) => `<option value="${k}"${u.rank === k ? ' selected' : ''}>${r.label}</option>`).join('')}</select></label>
        <button class="btn solid" type="submit">Сменить ранг</button></form>
      <form method="post" action="/admin/users/${u.id}/balance" class="form inl-rows">${csrfField(ctx)}
        <label class="f"><span>Изменить баланс (+/-)</span><input type="number" name="amount" placeholder="например 500" required></label>
        <button class="btn" type="submit">Применить</button></form>
      <form method="post" action="/admin/users/${u.id}/gift" class="form inl-rows">${csrfField(ctx)}
        <label class="f"><span>Подарить привилегию</span><select name="product_id">${all('SELECT * FROM products WHERE active=1 ORDER BY sort, id').map((p) => `<option value="${p.id}">${esc(p.name)} — ${money(p.price)} / ${p.days ? p.days + ' дн.' : 'навсегда'}</option>`).join('')}</select></label>
        <button class="btn solid" type="submit">Выдать</button></form>
      ${isActive(u) ? `<form method="post" action="/admin/users/${u.id}/unban" class="form inl-rows">${csrfField(ctx)}<label class="f"><span>Блокировка</span><input value="до ${fmtDate(u.ban_until)}" readonly></label><button class="btn" type="submit">Разбанить</button></form>`
        : `<form method="post" action="/admin/users/${u.id}/ban" class="form inl-rows">${csrfField(ctx)}
        <label class="f"><span>Забанить: дней (0 — навсегда)</span><input type="number" name="days" value="7" min="0" max="3650"></label>
        <label class="f"><span>Причина</span><input name="reason" maxlength="120" placeholder="нарушение правил"></label>
        <button class="btn danger" type="submit">Забанить</button></form>`}
      ${privs.length ? `<div class="mod">${privs.map((p) => `<form method="post" action="/admin/users/${u.id}/priv/${p.id}/delete" data-confirm="Снять привилегию «${esc(p.name)}»?">${csrfField(ctx)}<button class="btn sm danger" type="submit">Снять: ${esc(p.name)}</button></form>`).join('')}</div>` : ''}
      ${u.id !== ctx.user.id ? `<form method="post" action="/admin/users/${u.id}/delete" data-confirm="Удалить аккаунт ${esc(u.username)}? Всё его содержимое исчезнет.">${csrfField(ctx)}<button class="btn danger block" type="submit">Удалить аккаунт</button></form>` : ''}
    </div>`, { ic: 'gear' }) : '';

  page(ctx, { title: 'Профиль: ' + u.username, active: '', content: `<div class="stack">${head}<div class="two">${privPanel}${statPanel}</div>${friendsPanel}${adminPanel}</div>`, side: false });
});

/* ---- друзья ---- */
post('/u/:id/friend', (ctx) => {
  if (needLogin(ctx)) return;
  const other = intOr(ctx.params.id);
  if (other === ctx.user.id) return redirect(ctx, '/u/' + other, 'Нельзя добавить себя в друзья.', 'err');
  if (!one('SELECT id FROM users WHERE id=?', other)) return notFound(ctx);
  if (friendState(ctx.user.id, other) !== 'none') return redirect(ctx, '/u/' + other, 'Запрос уже есть или вы уже друзья.', 'err');
  if (limited('fr:' + ctx.user.id, 20, 3600)) return redirect(ctx, '/u/' + other, 'Слишком много запросов. Попробуйте позже.', 'err');
  run('INSERT INTO friends(from_id,to_id,status,created_at) VALUES(?,?,\'pending\',?)', ctx.user.id, other, now());
  redirect(ctx, '/u/' + other, 'Запрос в друзья отправлен.');
});
post('/u/:id/friend/accept', (ctx) => {
  if (needLogin(ctx)) return;
  const other = intOr(ctx.params.id);
  run("UPDATE friends SET status='accepted' WHERE from_id=? AND to_id=? AND status='pending'", other, ctx.user.id);
  redirect(ctx, '/u/' + other, 'Вы теперь друзья.');
});
post('/u/:id/friend/decline', (ctx) => {
  if (needLogin(ctx)) return;
  const other = intOr(ctx.params.id);
  run('DELETE FROM friends WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)', other, ctx.user.id, ctx.user.id, other);
  redirect(ctx, '/u/' + other, 'Запрос отклонён.');
});
post('/u/:id/friend/remove', (ctx) => {
  if (needLogin(ctx)) return;
  const other = intOr(ctx.params.id);
  run('DELETE FROM friends WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)', other, ctx.user.id, ctx.user.id, other);
  redirect(ctx, '/u/' + other, 'Из друзей удалён.');
});

/* ---- личные сообщения ---- */
get('/messages', (ctx) => {
  if (needLogin(ctx)) return;
  const mine = ctx.user.id;
  const rows = all('SELECT * FROM pms WHERE from_id=? OR to_id=? ORDER BY id DESC LIMIT 500', mine, mine);
  const dialogs = new Map();
  for (const m of rows) {
    const pid = m.from_id === mine ? m.to_id : m.from_id;
    if (!dialogs.has(pid)) dialogs.set(pid, { id: pid, last: m, unread: 0 });
    const d = dialogs.get(pid);
    if (m.from_id !== mine && !m.read_at) d.unread++;
  }
  const list = [...dialogs.values()].map((d) => {
    const u = one('SELECT id, username, rank, avatar FROM users WHERE id=?', d.id); if (!u) return '';
    return `<li class="${d.unread ? 'unread' : ''}"><a href="/messages/${d.id}">${avatar(u, 'lg')}
      <div><div class="dl-top">${nickHtml(u.username, u)} ${rankBadge(u)}${d.unread ? `<em>${d.unread}</em>` : ''}</div>
      <small>${esc((d.last.body || '').slice(0, 70))}</small></div><time>${fmtDate(d.last.created_at)}</time></a></li>`;
  }).join('');
  page(ctx, { title: 'Личные сообщения', active: '', content: panel('Личные сообщения', list ? `<ul class="dialogs">${list}</ul>` : `<p class="empty-s">Сообщений пока нет. Откройте профиль игрока и нажмите «Написать».</p>`, { ic: 'mail' }) });
});
get('/messages/:id', (ctx) => {
  if (needLogin(ctx)) return;
  const other = intOr(ctx.params.id);
  const u = one('SELECT * FROM users WHERE id=?', other); if (!u) return notFound(ctx);
  if (other === ctx.user.id) return redirect(ctx, '/messages', 'Это ваш диалог с самим собой :)', 'err');
  const mine = ctx.user.id;
  run('UPDATE pms SET read_at=? WHERE from_id=? AND to_id=? AND read_at=0', now(), other, mine);
  const msgs = all('SELECT * FROM pms WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id', mine, other, other, mine);
  const rows = msgs.map((m) => `<li class="${m.from_id === mine ? 'mine' : ''}">${avatar(m.from_id === mine ? ctx.user : u)}
    <div class="bubble"><div>${m.from_id === mine ? nickHtml(ctx.user.username, ctx.user) : nickHtml(u.username, withPriv(u))}</div>
    <p>${esc(m.body).replace(/\n/g, '<br>')}</p><small>${fmtDate(m.created_at)}</small></div></li>`).join('');
  const form = `<form method="post" action="/messages/${other}/send" class="form pad">${csrfField(ctx)}
    <label class="f"><span>Сообщение</span><textarea name="body" rows="3" required minlength="1" maxlength="1000" placeholder="Написать ${esc(u.username)}…"></textarea></label>
    <button class="btn solid" type="submit">Отправить</button></form>`;
  page(ctx, { title: 'Диалог: ' + u.username, active: '', content: `<div class="ptitle"><h1><a href="/u/${u.id}">${nickHtml(u.username, withPriv(u))}</a></h1>${rankBadge(u)}</div>
    ${panel('Диалог', rows ? `<ul class="pms">${rows}</ul>` : `<p class="empty-s">Сообщений пока нет.</p>`, { ic: 'mail', right: `<a class="more" href="/messages">Все диалоги ${icon('arrow')}</a>` })}${form}` });
});
post('/messages/:id/send', (ctx) => {
  if (needLogin(ctx)) return;
  const other = intOr(ctx.params.id), body = String(ctx.body.body || '').trim();
  if (other === ctx.user.id || !one('SELECT id FROM users WHERE id=?', other)) return notFound(ctx);
  if (limited('pm:' + ctx.user.id, 30, 600)) return redirect(ctx, '/messages/' + other, 'Слишком часто. Подождите немного.', 'err');
  if (body.length < 1 || body.length > 1000) return redirect(ctx, '/messages/' + other, 'Сообщение должно быть до 1000 символов.', 'err');
  run('INSERT INTO pms(from_id,to_id,body,created_at) VALUES(?,?,?,?)', ctx.user.id, other, body, now());
  redirect(ctx, '/messages/' + other, 'Сообщение отправлено.');
});

/* ---- кто сейчас на сайте ---- */
get('/online', (ctx) => {
  const rows = siteOnlineList();
  const list = rows.length ? `<ul class="online pad">${rows.map((u) => {
    const mine = ctx.user && ctx.user.id === u.id;
    const state = u.seen >= now() - 60 ? 'в сети' : ago(u.seen);
    return `<li>${avatar(u)}<a class="nm" href="/u/${u.id}">${nickHtml(u.username, withPriv(u))}</a>${rankBadge(u)}<time${mine ? ' class="me-time"' : ''}>${mine ? 'это вы' : state}</time></li>`;
  }).join('')}</ul>` : empty('Сейчас на сайте никого нет. Как только кто-нибудь войдёт — список обновится.');
  page(ctx, { title: 'Игроки на сайте', active: '', content: panel(`На сайте сейчас (${rows.length})`, list, { ic: 'users', right: `<a class="more" href="/servers">Серверы ${icon('arrow')}</a>` })
    + `<p class="hint">Список обновляется автоматически: сюда попадают те, кто открыл сайт в последние 5 минут. Нажмите на имя, чтобы открыть профиль — там ID, Telegram, привилегии и статистика.</p>` });
});

/* ---- главная */
get('/', (ctx) => {
  const rating = ratingBlock(ctx, { limit: 10, base: '/', anchor: '#rating' });
  const fresh = one('SELECT COUNT(*) c FROM users').c === 0
    ? `<div class="notice"><b>Сайт установлен.</b> Зарегистрируйтесь: первый аккаунт автоматически станет администратором. <a class="btn sm solid" href="/register">Создать аккаунт</a></div>` : '';
  page(ctx, { title: 'Главная', active: 'home', content: `${fresh}${heroBlock(ctx)}${serversBlock(ctx, 4)}<div class="lower">${newsBlock(4)}${rating.html}</div>` });
});
get('/api/live', (ctx) => {
  const t = liveTotals();
  send(ctx, 200, JSON.stringify({ players: t.players, max: t.max, site: siteOnlineCount(), servers: [...live.entries()].map(([id, v]) => ({ id, online: v.online, players: v.players, max: v.max, map: v.map })) }), 'application/json; charset=utf-8');
});

/* ---- серверы */
get('/servers', (ctx) => {
  const list = all('SELECT * FROM servers WHERE enabled=1 ORDER BY sort, id');
  const byNick = usersByNick();
  const blocks = list.map((s) => {
    const L = live.get(s.id);
    const pl = L?.online && L.list.length ? `<div class="tbl"><table><thead><tr><th>Игрок</th><th>Фраги</th><th>На сервере</th></tr></thead><tbody>${[...L.list].sort((a, b) => b.score - a.score).map((p) => `<tr><td><span class="pl">${avatar(byNick.get(p.name.toLowerCase()) || p.name)}${byNick.has(p.name.toLowerCase()) ? `<a href="/u/${byNick.get(p.name.toLowerCase()).id}">${nickHtml(p.name, byNick.get(p.name.toLowerCase()))}</a>` : `<b class="nick n-player">${esc(p.name)}</b>`}</span></td><td>${p.score}</td><td>${fmtClock(p.duration)}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="empty-s">${L?.online ? 'На сервере сейчас никого нет.' : L ? 'Сервер не отвечает.' : 'Идёт первая проверка сервера…'}</p>`;
    return `<div class="srvblock">${serverCard(s)}<section class="panel"><div class="ph"><h2>${icon('users')}Игроки на сервере «${esc(s.name)}»</h2></div>${pl}</section></div>`;
  }).join('');
  page(ctx, { title: 'Серверы', active: 'servers', content: list.length ? `<h1 class="pt">Серверы</h1>${blocks}` : panel('Серверы', empty('Серверов пока нет.', isAdmin(ctx) ? '<a class="btn solid" href="/admin/servers">Добавить сервер</a>' : ''), { ic: 'server' }) });
});

/* ---- статистика */
get('/stats', (ctx) => {
  const q = (ctx.query.get('q') || '').trim().slice(0, 32);
  const r = ratingBlock(ctx, { limit: 20, page: intOr(ctx.query.get('page'), 1), q, base: '/stats' });
  page(ctx, { title: 'Статистика', active: 'stats', content: `<h1 class="pt">Статистика игроков</h1>${r.html}<p class="hint">Рейтинг считается автоматически: сайт каждые ${Math.round(POLL_MS / 1000)} секунд опрашивает ваши серверы и записывает, кто играет, сколько времени и сколько фрагов набрал.</p>` });
});

/* ---- новости */
get('/news', (ctx) => {
  const per = 8, total = one('SELECT COUNT(*) c FROM news').c, pages = Math.max(1, Math.ceil(total / per)), p = clamp(intOr(ctx.query.get('page'), 1), 1, pages);
  const rows = all('SELECT n.*, (SELECT COUNT(*) FROM news_comments c WHERE c.news_id=n.id) AS cc FROM news n ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', per, (p - 1) * per);
  const inner = rows.length ? `<ul class="news big">${rows.map((n) => `<li><div class="th" data-art="news" data-seed="${n.id}"><span>${esc([...n.tag][0] || 'N')}</span></div><div><span class="tg">${esc(n.tag)}</span><h3><a href="/news/${n.id}">${esc(n.title)}</a></h3>
    <p>${esc(n.body.replace(/\s+/g, ' ').slice(0, 220))}${n.body.length > 220 ? '…' : ''}</p><div class="meta"><span>${icon('clock')}${fmtDate(n.created_at)}</span><span>${icon('comment')}${n.cc}</span></div></div></li>`).join('')}</ul>${pager(ctx, p, pages)}`
    : empty('Новостей пока нет.', isAdmin(ctx) ? '<a class="btn solid" href="/admin/news">Написать новость</a>' : '');
  page(ctx, { title: 'Новости', active: 'news', content: panel('Новости', inner, { ic: 'news' }) });
});
get('/news/:id', (ctx) => {
  const n = one('SELECT * FROM news WHERE id=?', intOr(ctx.params.id));
  if (!n) return notFound(ctx);
  const cs = all('SELECT c.*, u.id AS user_id, u.username, u.rank, u.avatar FROM news_comments c JOIN users u ON u.id=c.user_id WHERE news_id=? ORDER BY c.id', n.id);
  withPrivMany(cs);
  const form = ctx.user ? `<form method="post" action="/news/${n.id}/comment" class="form">${csrfField(ctx)}<label class="f"><span>Ваш комментарий</span><textarea name="body" rows="3" maxlength="2000" required></textarea></label><button class="btn solid" type="submit">Отправить</button></form>`
    : `<p class="hint"><a href="/login?next=${encodeURIComponent('/news/' + n.id)}">Войдите</a>, чтобы оставить комментарий.</p>`;
  const list = cs.map((c) => `<li class="cmt">${avatar(c, 'lg')}<div><a href="/u/${c.user_id}">${nickHtml(c.username, c)}</a> ${rankBadge(c)} <small>${fmtDate(c.created_at)}</small>${text(c.body)}
    ${isAdmin(ctx) ? `<form method="post" action="/news/${n.id}/comment/${c.id}/delete" data-confirm="Удалить комментарий?">${csrfField(ctx)}<button class="lnk" type="submit">Удалить</button></form>` : ''}</div></li>`).join('');
  page(ctx, { title: n.title, active: 'news', content: `<article class="panel article"><div class="ph"><span class="tg">${esc(n.tag)}</span><small class="muted">${fmtDate(n.created_at)}</small></div><div class="prose"><h1>${esc(n.title)}</h1>${text(n.body)}</div></article>
    ${panel(`Комментарии (${cs.length})`, `<div class="pad">${cs.length ? `<ul class="cmts">${list}</ul>` : '<p class="empty-s">Комментариев пока нет.</p>'}${form}</div>`, { ic: 'comment' })}` });
});
post('/news/:id/comment', (ctx) => {
  if (needLogin(ctx)) return;
  const n = one('SELECT id FROM news WHERE id=?', intOr(ctx.params.id)); if (!n) return notFound(ctx);
  const body = String(ctx.body.body || '').trim();
  if (limited('cm:' + ctx.user.id, 10, 300)) return redirect(ctx, '/news/' + n.id, 'Слишком часто. Подождите немного.', 'err');
  if (body.length < 2 || body.length > 2000) return redirect(ctx, '/news/' + n.id, 'Комментарий должен быть от 2 до 2000 символов.', 'err');
  run('INSERT INTO news_comments(news_id,user_id,body,created_at) VALUES(?,?,?,?)', n.id, ctx.user.id, body, now());
  redirect(ctx, '/news/' + n.id, 'Комментарий добавлен.');
});
post('/news/:id/comment/:cid/delete', (ctx) => {
  if (needAdmin(ctx)) return;
  run('DELETE FROM news_comments WHERE id=? AND news_id=?', intOr(ctx.params.cid), intOr(ctx.params.id));
  redirect(ctx, '/news/' + intOr(ctx.params.id), 'Комментарий удалён.');
});

/* ---- банлист */
get('/bans', (ctx) => {
  const q = (ctx.query.get('q') || '').trim().slice(0, 40), like = '%' + q.replace(/[%_]/g, '') + '%';
  const per = 20, t = now();
  const total = one('SELECT COUNT(*) c FROM bans WHERE (expires_at IS NULL OR expires_at>?) AND (nick LIKE ? OR target LIKE ?)', t, like, like).c;
  const pages = Math.max(1, Math.ceil(total / per)), p = clamp(intOr(ctx.query.get('page'), 1), 1, pages);
  const rows = all('SELECT * FROM bans WHERE (expires_at IS NULL OR expires_at>?) AND (nick LIKE ? OR target LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?', t, like, like, per, (p - 1) * per);
  const body = rows.length ? `<div class="tbl"><table><thead><tr><th>Ник</th><th>SteamID / IP</th><th>Причина</th><th>Админ</th><th>Дата</th><th>До</th></tr></thead><tbody>${rows.map((b) => `<tr><td class="l">${esc(b.nick)}</td><td class="l">${esc(b.target || '—')}</td><td class="l wrap">${esc(b.reason || '—')}</td><td class="l">${esc(b.admin_name || '—')}</td><td>${fmtDate(b.created_at, false)}</td><td>${b.expires_at ? fmtDate(b.expires_at, false) : 'навсегда'}</td></tr>`).join('')}</tbody></table></div>${pager(ctx, p, pages)}`
    : empty(q ? 'Ничего не найдено.' : 'Банлист пуст. Здесь будут нарушители, которых добавит администратор.');
  page(ctx, { title: 'Банлист', active: 'bans', content: `<section class="panel"><div class="ph"><h2>${icon('ban')}Банлист</h2><form class="search" method="get" action="/bans"><input name="q" value="${esc(q)}" placeholder="Ник или SteamID" aria-label="Поиск"><button class="btn sm" type="submit">Найти</button></form></div>${body}</section>` });
});

/* ---- контакты */
get('/contacts', (ctx) => {
  const items = [['contact_email', 'Почта', (v) => `<a href="mailto:${esc(v)}">${esc(v)}</a>`], ['contact_telegram', 'Telegram', (v) => `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`],
    ['contact_discord', 'Discord', (v) => `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`], ['contact_vk', 'ВКонтакте', (v) => `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`]]
    .filter(([k]) => S(k)).map(([k, l, f]) => `<li><span>${l}</span>${f(S(k))}</li>`).join('');
  const form = `<form method="post" action="/contacts" class="form pad">${csrfField(ctx)}
    ${field(ctx, 'name', 'Ваше имя', `required maxlength="40" value="${esc(ctx.user?.username || '')}"`)}
    ${field(ctx, 'contact', 'Как с вами связаться (Telegram, почта, Discord)', 'required maxlength="80"')}
    ${field(ctx, 'subject', 'Тема', 'maxlength="100"')}
    <label class="f"><span>Сообщение</span><textarea name="body" rows="5" required minlength="5" maxlength="3000"></textarea></label>
    <button class="btn solid" type="submit">Отправить</button></form>`;
  page(ctx, { title: 'Контакты', active: 'contacts', content: `<h1 class="pt">Контакты</h1><div class="two">${panel('Написать администрации', form, { ic: 'mail' })}${panel('Где нас найти', items ? `<ul class="contact-list pad">${items}</ul>` : empty('Контакты ещё не заполнены.', isAdmin(ctx) ? '<a class="btn solid" href="/admin/settings">Заполнить в настройках</a>' : ''), { ic: 'globe' })}</div>` });
});
post('/contacts', (ctx) => {
  const b = ctx.body, name = String(b.name || '').trim(), contact = String(b.contact || '').trim(), body = String(b.body || '').trim();
  if (limited('ct:' + ctx.ip, 5, 3600)) return redirect(ctx, '/contacts', 'Вы отправили слишком много сообщений. Попробуйте позже.', 'err');
  if (!name || !contact || body.length < 5) return redirect(ctx, '/contacts', 'Заполните имя, контакт и сообщение.', 'err');
  run('INSERT INTO messages(name,contact,subject,body,created_at) VALUES(?,?,?,?,?)', name.slice(0, 40), contact.slice(0, 80), String(b.subject || '').trim().slice(0, 100), body.slice(0, 3000), now());
  redirect(ctx, '/contacts', 'Сообщение отправлено. Мы ответим как можно скорее.');
});

/* ---- регистрация / вход */
const safeNext = (n) => (typeof n === 'string' && /^\/[^/\\]/.test(n) ? n : '/');
function startSession(ctx, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)', token, userId, now() + 30 * 86400);
  ctx.setCookie('sid', token, { maxAge: 30 * 86400, httpOnly: true });
}
get('/register', (ctx) => {
  if (ctx.user) return redirect(ctx, '/cabinet');
  page(ctx, { title: 'Регистрация', side: false, content: `<div class="authbox">${panel('Регистрация', `<form method="post" action="/register" class="form pad">${csrfField(ctx)}
    ${field(ctx, 'username', 'Логин (латиница, цифры, _ и -, 3–20 символов)', 'required minlength="3" maxlength="20" pattern="[A-Za-z0-9_\\-]{3,20}" autocomplete="username"')}
    ${field(ctx, 'game_nick', 'Ник в игре (необязательно)', 'maxlength="32"')}
    ${field(ctx, 'password', 'Пароль (минимум 6 символов)', 'type="password" required minlength="6" autocomplete="new-password"')}
    ${field(ctx, 'password2', 'Повторите пароль', 'type="password" required minlength="6" autocomplete="new-password"')}
    <button class="btn solid block" type="submit">Создать аккаунт</button><p class="hint">Уже есть аккаунт? <a href="/login">Войти</a></p></form>`, { ic: 'user' })}</div>` });
});
post('/register', (ctx) => {
  const b = ctx.body, u = String(b.username || '').trim();
  if (limited('reg:' + ctx.ip, 5, 3600)) return redirect(ctx, '/register', 'Слишком много попыток. Попробуйте позже.', 'err');
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(u)) return redirect(ctx, '/register', 'Логин: 3–20 символов, только латиница, цифры, _ и -.', 'err');
  if (String(b.password || '').length < 6) return redirect(ctx, '/register', 'Пароль должен быть не короче 6 символов.', 'err');
  if (b.password !== b.password2) return redirect(ctx, '/register', 'Пароли не совпадают.', 'err');
  if (one('SELECT id FROM users WHERE username=?', u)) return redirect(ctx, '/register', 'Этот логин уже занят.', 'err');
  const first = one('SELECT COUNT(*) c FROM users').c === 0;
  const r = run('INSERT INTO users(username,pass,role,rank,game_nick,created_at) VALUES(?,?,?,?,?,?)', u, hashPw(b.password), first ? 'admin' : 'user', first ? 'creator' : 'player', String(b.game_nick || '').trim().slice(0, 32), now());
  startSession(ctx, Number(r.lastInsertRowid));
  redirect(ctx, first ? '/admin' : '/cabinet', first ? 'Аккаунт создан. Вы первый пользователь, поэтому вы администратор сайта.' : 'Добро пожаловать!');
});
get('/login', (ctx) => {
  if (ctx.user) return redirect(ctx, '/cabinet');
  page(ctx, { title: 'Вход', side: false, content: `<div class="authbox">${panel('Вход', `<form method="post" action="/login" class="form pad">${csrfField(ctx)}<input type="hidden" name="next" value="${esc(safeNext(ctx.query.get('next')))}">
    ${field(ctx, 'username', 'Логин', 'required autocomplete="username"')}${field(ctx, 'password', 'Пароль', 'type="password" required autocomplete="current-password"')}
    <button class="btn solid block" type="submit">Войти</button><p class="hint">Нет аккаунта? <a href="/register">Зарегистрироваться</a></p></form>`, { ic: 'lock' })}</div>` });
});
post('/login', (ctx) => {
  if (limited('login:' + ctx.ip, 10, 600)) return redirect(ctx, '/login', 'Слишком много попыток входа. Подождите 10 минут.', 'err');
  const u = one('SELECT * FROM users WHERE username=?', String(ctx.body.username || '').trim());
  if (!u) return redirect(ctx, '/login', 'Неверный логин или пароль.', 'err');
  if (u.locked_until > now()) {
    const left = Math.max(1, Math.ceil((u.locked_until - now()) / 60));
    return redirect(ctx, '/login', `Аккаунт временно заблокирован: 3 неверных пароля. Осталось ${left} мин.`, 'err');
  }
  if (isActive(u)) return redirect(ctx, '/login', `Аккаунт заблокирован администрацией: ${u.ban_reason || 'нарушение правил'}.`, 'err');
  if (!checkPw(String(ctx.body.password || ''), u.pass)) {
    const fails = u.login_fails + 1;
    if (fails >= 3) {
      const mins = u.lock_count >= 1 ? 60 : 15;
      run('UPDATE users SET login_fails=0, lock_count=lock_count+1, locked_until=? WHERE id=?', now() + mins * 60, u.id);
      return redirect(ctx, '/login', `Неверный пароль. Три неудачные попытки подряд — вход закрыт на ${mins} минут.`, 'err');
    }
    run('UPDATE users SET login_fails=? WHERE id=?', fails, u.id);
    return redirect(ctx, '/login', `Неверный логин или пароль. Осталось попыток: ${3 - fails}.`, 'err');
  }
  run('UPDATE users SET login_fails=0, lock_count=0, locked_until=0 WHERE id=?', u.id);
  startSession(ctx, u.id);
  redirect(ctx, safeNext(ctx.body.next), 'Вы вошли как ' + u.username + '.');
});
post('/logout', (ctx) => {
  if (ctx.sid) run('DELETE FROM sessions WHERE token=?', ctx.sid);
  ctx.setCookie('sid', '', { maxAge: 0, httpOnly: true });
  redirect(ctx, '/', 'Вы вышли из аккаунта.');
});

/* ---- личный кабинет */
get('/cabinet', (ctx) => {
  if (needLogin(ctx)) return;
  const u = ctx.user, orders = all('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 30', u.id);
  const st = { new: 'Ожидает выдачи', done: 'Выдано', cancelled: 'Отменён' };
  const ord = orders.length ? `<div class="tbl"><table><thead><tr><th>№</th><th>Товар</th><th>Ник</th><th>Цена</th><th>Дата</th><th>Статус</th></tr></thead><tbody>${orders.map((o) => `<tr><td>${o.id}</td><td class="l">${esc(o.product_name)}</td><td class="l">${esc(o.game_nick)}</td><td>${money(o.price)}</td><td>${fmtDate(o.created_at, false)}</td><td><span class="pill ${esc(o.status)}">${st[o.status] || esc(o.status)}</span></td></tr>`).join('')}</tbody></table></div>` : empty('Покупок пока нет.', '<a class="btn solid" href="/shop">В магазин</a>');
  const stat = u.game_nick ? one('SELECT * FROM players WHERE name=?', u.game_nick) : null;
  page(ctx, { title: 'Личный кабинет', content: `<h1 class="pt">Личный кабинет</h1>
    <div class="two">${panel('Профиль', `<form method="post" action="/cabinet/profile" class="form pad">${csrfField(ctx)}
      <p class="kv"><span>ID на сайте</span><b>#${u.id}</b></p><p class="kv"><span>Ранг</span><b>${rankBadge(u)}</b></p>
      <p class="kv"><span>Логин</span><b>${esc(u.username)}</b></p><p class="kv"><span>Баланс</span><b>${money(u.balance)}</b> <a class="btn sm" href="/topup">Пополнить</a></p><p class="kv"><span>Регистрация</span><b>${fmtDate(u.created_at, false)}</b></p>
      <p class="kv"><span>Профиль</span><b><a href="/u/${u.id}">/u/${u.id} ${icon('arrow')}</a></b></p>
      ${field(ctx, 'game_nick', 'Ник в игре', `maxlength="32" value="${esc(u.game_nick)}"`)}${field(ctx, 'steam_id', 'SteamID (например STEAM_0:1:12345)', `maxlength="40" value="${esc(u.steam_id)}"`)}
      ${field(ctx, 'telegram', 'Telegram (например @obito или https://t.me/obito)', `maxlength="60" value="${esc(u.telegram)}"`)}
      <div class="uprow"><p class="sub" style="margin:4px 0 0">Аватар</p><div class="upgrid">
        <label class="f"><span>Картинка для аватара (JPG/PNG/WebP/GIF до 8 МБ)</span><input type="file" accept="image/*" data-upload="avatar_b64"></label>
        <input type="hidden" name="avatar_b64" id="avatar_b64" value="">
        ${u.avatar ? `<div class="upprev avprev"><img src="${esc(u.avatar)}" alt="Ваш аватар"><small>${esc(u.avatar)}</small></div>` : '<small class="muted">Сейчас аватар — буква логина. Выберите картинку, чтобы заменить.</small>'}
        ${u.avatar ? '<label class="chk"><input type="checkbox" name="avatar_del" value="1"> Убрать аватар (вернуть букву)</label>' : ''}
      </div></div>
      <button class="btn solid" type="submit">Сохранить</button></form>`, { ic: 'user' })}
    ${panel('Пароль и статистика', `<div class="pad"><form method="post" action="/cabinet/password" class="form">${csrfField(ctx)}${field(ctx, 'old', 'Текущий пароль', 'type="password" required autocomplete="current-password"')}${field(ctx, 'password', 'Новый пароль', 'type="password" required minlength="6" autocomplete="new-password"')}<button class="btn" type="submit">Сменить пароль</button></form>
      <h3 class="sub">Ваша игровая статистика</h3>${stat ? `<p class="kv"><span>Время</span><b>${fmtHours(stat.seconds)}</b></p><p class="kv"><span>Фраги</span><b>${fmtNum(stat.frags)}</b></p><p class="kv"><span>Заходов</span><b>${stat.visits}</b></p>`
        : `<p class="empty-s">${u.game_nick ? 'Игрока с таким ником ещё нет в рейтинге. Зайдите на сервер.' : 'Укажите ник в игре, чтобы видеть здесь свою статистику.'}</p>`}</div>`, { ic: 'chart' })}</div>
    ${panel('Мои привилегии', privRows(activePrivs(u.id), true), { ic: 'shield' })}
    ${panel('Мои покупки', ord, { ic: 'shop' })}` });
});
post('/cabinet/profile', (ctx) => {
  if (needLogin(ctx)) return;
  let avatar = ctx.user.avatar || '';
  if (ctx.body.avatar_del) { if (avatar) dropUpload(avatar); avatar = ''; }
  if (ctx.body.avatar_b64) {
    const saved = saveB64Image(ctx.body.avatar_b64, 'avatar');
    if (!saved) return redirect(ctx, '/cabinet', 'Аватар не сохранён: нужен JPG, PNG, WebP или GIF до 8 МБ.', 'err');
    if (avatar) dropUpload(avatar);
    avatar = saved;
  }
  run('UPDATE users SET game_nick=?, steam_id=?, telegram=?, avatar=? WHERE id=?', String(ctx.body.game_nick || '').trim().slice(0, 32), String(ctx.body.steam_id || '').trim().slice(0, 40), String(ctx.body.telegram || '').trim().slice(0, 60), avatar, ctx.user.id);
  redirect(ctx, '/cabinet', avatar ? 'Аватар и профиль сохранены.' : 'Профиль сохранён.');
});
post('/cabinet/password', (ctx) => {
  if (needLogin(ctx)) return;
  if (!checkPw(String(ctx.body.old || ''), ctx.user.pass)) return redirect(ctx, '/cabinet', 'Текущий пароль указан неверно.', 'err');
  if (String(ctx.body.password || '').length < 6) return redirect(ctx, '/cabinet', 'Новый пароль слишком короткий.', 'err');
  run('UPDATE users SET pass=? WHERE id=?', hashPw(ctx.body.password), ctx.user.id);
  run('DELETE FROM sessions WHERE user_id=? AND token<>?', ctx.user.id, ctx.sid);
  redirect(ctx, '/cabinet', 'Пароль изменён.');
});

/* ---- магазин и пополнение */
get('/shop', (ctx) => {
  const items = all('SELECT * FROM products WHERE active=1 ORDER BY sort, id');
  const cards = items.map((p) => `<article class="panel prod"><h3${p.color ? ` style="color:${esc(p.color)}"` : ''}>${p.prefix ? `<i class="pfx"${p.color ? ` style="border-color:${esc(p.color)};color:${esc(p.color)}"` : ''}>${esc(p.prefix)}</i> ` : ''}${esc(p.name)}</h3>
    <div class="price">${money(p.price)}<small>${p.days ? p.days + ' дн.' : 'навсегда'}</small></div>
    ${p.color ? `<span class="chip"><span class="dotc" style="background:${esc(p.color)};box-shadow:0 0 8px ${esc(p.color)}"></span>Цвет ника</span>` : ''}
    ${p.descr ? text(p.descr) : ''}
    ${ctx.user ? `<form method="post" action="/shop/buy/${p.id}" class="form" data-confirm="Купить «${esc(p.name)}» за ${p.price} ${esc(S('currency'))}?">${csrfField(ctx)}${field(ctx, 'game_nick', 'Ник в игре', `required maxlength="32" value="${esc(ctx.user.game_nick)}"`)}${field(ctx, 'gift_id', 'Подарок: ID игрока на сайте (необязательно)', 'type="number" min="1" placeholder="например 2"')}<button class="btn solid block" type="submit">Купить</button></form>`
      : `<a class="btn block" href="/login?next=/shop">Войдите, чтобы купить</a>`}</article>`).join('');
  page(ctx, { title: 'Магазин', active: 'shop', content: `<h1 class="pt">Магазин привилегий</h1>${ctx.user ? `<p class="hint">Ваш баланс: <b>${money(ctx.user.balance)}</b>. <a href="/topup">Пополнить</a></p>` : ''}
    ${items.length ? `<div class="prods">${cards}</div>` : panel('Магазин', empty('Товаров пока нет.', isAdmin(ctx) ? '<a class="btn solid" href="/admin/products">Добавить товар</a>' : 'Загляните позже.'), { ic: 'shop' })}` });
});
post('/shop/buy/:id', (ctx) => {
  if (needLogin(ctx)) return;
  const p = one('SELECT * FROM products WHERE id=? AND active=1', intOr(ctx.params.id)); if (!p) return notFound(ctx);
  const nick = String(ctx.body.game_nick || '').trim().slice(0, 32);
  if (!nick) return redirect(ctx, '/shop', 'Укажите ник в игре.', 'err');
  const giftId = intOr(ctx.body.gift_id, 0);
  if (giftId) {
    if (giftId === ctx.user.id) return redirect(ctx, '/shop', 'ID подарка совпадает с вашим — покупайте для себя.', 'err');
    if (!one('SELECT id FROM users WHERE id=?', giftId)) return redirect(ctx, '/shop', `Игрока с ID ${giftId} не существует.`, 'err');
  }
  try {
    tx(() => {
      const u = one('SELECT balance FROM users WHERE id=?', ctx.user.id);
      if (u.balance < p.price) throw new Error('funds');
      run('UPDATE users SET balance=balance-? WHERE id=?', p.price, ctx.user.id);
      run('INSERT INTO orders(user_id,product_id,product_name,price,days,game_nick,created_at) VALUES(?,?,?,?,?,?,?)', giftId || ctx.user.id, p.id, p.name, p.price, p.days, nick, now());
    });
  } catch (e) { return redirect(ctx, '/shop', e.message === 'funds' ? 'Недостаточно средств. Пополните баланс.' : 'Не удалось оформить покупку.', 'err'); }
  redirect(ctx, '/cabinet', giftId
    ? `Подарок оформлен: привилегия «${p.name}» уйдёт игроку с ID ${giftId} после выдачи в админ-панели.`
    : 'Покупка оформлена. Администратор выдаст привилегию на ваш ник в ближайшее время.');
});
const topupLimits = () => { const min = Math.max(1, intOr(S('topup_min'), 100)); return [min, Math.max(min, intOr(S('topup_max'), 999999))]; };
get('/topup', (ctx) => {
  const [min, max] = topupLimits(), card = S('card_number');
  const c = [['contact_telegram', 'Telegram'], ['contact_discord', 'Discord'], ['contact_vk', 'ВКонтакте'], ['contact_email', 'Почта']].filter(([k]) => S(k)).map(([k, l]) => `<li><span>${l}</span>${/^https?:/.test(S(k)) ? `<a href="${esc(S(k))}" target="_blank" rel="noopener">${esc(S(k))}</a>` : esc(S(k))}</li>`).join('');
  let body = `<div class="pad prose">${text(S('topup_text'))}</div>`;
  if (!card) {
    body += empty('Реквизиты для пополнения ещё не указаны.', isAdmin(ctx) ? '<a class="btn solid" href="/admin/settings">Указать карту в настройках</a>' : 'Напишите администратору, он подскажет, как пополнить баланс.');
  } else {
    body += `<div class="pad"><div class="cardbox"><span>Карта для перевода</span><b>${esc(card)}</b><small>${esc([S('card_holder'), S('card_bank')].filter(Boolean).join(' · '))}</small><button type="button" class="btn sm" data-copytext="${esc(card.replace(/\s/g, ''))}">Скопировать номер</button></div>
      ${ctx.user ? `<form method="post" action="/topup" class="form topup">${csrfField(ctx)}<label class="f"><span>Сумма пополнения (от ${fmtNum(min)} до ${fmtNum(max)} ${esc(S('currency'))})</span><input name="amount" type="number" min="${min}" max="${max}" step="1" inputmode="numeric" required placeholder="например, 500"></label>
        <button class="btn solid" type="submit">Создать заявку</button>
        <p class="hint">1) Создайте заявку. 2) Переведите ровно эту сумму на карту и в комментарии напишите логин <b>${esc(ctx.user.username)}</b>. 3) Администратор проверит перевод и зачислит деньги на баланс.</p></form>`
        : `<p class="hint"><a href="/login?next=/topup">Войдите</a> или <a href="/register">зарегистрируйтесь</a>, чтобы создать заявку на пополнение.</p>`}</div>`;
  }
  let mine = '';
  if (ctx.user) {
    const rows = all('SELECT * FROM topups WHERE user_id=? ORDER BY id DESC LIMIT 15', ctx.user.id), st = { new: 'Ждёт проверки', paid: 'Зачислено', rejected: 'Отклонено' };
    if (rows.length) mine = panel('Мои заявки на пополнение', `<div class="tbl plain"><table><thead><tr><th class="l">№</th><th>Сумма</th><th>Дата</th><th>Статус</th></tr></thead><tbody>${rows.map((t) => `<tr><td class="l">${t.id}</td><td>${money(t.amount)}</td><td>${fmtDate(t.created_at)}</td><td><span class="pill ${t.status === 'paid' ? 'done' : t.status === 'new' ? 'new' : 'cancelled'}">${st[t.status]}</span></td></tr>`).join('')}</tbody></table></div>`, { ic: 'clock' });
  }
  page(ctx, { title: 'Пополнение баланса', active: 'shop', content: `${panel('Пополнение баланса', body + (c ? `<ul class="contact-list pad">${c}</ul>` : ''), { ic: 'shop' })}${mine}` });
});
post('/topup', (ctx) => {
  if (needLogin(ctx)) return;
  const [min, max] = topupLimits(), amount = intOr(ctx.body.amount, 0);
  if (!S('card_number')) return redirect(ctx, '/topup', 'Реквизиты для пополнения ещё не указаны.', 'err');
  if (amount < min || amount > max) return redirect(ctx, '/topup', `Сумма должна быть от ${min} до ${max} ${S('currency')}.`, 'err');
  if (one("SELECT COUNT(*) c FROM topups WHERE user_id=? AND status='new'", ctx.user.id).c >= 5) return redirect(ctx, '/topup', 'У вас уже 5 заявок в ожидании. Дождитесь проверки.', 'err');
  const r = run('INSERT INTO topups(user_id,amount,created_at) VALUES(?,?,?)', ctx.user.id, amount, now());
  redirect(ctx, '/topup', `Заявка №${r.lastInsertRowid} создана. Переведите ровно ${amount} ${S('currency')} на карту ${S('card_number')} и в комментарии укажите логин ${ctx.user.username}.`);
});

/* ---- форум */
const forumCrumbs = (...parts) => `<nav class="crumbs"><a href="/forum">Форум</a>${parts.map(([h, t]) => ` ${icon('chev')} ${h ? `<a href="${h}">${esc(t)}</a>` : `<span>${esc(t)}</span>`}`).join('')}</nav>`;
get('/forum', (ctx) => {
  const cats = all(`SELECT c.*, (SELECT COUNT(*) FROM topics t WHERE t.cat_id=c.id) AS tc,
    (SELECT COUNT(*) FROM posts p JOIN topics t ON t.id=p.topic_id WHERE t.cat_id=c.id) AS pc,
    (SELECT t.id FROM topics t WHERE t.cat_id=c.id ORDER BY t.last_post_at DESC LIMIT 1) AS lt FROM forum_cats c ORDER BY sort, id`);
  const rows = cats.map((c) => { const lt = c.lt ? one('SELECT t.id,t.title,t.last_post_at FROM topics t WHERE id=?', c.lt) : null;
    return `<li><span class="fi">${icon('chat')}</span><div><a class="ft" href="/forum/c/${c.id}">${esc(c.title)}</a><small>${esc(c.descr)}</small></div><span class="fs"><b>${c.tc}</b> тем<br><b>${c.pc}</b> сообщ.</span>
    <span class="fl">${lt ? `<a href="/forum/t/${lt.id}">${esc(lt.title.slice(0, 40))}</a><small>${fmtDate(lt.last_post_at)}</small>` : '<small>нет тем</small>'}</span></li>`; }).join('');
  const fb = S('forum_image');
  const banner = fb ? `<section class="panel pagebanner"><img src="${esc(fb)}" alt=""></section>` : '';
  page(ctx, { title: 'Форум', active: 'forum', content: `${banner}<h1 class="pt">Форум</h1>${cats.length ? `<section class="panel"><ul class="flist">${rows}</ul></section>` : panel('Форум', empty('Разделов пока нет.', isAdmin(ctx) ? '<a class="btn solid" href="/admin/cats">Создать раздел</a>' : 'Администратор скоро их создаст.'), { ic: 'chat' })}` });
});
get('/forum/c/:id', (ctx) => {
  const c = one('SELECT * FROM forum_cats WHERE id=?', intOr(ctx.params.id)); if (!c) return notFound(ctx);
  const per = 20, total = one('SELECT COUNT(*) c FROM topics WHERE cat_id=?', c.id).c, pages = Math.max(1, Math.ceil(total / per)), p = clamp(intOr(ctx.query.get('page'), 1), 1, pages);
  const ts = all(`SELECT t.*, u.id AS user_id, u.username, u.rank, (SELECT COUNT(*) FROM posts WHERE topic_id=t.id)-1 AS replies FROM topics t JOIN users u ON u.id=t.user_id WHERE cat_id=? ORDER BY pinned DESC, last_post_at DESC LIMIT ? OFFSET ?`, c.id, per, (p - 1) * per);
  withPrivMany(ts);
  const list = ts.length ? `<ul class="flist">${ts.map((t) => `<li><span class="fi">${t.pinned ? icon('pin') : icon('comment')}</span><div><a class="ft" href="/forum/t/${t.id}">${esc(t.title)}</a>${t.closed ? ' <span class="pill cancelled">закрыта</span>' : ''}<small>${nickHtml(t.username, t)} ${fmtDate(t.created_at)}</small></div>
    <span class="fs"><b>${t.replies}</b> ответов<br><b>${t.views}</b> просм.</span><span class="fl"><small>${fmtDate(t.last_post_at)}</small></span></li>`).join('')}</ul>${pager(ctx, p, pages)}` : empty('В этом разделе пока нет тем. Создайте первую!');
  const form = ctx.user ? panel('Новая тема', `<form method="post" action="/forum/c/${c.id}/new" class="form pad">${csrfField(ctx)}${field(ctx, 'title', 'Заголовок', 'required minlength="3" maxlength="120"')}<label class="f"><span>Сообщение</span><textarea name="body" rows="5" required minlength="2" maxlength="10000"></textarea></label><button class="btn solid" type="submit">Создать тему</button></form>`, { ic: 'plus' })
    : `<p class="hint"><a href="/login?next=${encodeURIComponent('/forum/c/' + c.id)}">Войдите</a>, чтобы создавать темы.</p>`;
  page(ctx, { title: c.title, active: 'forum', content: `${forumCrumbs([null, c.title])}${panel(esc(c.title), list, { ic: 'chat' })}${form}` });
});
post('/forum/c/:id/new', (ctx) => {
  if (needLogin(ctx)) return;
  const c = one('SELECT id FROM forum_cats WHERE id=?', intOr(ctx.params.id)); if (!c) return notFound(ctx);
  const title = String(ctx.body.title || '').trim(), body = String(ctx.body.body || '').trim();
  if (limited('tp:' + ctx.user.id, 5, 600)) return redirect(ctx, '/forum/c/' + c.id, 'Слишком часто. Подождите несколько минут.', 'err');
  if (title.length < 3 || title.length > 120 || body.length < 2 || body.length > 10000) return redirect(ctx, '/forum/c/' + c.id, 'Проверьте заголовок и текст сообщения.', 'err');
  const id = tx(() => { const t = now(); const r = run('INSERT INTO topics(cat_id,user_id,title,created_at,last_post_at) VALUES(?,?,?,?,?)', c.id, ctx.user.id, title, t, t); run('INSERT INTO posts(topic_id,user_id,body,created_at) VALUES(?,?,?,?)', r.lastInsertRowid, ctx.user.id, body, t); return Number(r.lastInsertRowid); });
  redirect(ctx, '/forum/t/' + id, 'Тема создана.');
});
get('/forum/t/:id', (ctx) => {
  const t = one('SELECT t.*, c.title AS cat_title FROM topics t JOIN forum_cats c ON c.id=t.cat_id WHERE t.id=?', intOr(ctx.params.id)); if (!t) return notFound(ctx);
  run('UPDATE topics SET views=views+1 WHERE id=?', t.id);
  const per = 15, total = one('SELECT COUNT(*) c FROM posts WHERE topic_id=?', t.id).c, pages = Math.max(1, Math.ceil(total / per)), p = clamp(intOr(ctx.query.get('page'), 1), 1, pages);
  const ps = all('SELECT p.*, u.id AS user_id, u.username, u.rank, u.avatar FROM posts p JOIN users u ON u.id=p.user_id WHERE topic_id=? ORDER BY p.id LIMIT ? OFFSET ?', t.id, per, (p - 1) * per);
  withPrivMany(ps);
  const first = one('SELECT MIN(id) m FROM posts WHERE topic_id=?', t.id).m;
  const mod = canMod(ctx) ? `<div class="mod"><form method="post" action="/forum/t/${t.id}/pin">${csrfField(ctx)}<button class="btn sm" type="submit">${t.pinned ? 'Открепить' : 'Закрепить'}</button></form>
    <form method="post" action="/forum/t/${t.id}/close">${csrfField(ctx)}<button class="btn sm" type="submit">${t.closed ? 'Открыть' : 'Закрыть'}</button></form>
    <form method="post" action="/forum/t/${t.id}/delete" data-confirm="Удалить тему целиком?">${csrfField(ctx)}<button class="btn sm danger" type="submit">Удалить тему</button></form></div>` : '';
  const posts = ps.map((x) => `<li class="post" id="p${x.id}"><div class="who">${avatar(x, 'lg')}<a href="/u/${x.user_id}">${nickHtml(x.username, x)}</a>${rankBadge(x)}</div><div class="pb"><small class="muted">${fmtDate(x.created_at)}</small><div class="prose">${text(x.body)}</div>
    ${canMod(ctx) && x.id !== first ? `<form method="post" action="/forum/p/${x.id}/delete" data-confirm="Удалить сообщение?">${csrfField(ctx)}<button class="lnk" type="submit">Удалить</button></form>` : ''}</div></li>`).join('');
  const reply = t.closed ? '<p class="hint">Тема закрыта.</p>' : ctx.user ? panel('Ответить', `<form method="post" action="/forum/t/${t.id}/reply" class="form pad">${csrfField(ctx)}<label class="f"><span>Сообщение</span><textarea name="body" rows="4" required minlength="2" maxlength="10000"></textarea></label><button class="btn solid" type="submit">Отправить</button></form>`, { ic: 'comment' })
    : `<p class="hint"><a href="/login?next=${encodeURIComponent('/forum/t/' + t.id)}">Войдите</a>, чтобы ответить.</p>`;
  page(ctx, { title: t.title, active: 'forum', content: `${forumCrumbs([`/forum/c/${t.cat_id}`, t.cat_title], [null, t.title])}<div class="ptitle"><h1>${esc(t.title)}</h1>${mod}</div><section class="panel"><ul class="posts">${posts}</ul>${pager(ctx, p, pages)}</section>${reply}` });
});
post('/forum/t/:id/reply', (ctx) => {
  if (needLogin(ctx)) return;
  const t = one('SELECT * FROM topics WHERE id=?', intOr(ctx.params.id)); if (!t) return notFound(ctx);
  if (t.closed && !canMod(ctx)) return redirect(ctx, '/forum/t/' + t.id, 'Тема закрыта.', 'err');
  const body = String(ctx.body.body || '').trim();
  if (limited('rp:' + ctx.user.id, 10, 300)) return redirect(ctx, '/forum/t/' + t.id, 'Слишком часто. Подождите немного.', 'err');
  if (body.length < 2 || body.length > 10000) return redirect(ctx, '/forum/t/' + t.id, 'Сообщение должно быть от 2 до 10000 символов.', 'err');
  const id = tx(() => { const ts = now(); const r = run('INSERT INTO posts(topic_id,user_id,body,created_at) VALUES(?,?,?,?)', t.id, ctx.user.id, body, ts); run('UPDATE topics SET last_post_at=? WHERE id=?', ts, t.id); return Number(r.lastInsertRowid); });
  const pages = Math.max(1, Math.ceil(one('SELECT COUNT(*) c FROM posts WHERE topic_id=?', t.id).c / 15));
  redirect(ctx, `/forum/t/${t.id}?page=${pages}#p${id}`, 'Ответ добавлен.');
});
post('/forum/t/:id/pin', (ctx) => { if (needMod(ctx)) return; run('UPDATE topics SET pinned=1-pinned WHERE id=?', intOr(ctx.params.id)); redirect(ctx, '/forum/t/' + intOr(ctx.params.id), 'Готово.'); });
post('/forum/t/:id/close', (ctx) => { if (needMod(ctx)) return; run('UPDATE topics SET closed=1-closed WHERE id=?', intOr(ctx.params.id)); redirect(ctx, '/forum/t/' + intOr(ctx.params.id), 'Готово.'); });
post('/forum/t/:id/delete', (ctx) => {
  if (needMod(ctx)) return; const t = one('SELECT cat_id FROM topics WHERE id=?', intOr(ctx.params.id));
  run('DELETE FROM topics WHERE id=?', intOr(ctx.params.id)); redirect(ctx, t ? '/forum/c/' + t.cat_id : '/forum', 'Тема удалена.');
});
post('/forum/p/:id/delete', (ctx) => {
  if (needMod(ctx)) return; const p = one('SELECT topic_id FROM posts WHERE id=?', intOr(ctx.params.id));
  if (p) run('DELETE FROM posts WHERE id=?', intOr(ctx.params.id)); redirect(ctx, p ? '/forum/t/' + p.topic_id : '/forum', 'Сообщение удалено.');
});

/* ------------------------------------------------------------ админ-панель */
const ADMIN_TABS = [['', 'Обзор'], ['servers', 'Серверы'], ['news', 'Новости'], ['cats', 'Форум'], ['products', 'Товары'], ['orders', 'Заказы'], ['topups', 'Пополнения'], ['bans', 'Баны'], ['users', 'Игроки'], ['messages', 'Сообщения'], ['settings', 'Настройки']];
function adminPage(ctx, tab, title, inner) {
  const newTop = one("SELECT COUNT(*) c FROM topups WHERE status='new'").c, unread = one('SELECT COUNT(*) c FROM messages WHERE is_read=0').c, newOrders = one("SELECT COUNT(*) c FROM orders WHERE status='new'").c;
  const tabs = ADMIN_TABS.map(([k, l]) => `<a href="/admin${k ? '/' + k : ''}"${k === tab ? ' aria-current="page"' : ''}>${l}${k === 'messages' && unread ? ` <em>${unread}</em>` : ''}${k === 'orders' && newOrders ? ` <em>${newOrders}</em>` : ''}${k === 'topups' && newTop ? ` <em>${newTop}</em>` : ''}</a>`).join('');
  page(ctx, { title: 'Админ: ' + title, side: false, content: `<div class="admin"><nav class="atabs panel" aria-label="Разделы админки">${tabs}</nav><h1 class="pt">${esc(title)}</h1>${inner}</div>` });
}
get('/admin', (ctx) => {
  if (needAdmin(ctx)) return;
  const c = (sql) => one(sql).c, t = liveTotals();
  const stats = [['Игроков онлайн', t.players], ['Серверов', c('SELECT COUNT(*) c FROM servers')], ['В рейтинге', c('SELECT COUNT(*) c FROM players')], ['Пользователей', c('SELECT COUNT(*) c FROM users')], ['Новых заказов', c("SELECT COUNT(*) c FROM orders WHERE status='new'")], ['Заявок на пополнение', c("SELECT COUNT(*) c FROM topups WHERE status='new'")], ['Новых сообщений', c('SELECT COUNT(*) c FROM messages WHERE is_read=0')]];
  const todo = [];
  if (!c('SELECT COUNT(*) c FROM servers')) todo.push('<a href="/admin/servers">Добавьте свой игровой сервер (IP и порт)</a>');
  if (!c('SELECT COUNT(*) c FROM forum_cats')) todo.push('<a href="/admin/cats">Создайте разделы форума</a>');
  if (!c('SELECT COUNT(*) c FROM products')) todo.push('<a href="/admin/products">Добавьте товары в магазин</a>');
  if (!S('contact_email') && !S('contact_telegram') && !S('contact_discord')) todo.push('<a href="/admin/settings">Заполните контакты и ссылки на соцсети</a>');
  adminPage(ctx, '', 'Обзор', `<div class="stats">${stats.map(([l, v]) => `<div class="panel stat"><b>${v}</b><span>${l}</span></div>`).join('')}</div>
    ${todo.length ? panel('Что сделать дальше', `<ul class="todo pad">${todo.map((x) => `<li>${x}</li>`).join('')}</ul>`, { ic: 'gear' }) : ''}`);
});

/* универсальный CRUD */
const SECTIONS = {
  servers: { table: 'servers', title: 'Серверы', one: 'сервер', order: 'sort, id', hint: 'Укажите IP/домен и игровой порт (обычно 27015). Сайт сам опрашивает сервер: онлайн, карта, игроки. Порт должен быть доступен по UDP.',
    fields: [{ n: 'name', l: 'Название', req: 1, max: 60 }, { n: 'mode', l: 'Режим (Public, AWP, Zombie…)', max: 30, def: 'Public' }, { n: 'ip', l: 'IP или домен', req: 1, max: 100 }, { n: 'port', l: 'Порт', t: 'number', def: 27015, min: 1, maxn: 65535 }, { n: 'sort', l: 'Порядок (меньше — выше)', t: 'number', def: 0 }, { n: 'enabled', l: 'Показывать на сайте', t: 'check', def: 1 }],
    cols: [['name', 'Название'], ['mode', 'Режим'], ['ip', 'IP'], ['port', 'Порт'], [(r) => (live.get(r.id) ? (live.get(r.id).online ? 'online' : 'нет ответа') : r.enabled ? 'проверка…' : 'скрыт'), 'Статус']], after: () => { pollAll(); } },
  news: { table: 'news', title: 'Новости', one: 'новость', order: 'created_at DESC', fields: [{ n: 'title', l: 'Заголовок', req: 1, max: 120 }, { n: 'tag', l: 'Метка (Обновление, Акция…)', max: 20, def: 'Новость' }, { n: 'body', l: 'Текст', t: 'area', req: 1, max: 20000 }],
    cols: [['title', 'Заголовок'], ['tag', 'Метка'], [(r) => fmtDate(r.created_at, false), 'Дата']], extra: (ctx) => ({ created_at: now(), author_id: ctx.user.id }) },
  cats: { table: 'forum_cats', title: 'Разделы форума', one: 'раздел', order: 'sort, id', fields: [{ n: 'title', l: 'Название', req: 1, max: 80 }, { n: 'descr', l: 'Описание', max: 200 }, { n: 'sort', l: 'Порядок', t: 'number', def: 0 }], cols: [['title', 'Название'], ['descr', 'Описание'], ['sort', 'Порядок']] },
  products: { table: 'products', title: 'Товары магазина', one: 'товар', order: 'sort, id', fields: [{ n: 'name', l: 'Название (VIP, Premium…)', req: 1, max: 60 }, { n: 'descr', l: 'Описание (что входит)', t: 'area', max: 2000 }, { n: 'prefix', l: 'Префикс в нике (например [VIP])', max: 12, def: '' }, { n: 'color', l: 'Цвет ника (например #ff5555)', max: 20, def: '' }, { n: 'price', l: 'Цена', t: 'number', def: 0, min: 0 }, { n: 'days', l: 'Срок в днях (0 — навсегда)', t: 'number', def: 30, min: 0 }, { n: 'sort', l: 'Порядок', t: 'number', def: 0 }, { n: 'active', l: 'Продаётся', t: 'check', def: 1 }],
    cols: [['name', 'Название'], ['prefix', 'Префикс'], ['color', 'Цвет'], [(r) => money(r.price), 'Цена'], [(r) => (r.days ? r.days + ' дн.' : 'навсегда'), 'Срок'], [(r) => (r.active ? 'да' : 'скрыт'), 'Продаётся']] },
  bans: { table: 'bans', title: 'Банлист', one: 'бан', order: 'id DESC', fields: [{ n: 'nick', l: 'Ник', req: 1, max: 40 }, { n: 'target', l: 'SteamID или IP', max: 60 }, { n: 'reason', l: 'Причина', max: 200 }, { n: 'days', l: 'Срок в днях (0 — навсегда)', t: 'number', def: 0, min: 0, virtual: 1 }],
    cols: [['nick', 'Ник'], ['target', 'SteamID / IP'], ['reason', 'Причина'], [(r) => (r.expires_at ? 'до ' + fmtDate(r.expires_at, false) : 'навсегда'), 'Срок']],
    before: (d, ctx, isNew) => { const days = d.days; delete d.days; if (isNew || days !== undefined) d.expires_at = days > 0 ? now() + days * 86400 : null; if (isNew) { d.admin_name = ctx.user.username; d.created_at = now(); } } },
};
const adminForm = (ctx, sec, action, row, label) => `<form method="post" action="${action}" class="form pad cols2">${csrfField(ctx)}${sec.fields.map((f) => {
  const v = row ? (row[f.n] ?? f.def ?? '') : (f.def ?? '');
  if (f.t === 'check') return `<label class="chk"><input type="checkbox" name="${f.n}"${v ? ' checked' : ''}> ${f.l}</label>`;
  if (f.t === 'area') return `<label class="f wide"><span>${f.l}</span><textarea name="${f.n}" rows="6"${f.req ? ' required' : ''}${f.max ? ` maxlength="${f.max}"` : ''}>${esc(v)}</textarea></label>`;
  return `<label class="f"><span>${f.l}</span><input name="${f.n}" ${f.t === 'number' ? `type="number"${f.min !== undefined ? ` min="${f.min}"` : ''}${f.maxn ? ` max="${f.maxn}"` : ''}` : ''} value="${esc(v)}"${f.req ? ' required' : ''}${f.max ? ` maxlength="${f.max}"` : ''}></label>`;
}).join('')}<div class="wide"><button class="btn solid" type="submit">${label}</button></div></form>`;
function readFields(sec, b) {
  const d = {};
  for (const f of sec.fields) {
    if (f.t === 'check') d[f.n] = b[f.n] ? 1 : 0;
    else if (f.t === 'number') { let n = intOr(b[f.n], f.def ?? 0); if (f.min !== undefined) n = Math.max(f.min, n); if (f.maxn) n = Math.min(f.maxn, n); d[f.n] = n; }
    else { const v = String(b[f.n] ?? '').trim().slice(0, f.max || 500); if (f.req && !v) return null; d[f.n] = v || (f.def ?? ''); }
  }
  return d;
}
for (const [key, sec] of Object.entries(SECTIONS)) {
  const base = '/admin/' + key;
  get(base, (ctx) => {
    if (needAdmin(ctx)) return;
    const rows = all(`SELECT * FROM ${sec.table} ORDER BY ${sec.order}`);
    const table = rows.length ? `<div class="tbl"><table><thead><tr>${sec.cols.map((c) => `<th class="l">${c[1]}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map((r) => `<tr>${sec.cols.map(([k]) => `<td class="l wrap">${esc(typeof k === 'function' ? k(r) : r[k])}</td>`).join('')}<td class="act"><a class="btn sm" href="${base}/${r.id}">Изменить</a>
      <form method="post" action="${base}/${r.id}/delete" data-confirm="Удалить: ${esc(String(r[sec.cols[0][0]] ?? '').slice(0, 40))}?">${csrfField(ctx)}<button class="btn sm danger" type="submit">Удалить</button></form></td></tr>`).join('')}</tbody></table></div>` : empty('Записей пока нет — добавьте первую ниже.');
    adminPage(ctx, key, sec.title, `${sec.hint ? `<p class="hint">${sec.hint}</p>` : ''}${panel('Список', table)}${panel('Добавить: ' + sec.one, adminForm(ctx, sec, base, null, 'Добавить'), { ic: 'plus' })}`);
  });
  post(base, (ctx) => {
    if (needAdmin(ctx)) return;
    const d = readFields(sec, ctx.body); if (!d) return redirect(ctx, base, 'Заполните обязательные поля.', 'err');
    if (sec.before) sec.before(d, ctx, true); if (sec.extra) Object.assign(d, sec.extra(ctx));
    const cols = Object.keys(d); run(`INSERT INTO ${sec.table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map((c) => d[c]));
    if (sec.after) sec.after(); redirect(ctx, base, 'Добавлено.');
  });
  get(base + '/:id', (ctx) => {
    if (needAdmin(ctx)) return; const r = one(`SELECT * FROM ${sec.table} WHERE id=?`, intOr(ctx.params.id)); if (!r) return notFound(ctx);
    if (key === 'bans') r.days = r.expires_at ? Math.max(1, Math.ceil((r.expires_at - now()) / 86400)) : 0;
    adminPage(ctx, key, sec.title + ': изменить', panel('Редактирование', adminForm(ctx, sec, `${base}/${r.id}`, r, 'Сохранить'), { ic: 'gear' }) + `<p><a href="${base}">← К списку</a></p>`);
  });
  post(base + '/:id', (ctx) => {
    if (needAdmin(ctx)) return; const id = intOr(ctx.params.id), d = readFields(sec, ctx.body);
    if (!d) return redirect(ctx, `${base}/${id}`, 'Заполните обязательные поля.', 'err');
    if (sec.before) sec.before(d, ctx, false);
    const cols = Object.keys(d); run(`UPDATE ${sec.table} SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`, ...cols.map((c) => d[c]), id);
    if (sec.after) sec.after(); redirect(ctx, base, 'Сохранено.');
  });
  post(base + '/:id/delete', (ctx) => { if (needAdmin(ctx)) return; run(`DELETE FROM ${sec.table} WHERE id=?`, intOr(ctx.params.id)); if (sec.after) sec.after(); redirect(ctx, base, 'Удалено.'); });
}

get('/admin/orders', (ctx) => {
  if (needAdmin(ctx)) return;
  const rows = all('SELECT o.*, u.username FROM orders o JOIN users u ON u.id=o.user_id ORDER BY (o.status=\'new\') DESC, o.id DESC LIMIT 200');
  const st = { new: 'Ожидает выдачи', done: 'Выдано', cancelled: 'Отменён' };
  const t = rows.length ? `<div class="tbl"><table><thead><tr><th class="l">№</th><th class="l">Покупатель</th><th class="l">Ник в игре</th><th class="l">Товар</th><th>Цена</th><th>Дата</th><th>Статус</th><th></th></tr></thead><tbody>${rows.map((o) => `<tr><td class="l">${o.id}</td><td class="l">${esc(o.username)}</td><td class="l"><b>${esc(o.game_nick)}</b></td><td class="l">${esc(o.product_name)}${o.days ? ` (${o.days} дн.)` : ''}</td><td>${money(o.price)}</td><td>${fmtDate(o.created_at)}</td><td><span class="pill ${esc(o.status)}">${st[o.status]}</span></td>
    <td class="act">${o.status === 'new' ? `<form method="post" action="/admin/orders/${o.id}/done">${csrfField(ctx)}<button class="btn sm solid" type="submit">Выдано</button></form><form method="post" action="/admin/orders/${o.id}/cancel" data-confirm="Отменить заказ и вернуть деньги?">${csrfField(ctx)}<button class="btn sm danger" type="submit">Отменить</button></form>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('Заказов пока нет.');
  adminPage(ctx, 'orders', 'Заказы', `<p class="hint">Когда вы выдали привилегию игроку на сервере (например, в users.ini), нажмите «Выдано». При отмене деньги вернутся на баланс покупателя.</p>${panel('Заказы', t, { ic: 'shop' })}`);
});
post('/admin/orders/:id/done', (ctx) => {
  if (needAdmin(ctx)) return;
  tx(() => {
    const o = one("SELECT * FROM orders WHERE id=? AND status='new'", intOr(ctx.params.id));
    if (!o) return;
    run("UPDATE orders SET status='done' WHERE id=?", o.id);
    grantPriv(o.user_id, o.product_id, o.product_name, o.days, ctx.user.id);
  });
  redirect(ctx, '/admin/orders', 'Привилегия выдана и записана с сроком действия.');
});
post('/admin/orders/:id/cancel', (ctx) => {
  if (needAdmin(ctx)) return;
  tx(() => { const o = one("SELECT * FROM orders WHERE id=? AND status='new'", intOr(ctx.params.id)); if (o) { run("UPDATE orders SET status='cancelled' WHERE id=?", o.id); run('UPDATE users SET balance=balance+? WHERE id=?', o.price, o.user_id); } });
  redirect(ctx, '/admin/orders', 'Заказ отменён, деньги возвращены.');
});

get('/admin/topups', (ctx) => {
  if (needAdmin(ctx)) return;
  const rows = all("SELECT t.*, u.username FROM topups t JOIN users u ON u.id=t.user_id ORDER BY (t.status='new') DESC, t.id DESC LIMIT 200"), st = { new: 'Ждёт проверки', paid: 'Зачислено', rejected: 'Отклонено' };
  const t = rows.length ? `<div class="tbl plain"><table><thead><tr><th class="l">№</th><th class="l">Логин (в комментарии к переводу)</th><th>Сумма</th><th>Дата</th><th>Статус</th><th></th></tr></thead><tbody>${rows.map((x) => `<tr><td class="l">${x.id}</td><td class="l"><b>${esc(x.username)}</b></td><td><b>${money(x.amount)}</b></td><td>${fmtDate(x.created_at)}</td><td><span class="pill ${x.status === 'paid' ? 'done' : x.status === 'new' ? 'new' : 'cancelled'}">${st[x.status]}</span></td>
    <td class="act">${x.status === 'new' ? `<form method="post" action="/admin/topups/${x.id}/paid" data-confirm="Деньги пришли? Зачислить ${x.amount} на баланс ${esc(x.username)}?">${csrfField(ctx)}<button class="btn sm solid" type="submit">Зачислить</button></form><form method="post" action="/admin/topups/${x.id}/reject" data-confirm="Отклонить заявку?">${csrfField(ctx)}<button class="btn sm danger" type="submit">Отклонить</button></form>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('Заявок на пополнение пока нет.');
  adminPage(ctx, 'topups', 'Пополнения', `<p class="hint">Игрок создаёт заявку и переводит деньги на вашу карту. Проверьте поступление в приложении банка (сумма и логин в комментарии) и нажмите «Зачислить».</p>${panel('Заявки на пополнение', t, { ic: 'shop' })}`);
});
post('/admin/topups/:id/paid', (ctx) => {
  if (needAdmin(ctx)) return;
  tx(() => {
    const x = one("SELECT * FROM topups WHERE id=? AND status='new'", intOr(ctx.params.id));
    if (x) { run("UPDATE topups SET status='paid' WHERE id=?", x.id); run('UPDATE users SET balance=balance+?, donated=donated+? WHERE id=?', x.amount, x.amount, x.user_id); }
  });
  redirect(ctx, '/admin/topups', 'Деньги зачислены на баланс игрока.');
});
post('/admin/topups/:id/reject', (ctx) => { if (needAdmin(ctx)) return; run("UPDATE topups SET status='rejected' WHERE id=? AND status='new'", intOr(ctx.params.id)); redirect(ctx, '/admin/topups', 'Заявка отклонена.'); });

get('/admin/users', (ctx) => {
  if (needAdmin(ctx)) return;
  const q = (ctx.query.get('q') || '').trim().slice(0, 30), rows = all('SELECT * FROM users WHERE username LIKE ? ORDER BY id DESC LIMIT 100', '%' + q.replace(/[%_]/g, '') + '%');
  const t = rows.length ? `<div class="tbl"><table><thead><tr><th>#</th><th class="l">Логин</th><th class="l">Ранг</th><th class="l">Ник в игре</th><th class="l">Telegram</th><th>Баланс</th><th>Донат</th><th>Зачислить</th><th></th></tr></thead><tbody>${rows.map((u) => `<tr><td>${u.id}</td><td class="l"><a href="/u/${u.id}">${esc(u.username)}</a>${isActive(u) ? ' <span class="pill cancelled">забанен</span>' : ''}</td>
    <td class="l"><form method="post" action="/admin/users/${u.id}/rank" class="inl">${csrfField(ctx)}<select name="rank" aria-label="Ранг">${Object.entries(RANKS).map(([k, r]) => `<option value="${k}"${u.rank === k ? ' selected' : ''}>${r.label}</option>`).join('')}</select><button class="btn sm" type="submit">OK</button></form></td>
    <td class="l">${esc(u.game_nick || '—')}</td><td class="l">${esc(u.telegram || '—')}</td><td>${money(u.balance)}</td><td>${money(u.donated)}</td>
    <td><form method="post" action="/admin/users/${u.id}/balance" class="inl">${csrfField(ctx)}<input type="number" name="amount" aria-label="Сумма" placeholder="+/-" required><button class="btn sm" type="submit">OK</button></form></td>
    <td class="act">${u.id !== ctx.user.id ? (isActive(u)
      ? `<form method="post" action="/admin/users/${u.id}/unban">${csrfField(ctx)}<button class="btn sm" type="submit">Разбанить</button></form>`
      : `<form method="post" action="/admin/users/${u.id}/ban" data-confirm="Заблокировать аккаунт ${esc(u.username)}?">${csrfField(ctx)}<input type="hidden" name="days" value="7"><input type="hidden" name="reason" value="нарушение правил"><button class="btn sm danger" type="submit">Забанить</button></form>`)
      + `<a class="btn sm" href="/u/${u.id}">Профиль</a>`
      + `<form method="post" action="/admin/users/${u.id}/delete" data-confirm="Удалить аккаунт ${esc(u.username)}?">${csrfField(ctx)}<button class="btn sm danger" type="submit">Удалить</button></form>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('Никого не найдено.');
  adminPage(ctx, 'users', 'Пользователи', `<form class="search top" method="get" action="/admin/users"><input name="q" value="${esc(q)}" placeholder="Поиск по логину" aria-label="Поиск"><button class="btn sm" type="submit">Найти</button></form>${panel('Зарегистрированные пользователи', t, { ic: 'users' })}`);
});
post('/admin/users/:id/balance', (ctx) => { if (needAdmin(ctx)) return; const a = intOr(ctx.body.amount); run('UPDATE users SET balance=MAX(0,balance+?) WHERE id=?', a, intOr(ctx.params.id)); redirect(ctx, '/admin/users', 'Баланс обновлён.'); });
post('/admin/users/:id/rank', (ctx) => {
  if (needAdmin(ctx)) return;
  const id = intOr(ctx.params.id), r = String(ctx.body.rank || 'player');
  if (!RANKS[r] || id === ctx.user.id) return redirect(ctx, '/admin/users', 'Ранг не изменён.', 'err');
  run('UPDATE users SET rank=? WHERE id=?', r, id);
  run('UPDATE users SET role=? WHERE id=?', ['creator', 'deputy', 'admin'].includes(r) ? 'admin' : 'user', id);
  redirect(ctx, '/admin/users', `Ранг изменён: ${RANKS[r].label}.`);
});
post('/admin/users/:id/ban', (ctx) => {
  if (needAdmin(ctx)) return;
  const id = intOr(ctx.params.id); if (id === ctx.user.id) return redirect(ctx, '/admin/users', 'Нельзя заблокировать самого себя.', 'err');
  const days = intOr(ctx.body.days, 0), reason = String(ctx.body.reason || '').trim().slice(0, 120) || 'нарушение правил';
  run('UPDATE users SET ban_until=?, ban_reason=? WHERE id=?', days > 0 ? now() + days * 86400 : 4102444800, reason, id);
  redirect(ctx, '/admin/users', `Аккаунт заблокирован: ${reason}.`);
});
post('/admin/users/:id/unban', (ctx) => { if (needAdmin(ctx)) return; run('UPDATE users SET ban_until=NULL, ban_reason=\'\' WHERE id=?', intOr(ctx.params.id)); redirect(ctx, '/admin/users', 'Блокировка снята.'); });
post('/admin/users/:id/gift', (ctx) => {
  if (needAdmin(ctx)) return;
  const id = intOr(ctx.params.id), p = one('SELECT * FROM products WHERE id=?', intOr(ctx.body.product_id));
  if (!p || !one('SELECT id FROM users WHERE id=?', id)) return redirect(ctx, '/admin/users', 'Не удалось выдать привилегию.', 'err');
  grantPriv(id, p.id, p.name, p.days, ctx.user.id);
  redirect(ctx, '/u/' + id, `Привилегия «${p.name}» выдана.`);
});
post('/admin/users/:id/priv/:pid/delete', (ctx) => {
  if (needAdmin(ctx)) return;
  run('DELETE FROM user_privs WHERE id=? AND user_id=?', intOr(ctx.params.pid), intOr(ctx.params.id));
  redirect(ctx, '/u/' + intOr(ctx.params.id), 'Привилегия снята.');
});
post('/admin/users/:id/delete', (ctx) => { if (needAdmin(ctx)) return; if (intOr(ctx.params.id) !== ctx.user.id) run('DELETE FROM users WHERE id=?', intOr(ctx.params.id)); redirect(ctx, '/admin/users', 'Аккаунт удалён.'); });

get('/admin/messages', (ctx) => {
  if (needAdmin(ctx)) return;
  const rows = all('SELECT * FROM messages ORDER BY id DESC LIMIT 100');
  const t = rows.length ? `<ul class="msgs">${rows.map((m) => `<li class="${m.is_read ? '' : 'unread'}"><div class="mh"><b>${esc(m.name)}</b> <span class="muted">${esc(m.contact)}</span> <small>${fmtDate(m.created_at)}</small></div>${m.subject ? `<div class="ms">${esc(m.subject)}</div>` : ''}<div class="prose">${text(m.body)}</div>
    <div class="act">${m.is_read ? '' : `<form method="post" action="/admin/messages/${m.id}/read">${csrfField(ctx)}<button class="btn sm" type="submit">Прочитано</button></form>`}<form method="post" action="/admin/messages/${m.id}/delete" data-confirm="Удалить сообщение?">${csrfField(ctx)}<button class="btn sm danger" type="submit">Удалить</button></form></div></li>`).join('')}</ul>` : empty('Сообщений нет.');
  adminPage(ctx, 'messages', 'Сообщения', panel('Сообщения из формы «Контакты»', t, { ic: 'mail' }));
});
post('/admin/messages/:id/read', (ctx) => { if (needAdmin(ctx)) return; run('UPDATE messages SET is_read=1 WHERE id=?', intOr(ctx.params.id)); redirect(ctx, '/admin/messages'); });
post('/admin/messages/:id/delete', (ctx) => { if (needAdmin(ctx)) return; run('DELETE FROM messages WHERE id=?', intOr(ctx.params.id)); redirect(ctx, '/admin/messages', 'Удалено.'); });

const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
function saveB64Image(data, prefix) {
  const m = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(data || ''));
  if (!m) return null;
  let buf; try { buf = Buffer.from(m[1].replace(/\s/g, ''), 'base64'); } catch { return null; }
  if (buf.length < 100 || buf.length > 8 * 1024 * 1024) return null;
  let ext;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
  else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ext = 'png';
  else if (buf.toString('ascii', 0, 4) === 'GIF8') ext = 'gif';
  else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') ext = 'webp';
  else return null;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return '/static/uploads/' + name;
}
function dropUpload(urlPath) {
  if (!/^\/static\/uploads\//.test(urlPath)) return;
  try { fs.unlinkSync(path.join(PUBLIC_DIR, urlPath.replace(/^\/static\//, ''))); } catch { /* уже удалён */ }
}

const SETTING_FIELDS = [['site_name', 'Название сайта (первое слово — крупно)'], ['tagline_1', 'Подпись в шапке, строка 1'], ['tagline_2', 'Подпись в шапке, строка 2'], ['currency', 'Валюта (сум, ₽, $)'], ['tz', 'Часовой пояс (например Asia/Tashkent)'],
  ['contact_email', 'Почта для связи'], ['contact_telegram', 'Telegram (ссылка https://t.me/…)'], ['contact_discord', 'Discord (ссылка-приглашение)'], ['contact_vk', 'ВКонтакте (ссылка)'], ['link_youtube', 'YouTube (ссылка)'], ['card_number', 'Номер карты для пополнения'], ['card_holder', 'Имя владельца карты'], ['card_bank', 'Банк'], ['topup_min', 'Минимальная сумма пополнения'], ['topup_max', 'Максимальная сумма пополнения'],  ['footer_quote', 'Цитата в подвале'], ['topup_text', 'Текст на странице «Пополнить баланс»', 'area'],
  ['hero_image', 'Картинка-шапка на главной (загрузите файл ниже или впишите путь /static/uploads/…; пусто — скрыть)'],
  ['forum_image', 'Картинка-баннер на форуме (загрузите файл ниже; пусто — скрыть)']];
get('/admin/settings', (ctx) => {
  if (needAdmin(ctx)) return;
  adminPage(ctx, 'settings', 'Настройки', panel('Настройки сайта', `<form method="post" action="/admin/settings" class="form pad cols2">${csrfField(ctx)}${SETTING_FIELDS.map(([k, l, t]) => t === 'area'
    ? `<label class="f wide"><span>${l}</span><textarea name="${k}" rows="4" maxlength="1000">${esc(S(k))}</textarea></label>` : `<label class="f"><span>${l}</span><input name="${k}" value="${esc(S(k))}" maxlength="200"></label>`).join('')}
    <div class="wide uprow">
      <p class="sub" style="margin-top:0">Картинки: шапка главной и баннер форума</p>
      <div class="upgrid">
        <label class="f"><span>Шапка главной — выбрать файл (JPG/PNG/WebP/GIF до 8 МБ)</span><input type="file" accept="image/*" data-upload="hero_image_b64"></label>
        <input type="hidden" name="hero_image_b64" id="hero_image_b64" value="">
        ${S('hero_image') ? `<div class="upprev"><img src="${esc(S('hero_image'))}" alt="Шапка главной"><small>${esc(S('hero_image'))}</small></div>` : '<small class="muted">Картинка шапки пока не загружена.</small>'}
        <label class="f"><span>Баннер форума — выбрать файл (JPG/PNG/WebP/GIF до 8 МБ)</span><input type="file" accept="image/*" data-upload="forum_image_b64"></label>
        <input type="hidden" name="forum_image_b64" id="forum_image_b64" value="">
        ${S('forum_image') ? `<div class="upprev"><img src="${esc(S('forum_image'))}" alt="Баннер форума"><small>${esc(S('forum_image'))}</small></div>` : '<small class="muted">Баннер форума пока не загружен.</small>'}
      </div>
      <p class="hint">Выберите картинку и нажмите «Сохранить» — она появится на сайте. Чтобы убрать, очистите поле выше и сохраните.</p>
    </div>
    <div class="wide"><button class="btn solid" type="submit">Сохранить</button></div></form>`, { ic: 'gear' }));
});
post('/admin/settings', (ctx) => {
  if (needAdmin(ctx)) return;
  for (const [b64key, prefix] of [['hero_image_b64', 'hero'], ['forum_image_b64', 'forum']]) {
    const key = b64key.replace(/_b64$/, '');
    if (!ctx.body[b64key]) continue;
    const saved = saveB64Image(ctx.body[b64key], prefix);
    if (!saved) return redirect(ctx, '/admin/settings', 'Не удалось сохранить картинку: нужен JPG, PNG, WebP или GIF до 8 МБ.', 'err');
    dropUpload(S(key));
    saveSetting(key, saved);
    ctx.body[key] = saved;
  }
  for (const [k] of SETTING_FIELDS) { let v = String(ctx.body[k] ?? '').trim().slice(0, 1000); if (k === 'tz') { try { new Intl.DateTimeFormat('ru-RU', { timeZone: v }); } catch { v = DEFAULTS.tz; } } if (k === 'site_name' && !v) v = DEFAULTS.site_name; if (k === 'topup_min' || k === 'topup_max') v = String(Math.max(1, intOr(v, Number(DEFAULTS[k])))); if (k === 'card_number') v = v.replace(/[^\d ]/g, '').slice(0, 30); saveSetting(k, v); }
  redirect(ctx, '/admin/settings', 'Настройки сохранены.');
});

/* ----------------------------------------------------------- HTTP server */
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname.replace(/^\/static\//, ''));
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}
function readBody(req, max = 300000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('User-agent: *\nAllow: /\n');
    }

    if (url.pathname === '/sitemap.xml') {
      const baseUrl = 'http://localhost:3000';
      const paths = ['/', '/servers', '/news', '/stats'];

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map(path => `<url><loc>${baseUrl}${path}</loc></url>`).join('\n')}
</urlset>`;

      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end(xml);
    }

    if (url.pathname.startsWith('/static/')) return serveStatic(req, res, url.pathname);
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    const cookies = parseCookies(req.headers.cookie), out = [];
const ctx = {
  req, res, url, query: url.searchParams, params: {}, body: {}, cookies, flash: null, done: false,
  ip: (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?',
  setCookie(name, value, o = {}) { out.push(`${name}=${value}; Path=/; SameSite=Lax${o.httpOnly ? '; HttpOnly' : ''}${o.maxAge !== undefined ? '; Max-Age=' + o.maxAge : ''}${req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : ''}`); },
  extraHeaders() { return { ...SEC_HEADERS, ...(out.length ? { 'Set-Cookie': out } : {}) }; },
};
ctx.sid = cookies.sid || '';

    if (ctx.sid) {
      const srow = one('SELECT u.*, s.last_seen AS s_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', ctx.sid, now());
      ctx.user = srow || null;
      if (srow && now() - (srow.s_seen || 0) > 60) run('UPDATE sessions SET last_seen=? WHERE token=?', now(), ctx.sid);
    }
    ctx.csrf = cookies.csrf || crypto.randomBytes(16).toString('hex');
    if (!cookies.csrf) ctx.setCookie('csrf', ctx.csrf, { httpOnly: true, maxAge: 30 * 86400 });
    if (cookies.flash) { try { ctx.flash = JSON.parse(cookies.flash); } catch {} ctx.setCookie('flash', '', { maxAge: 0 }); }

    /* забаненный аккаунт может только выйти */
    if (ctx.user && isActive(ctx.user) && url.pathname !== '/logout') {
      const until = fmtDate(ctx.user.ban_until);
      return send(ctx, 403, layout(ctx, { title: 'Аккаунт заблокирован', side: false, content: `<div class="authbox">${panel('Аккаунт заблокирован', `<div class="pad banned">
        <p>Причина: <b>${esc(ctx.user.ban_reason || 'нарушение правил')}</b></p><p class="muted">Блокировка действует до ${until}.</p>
        <form method="post" action="/logout">${csrfField(ctx)}<button class="btn block" type="submit">Выйти из аккаунта</button></form></div>`, { ic: 'ban' })}</div>` }));
    }

    if (req.method === 'POST') {
      const raw = await readBody(req, ['/admin/settings', '/cabinet/profile'].includes(url.pathname) ? 12000000 : 300000);
      ctx.body = Object.fromEntries(new URLSearchParams(raw));
      if (!safeEq(ctx.body._csrf || '', ctx.csrf)) return send(ctx, 403, layout(ctx, { title: 'Ошибка', content: panel('Сессия устарела', empty('Обновите страницу и повторите действие.', '<a class="btn solid" href="/">На главную</a>')), side: false }));
    } else if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, POST' }); return res.end(); }

    const method = req.method === 'HEAD' ? 'GET' : req.method;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(url.pathname); if (!m) continue;
      ctx.params = m.groups || {};
      await r.handler(ctx);
      if (!ctx.done) send(ctx, 500, 'Handler did not respond', 'text/plain');
      return;
    }
    notFound(ctx);
  } catch (e) {
    console.error('Ошибка:', e);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Внутренняя ошибка сервера'); } else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Сайт запущен: http://localhost:${PORT}`);
  console.log('Первый зарегистрированный пользователь станет администратором.');
});
setTimeout(pollAll, 1000);
setInterval(pollAll, POLL_MS);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
module.exports = { queryInfo, queryPlayers };
