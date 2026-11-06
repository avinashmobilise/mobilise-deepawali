'use strict';
/**
 * Mobilise Diwali Utsav 2026 — voting server
 * ------------------------------------------------------------
 * Zero dependencies (Node 18+). Serves the web app from /public and a
 * small JSON API. Data is kept in data/db.json.
 *
 *   node server.js                      -> http://localhost:3000
 *
 * Environment variables (all optional):
 *   PORT            default 3000
 *   HOST            default 0.0.0.0 (reachable from other devices on the network)
 *   ADMIN_PASSWORD  default "diwali2026"  <- change this for the real event
 *   DATA_DIR        default ./data
 *
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *                   Store the data in a (free) Upstash Redis database instead of
 *                   data/db.json. Use this on free hosts whose disk is wiped on
 *                   restart (e.g. Render free).
 *   REDIS_KEY       default "mobilise-diwali-utsav"
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'diwali2026';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 3 * 1024 * 1024; // owner photo upload arrives as a data URL
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const REDIS_KEY = process.env.REDIS_KEY || 'mobilise-diwali-utsav';
const USE_REDIS = !!(UPSTASH_URL && UPSTASH_TOKEN);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
};

const DEFAULT_OWNER_MESSAGE =
  'This Diwali, may every desk glow, every idea shine and every dream we build together light up the way ahead. ' +
  'Thank you, Team Mobilise, for making every day brighter. Wishing you and your families a joyful, prosperous Deepawali!';

const COMPETITION_DEFAULTS = [
  { id: 'desk', kind: 'teams', title: 'Best Desk', subtitle: 'Score every other team’s Diwali desk décor', status: 'open', published: false },
  { id: 'dress-male', kind: 'male', title: 'Best Dress (Male)', subtitle: 'Score the gentlemen’s festive looks', status: 'open', published: false },
  { id: 'dress-female', kind: 'female', title: 'Best Dress (Female)', subtitle: 'Score the ladies’ festive looks', status: 'open', published: false },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = (prefix) => prefix + crypto.randomBytes(4).toString('hex');
const randomPin = (taken = new Set()) => {
  for (let i = 0; i < 1000; i++) {
    const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!taken.has(pin)) return pin;
  }
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
};
const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMultiline = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
const validPin = (p) => typeof p === 'string' && /^\d{4,6}$/.test(p);
const round2 = (n) => Math.round(n * 100) / 100;

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  if (code) e.code = code;
  return e;
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */
let db;

function defaultDb() {
  const taken = new Set();
  const teams = Array.from({ length: 10 }, (_, i) => {
    const pin = randomPin(taken);
    taken.add(pin);
    return { id: 't' + (i + 1), name: 'Team ' + (i + 1), pin };
  });
  return {
    version: 1,
    secret: crypto.randomBytes(32).toString('hex'),
    settings: {
      eventTitle: 'Diwali Utsav 2026',
      requirePin: true,
      publicUrl: '',
      owner: { name: 'Ashish Sharma', title: 'Founder & Managing Director', message: DEFAULT_OWNER_MESSAGE, photo: '' },
    },
    teams,
    people: { male: [], female: [] },
    competitions: COMPETITION_DEFAULTS.map((c) => ({ ...c })),
    ballots: [],
  };
}

/** Fill in anything missing (older/hand-edited files). */
function migrate(d) {
  const def = defaultDb();
  if (!d || typeof d !== 'object') return def;
  d.version = 1;
  if (typeof d.secret !== 'string' || d.secret.length < 32) d.secret = def.secret;
  d.settings = Object.assign({}, def.settings, d.settings || {});
  d.settings.owner = Object.assign({}, def.settings.owner, (d.settings && d.settings.owner) || {});
  if (!Array.isArray(d.teams)) d.teams = def.teams;
  const taken = new Set();
  d.teams = d.teams
    .filter((t) => t && t.name)
    .map((t) => {
      const pin = validPin(String(t.pin || '')) ? String(t.pin) : randomPin(taken);
      taken.add(pin);
      return { id: String(t.id || newId('t')), name: cleanText(t.name, 40), pin };
    });
  d.people = d.people && typeof d.people === 'object' ? d.people : {};
  for (const k of ['male', 'female']) {
    d.people[k] = (Array.isArray(d.people[k]) ? d.people[k] : [])
      .map((p) => (typeof p === 'string' ? { id: newId(k[0]), name: p } : p))
      .filter((p) => p && p.name)
      .map((p) => ({ id: String(p.id || newId(k[0])), name: cleanText(p.name, 60) }));
  }
  const comps = Array.isArray(d.competitions) ? d.competitions : [];
  d.competitions = COMPETITION_DEFAULTS.map((base) => {
    const found = comps.find((c) => c && c.id === base.id) || {};
    return {
      id: base.id,
      kind: base.kind,
      title: cleanText(found.title || base.title, 60),
      subtitle: cleanText(found.subtitle == null ? base.subtitle : found.subtitle, 120),
      status: found.status === 'closed' ? 'closed' : 'open',
      published: !!found.published,
    };
  });
  d.ballots = (Array.isArray(d.ballots) ? d.ballots : []).filter(
    (b) => b && typeof b.teamId === 'string' && typeof b.competitionId === 'string' && b.scores && typeof b.scores === 'object'
  );
  return d;
}

/** One Upstash Redis REST call, e.g. ['SET', key, value]. Retries short network hiccups. */
async function redis(command, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      return data.result;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(300 * (i + 1));
    }
  }
  throw new Error(`Upstash Redis: ${lastErr.message}`);
}

async function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  let loaded = null;
  if (USE_REDIS) {
    // If Redis cannot be reached this throws and the server refuses to start,
    // so we never start empty and overwrite the real data.
    const raw = await redis(['GET', REDIS_KEY]);
    if (raw) loaded = JSON.parse(raw);
  } else if (fs.existsSync(DB_FILE)) {
    try {
      loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
      const backup = DB_FILE + '.corrupt-' + Date.now();
      fs.copyFileSync(DB_FILE, backup);
      console.error(`! data/db.json could not be read (${err.message}). A copy was saved to ${backup}`);
    }
  }
  db = migrate(loaded);
  if (USE_REDIS) {
    // The owner photo lives in its own key; put it back on the (temporary) local disk.
    if (db.settings.owner.photo) {
      const stored = await redis(['GET', `${REDIS_KEY}:photo`]);
      const m = /^(png|jpg|webp):([A-Za-z0-9+/=]+)$/.exec(stored || '');
      if (m) fs.writeFileSync(path.join(MEDIA_DIR, `owner.${m[1]}`), Buffer.from(m[2], 'base64'));
      else db.settings.owner.photo = '';
    }
    await redis(['SET', REDIS_KEY, JSON.stringify(db)]);
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
}

let saveChain = Promise.resolve(true);
/** Persist the current state. Resolves true when stored, false when storing failed. */
function saveDb() {
  const snapshot = USE_REDIS ? JSON.stringify(db) : JSON.stringify(db, null, 2);
  const job = saveChain.then(async () => {
    try {
      if (USE_REDIS) await redis(['SET', REDIS_KEY, snapshot]);
      else await writeAtomic(DB_FILE, snapshot);
      return true;
    } catch (err) {
      console.error('! Could not save data:', err.message);
      return false;
    }
  });
  saveChain = job;
  return job;
}

async function mustSave() {
  if (!(await saveDb())) throw httpError(503, 'The change could not be saved. Please try again in a moment.', 'SAVE');
}

async function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, data);
  // OneDrive / antivirus can briefly lock files on Windows: retry, then fall back to a direct write.
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (i === 4) {
        await fsp.writeFile(file, data);
        await fsp.unlink(tmp).catch(() => {});
        return;
      }
      await sleep(60 * (i + 1));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Auth (stateless signed tokens; they survive restarts and expire     */
/* automatically when a team PIN or the admin password changes)        */
/* ------------------------------------------------------------------ */
const sign = (s) => crypto.createHmac('sha256', db.secret).update(s).digest('base64url').slice(0, 32);
const teamToken = (team) => `${team.id}.${sign(`team:${team.id}:${team.pin}`)}`;
const adminToken = () => `admin.${sign(`admin:${ADMIN_PASSWORD}`)}`;

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function teamFromRequest(req) {
  const tok = bearer(req);
  const i = tok.lastIndexOf('.');
  if (i < 1) return null;
  const team = db.teams.find((t) => t.id === tok.slice(0, i));
  if (!team) return null;
  return safeEqual(tok.slice(i + 1), sign(`team:${team.id}:${team.pin}`)) ? team : null;
}

const isAdmin = (req) => safeEqual(bearer(req), adminToken());

// Simple brute-force protection for PINs / admin password.
const attempts = new Map();
const LIMIT = 10;
const WINDOW_MS = 5 * 60 * 1000;
function clientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    '?'
  );
}
function isLocked(key) {
  const a = attempts.get(key);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return a.count >= LIMIT;
}
function recordFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else a.count++;
}

/* ------------------------------------------------------------------ */
/* Domain                                                              */
/* ------------------------------------------------------------------ */
function entriesFor(comp) {
  if (comp.kind === 'teams') return db.teams.map((t) => ({ id: t.id, name: t.name }));
  return (db.people[comp.kind] || []).map((p) => ({ id: p.id, name: p.name }));
}

function entriesForVoter(comp, teamId) {
  const list = entriesFor(comp);
  return comp.kind === 'teams' ? list.filter((e) => e.id !== teamId) : list;
}

/** Ranked results. Ranking is by average score (fair even if a team did not vote),
 *  then by number of votes; identical average + votes share a rank. */
function computeResults(comp) {
  const rows = entriesFor(comp).map((e) => ({ id: e.id, name: e.name, total: 0, votes: 0, avg: 0, rank: 0 }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const liveTeams = new Set(db.teams.map((t) => t.id));
  for (const b of db.ballots) {
    if (b.competitionId !== comp.id || !liveTeams.has(b.teamId)) continue;
    for (const [id, score] of Object.entries(b.scores)) {
      const r = byId.get(id);
      if (r && Number.isInteger(score)) {
        r.total += score;
        r.votes++;
      }
    }
  }
  for (const r of rows) r.avg = r.votes ? r.total / r.votes : 0;
  rows.sort((a, b) => b.avg - a.avg || b.votes - a.votes || a.name.localeCompare(b.name));
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.rank = prev && prev.avg === r.avg && prev.votes === r.votes ? prev.rank : i + 1;
  });
  return rows.map((r) => ({ ...r, avg: round2(r.avg) }));
}

function publicState() {
  const s = db.settings;
  return {
    settings: {
      eventTitle: s.eventTitle,
      requirePin: s.requirePin,
      owner: { name: s.owner.name, title: s.owner.title, message: s.owner.message, photo: s.owner.photo },
    },
    teams: db.teams.map((t) => ({ id: t.id, name: t.name })),
    competitions: db.competitions.map((c) => ({
      id: c.id,
      kind: c.kind,
      title: c.title,
      subtitle: c.subtitle,
      status: c.status,
      published: c.published,
      entries: entriesFor(c),
      // Only the top 3 are ever shown publicly, and only once the organiser publishes.
      podium: c.published
        ? computeResults(c)
            .filter((r) => r.votes > 0 && r.rank <= 3)
            .map(({ id, name, avg, rank, votes }) => ({ id, name, avg, rank, votes }))
        : null,
    })),
  };
}

function meFor(team) {
  const ballots = {};
  for (const b of db.ballots) if (b.teamId === team.id) ballots[b.competitionId] = { at: b.at, scores: b.scores };
  return { team: { id: team.id, name: team.name }, ballots };
}

function adminData() {
  return {
    settings: db.settings,
    teams: db.teams,
    people: db.people,
    competitions: db.competitions.map((c) => ({
      ...c,
      entryCount: entriesFor(c).length,
      results: computeResults(c),
      voted: db.ballots.filter((b) => b.competitionId === c.id).map((b) => ({ teamId: b.teamId, at: b.at })),
    })),
    ballotCount: db.ballots.length,
    adminPasswordIsDefault: !process.env.ADMIN_PASSWORD,
    storage: USE_REDIS ? 'upstash' : 'file',
    // Render's free plan wipes the local disk on every restart / sleep.
    storageIsTemporary: !USE_REDIS && !!process.env.RENDER,
  };
}

/** Keep ids stable for names that did not change, so existing votes still count. */
function mergePeople(oldList, names, prefix) {
  const pool = new Map();
  for (const p of oldList) {
    const k = p.name.toLowerCase();
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(p);
  }
  return names
    .map((n) => cleanText(n, 60))
    .filter(Boolean)
    .map((name) => {
      const queue = pool.get(name.toLowerCase());
      if (queue && queue.length) return { id: queue.shift().id, name };
      return { id: newId(prefix), name };
    });
}

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */
function send(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'That upload is too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(httpError(400, 'Invalid request body.'));
      }
    });
    req.on('error', reject);
  });
}

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  const safeHost = /^[a-z0-9.\-:[\]]+$/i.test(host) ? host : 'localhost';
  return `${proto === 'https' ? 'https' : 'http'}://${safeHost}`;
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: 'Bad path' });
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';

  let base = PUBLIC_DIR;
  if (rel.startsWith('/media/')) {
    base = MEDIA_DIR;
    rel = rel.slice('/media'.length);
  }
  const file = path.resolve(base, '.' + rel);
  if (!file.startsWith(base + path.sep)) return send(res, 403, { error: 'Forbidden' });

  let stat;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Not found');
  }

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const isHtml = ext === '.html';
  const headers = {
    'Content-Type': type,
    'Cache-Control': ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico'].includes(ext) && base === PUBLIC_DIR ? 'public, max-age=3600' : 'no-cache',
    ...SECURITY_HEADERS,
  };

  if (isHtml) {
    // Fill in absolute URLs for link previews (WhatsApp / Teams need absolute og:image).
    const html = (await fsp.readFile(file, 'utf8')).replace(/%ORIGIN%/g, originOf(req));
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : html);
  }

  const lastModified = stat.mtime.toUTCString();
  headers['Last-Modified'] = lastModified;
  if (req.headers['if-modified-since'] === lastModified) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  // ---------- public ----------
  if (m === 'GET' && p === '/api/state') return send(res, 200, publicState());

  if (m === 'POST' && p === '/api/login') {
    const body = await readJson(req);
    const team = db.teams.find((t) => t.id === body.teamId);
    if (!team) return send(res, 404, { error: 'That team no longer exists. Please pick your team again.', code: 'TEAM' });
    const key = `${clientIp(req)}|${team.id}`;
    if (isLocked(key)) return send(res, 429, { error: 'Too many wrong PINs. Please wait 5 minutes and try again.', code: 'LOCKED' });
    if (db.settings.requirePin && !safeEqual(String(body.pin || '').trim(), team.pin)) {
      recordFailure(key);
      return send(res, 401, { error: 'Wrong PIN. Please check with your team lead or the organiser.', code: 'PIN' });
    }
    return send(res, 200, { token: teamToken(team), ...meFor(team) });
  }

  if (m === 'GET' && p === '/api/me') {
    const team = teamFromRequest(req);
    if (!team) return send(res, 401, { error: 'Please choose your team again.', code: 'AUTH' });
    return send(res, 200, meFor(team));
  }

  if (m === 'POST' && p === '/api/vote') {
    const team = teamFromRequest(req);
    if (!team) return send(res, 401, { error: 'Please choose your team again.', code: 'AUTH' });
    const body = await readJson(req);
    const comp = db.competitions.find((c) => c.id === body.competitionId);
    if (!comp) return send(res, 404, { error: 'Competition not found.', code: 'NOT_FOUND' });
    if (comp.status !== 'open') return send(res, 403, { error: 'Voting for this competition is closed.', code: 'CLOSED' });
    if (db.ballots.some((b) => b.teamId === team.id && b.competitionId === comp.id))
      return send(res, 409, { error: 'Your team has already voted in this competition.', code: 'ALREADY_VOTED' });
    const entries = entriesForVoter(comp, team.id);
    if (!entries.length) return send(res, 400, { error: 'There is nobody to score in this competition yet.', code: 'EMPTY' });
    const scores = body.scores && typeof body.scores === 'object' ? body.scores : {};
    const clean = {};
    const missing = [];
    for (const e of entries) {
      const v = scores[e.id];
      if (Number.isInteger(v) && v >= 1 && v <= 10) clean[e.id] = v;
      else missing.push(e.id);
    }
    if (missing.length)
      return send(res, 400, { error: `Please score everyone first (${missing.length} left).`, code: 'INCOMPLETE', missing });
    const ballot = { teamId: team.id, competitionId: comp.id, scores: clean, at: new Date().toISOString() };
    db.ballots.push(ballot);
    if (!(await saveDb())) {
      db.ballots = db.ballots.filter((x) => x !== ballot);
      return send(res, 503, { error: 'Your votes could not be saved. Please tap Submit again.', code: 'SAVE' });
    }
    console.log(`  ✓ ${team.name} voted in ${comp.title}`);
    return send(res, 200, { ok: true, ...meFor(team) });
  }

  // ---------- organiser ----------
  if (m === 'POST' && p === '/api/admin/login') {
    const body = await readJson(req);
    const key = `${clientIp(req)}|admin`;
    if (isLocked(key)) return send(res, 429, { error: 'Too many attempts. Please wait 5 minutes.', code: 'LOCKED' });
    if (!safeEqual(String(body.password || ''), ADMIN_PASSWORD)) {
      recordFailure(key);
      return send(res, 401, { error: 'Wrong password.', code: 'PASSWORD' });
    }
    return send(res, 200, { token: adminToken() });
  }

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'Please log in again.', code: 'AUTH' });

    if (m === 'GET' && p === '/api/admin/data') return send(res, 200, adminData());

    if (m === 'POST' && p === '/api/admin/settings') {
      const b = await readJson(req);
      const s = db.settings;
      if (b.eventTitle != null) s.eventTitle = cleanText(b.eventTitle, 60) || s.eventTitle;
      if (b.requirePin != null) s.requirePin = !!b.requirePin;
      if (b.publicUrl != null) {
        const u = cleanText(b.publicUrl, 200).replace(/\/+$/, '');
        s.publicUrl = /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : '';
      }
      if (b.owner && typeof b.owner === 'object') {
        if (b.owner.name != null) s.owner.name = cleanText(b.owner.name, 60);
        if (b.owner.title != null) s.owner.title = cleanText(b.owner.title, 80);
        if (b.owner.message != null) s.owner.message = cleanMultiline(b.owner.message, 600);
      }
      await mustSave();
      return send(res, 200, adminData());
    }

    if (m === 'POST' && p === '/api/admin/teams') {
      const b = await readJson(req);
      if (!Array.isArray(b.teams) || b.teams.length < 2 || b.teams.length > 60)
        return send(res, 400, { error: 'Please keep between 2 and 60 teams.' });
      const names = new Set();
      const pins = new Set();
      const next = [];
      for (const t of b.teams) {
        const name = cleanText(t && t.name, 40);
        if (!name) return send(res, 400, { error: 'Every team needs a name.' });
        if (names.has(name.toLowerCase())) return send(res, 400, { error: `Two teams are called “${name}”.` });
        names.add(name.toLowerCase());
        const existing = t.id ? db.teams.find((x) => x.id === t.id) : null;
        let pin = String((t && t.pin) || '').trim();
        if (!validPin(pin)) pin = existing ? existing.pin : '';
        if (pin && pins.has(pin)) return send(res, 400, { error: `PIN ${pin} is used twice. Each team needs its own PIN.` });
        next.push({ id: existing ? existing.id : newId('t'), name, pin });
        if (pin) pins.add(pin);
      }
      for (const t of next) if (!t.pin) pins.add((t.pin = randomPin(pins)));
      const keep = new Set(next.map((t) => t.id));
      const removed = db.teams.filter((t) => !keep.has(t.id)).map((t) => t.id);
      db.teams = next;
      if (removed.length) db.ballots = db.ballots.filter((x) => !removed.includes(x.teamId));
      await mustSave();
      return send(res, 200, adminData());
    }

    if (m === 'POST' && p === '/api/admin/people') {
      const b = await readJson(req);
      for (const k of ['male', 'female']) {
        if (b[k] == null) continue;
        if (!Array.isArray(b[k]) || b[k].length > 400) return send(res, 400, { error: 'Participant list is too long.' });
        db.people[k] = mergePeople(db.people[k], b[k], k[0]);
      }
      await mustSave();
      return send(res, 200, adminData());
    }

    if (m === 'POST' && p === '/api/admin/competition') {
      const b = await readJson(req);
      const c = db.competitions.find((x) => x.id === b.id);
      if (!c) return send(res, 404, { error: 'Competition not found.' });
      if (b.status === 'open' || b.status === 'closed') c.status = b.status;
      if (b.published != null) c.published = !!b.published;
      if (b.title != null) c.title = cleanText(b.title, 60) || c.title;
      if (b.subtitle != null) c.subtitle = cleanText(b.subtitle, 120);
      await mustSave();
      return send(res, 200, adminData());
    }

    if (m === 'POST' && p === '/api/admin/reset') {
      const b = await readJson(req);
      const before = db.ballots.length;
      if (b.all === true) db.ballots = [];
      else if (b.competitionId && b.teamId)
        db.ballots = db.ballots.filter((x) => !(x.competitionId === b.competitionId && x.teamId === b.teamId));
      else if (b.competitionId) db.ballots = db.ballots.filter((x) => x.competitionId !== b.competitionId);
      else return send(res, 400, { error: 'Nothing to reset.' });
      await mustSave();
      return send(res, 200, { removed: before - db.ballots.length, ...adminData() });
    }

    if (m === 'POST' && p === '/api/admin/photo') {
      const b = await readJson(req);
      let photo = null;
      if (!b.remove) {
        const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ''));
        if (!match) return send(res, 400, { error: 'Please upload a JPG, PNG or WebP image.' });
        const buf = Buffer.from(match[2], 'base64');
        const isPng = buf.slice(0, 4).toString('hex') === '89504e47';
        const isJpg = buf.slice(0, 3).toString('hex') === 'ffd8ff';
        const isWebp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
        if (!(isPng || isJpg || isWebp)) return send(res, 400, { error: 'That file does not look like an image.' });
        if (buf.length > 2 * 1024 * 1024) return send(res, 413, { error: 'Image is too large (max 2 MB).' });
        photo = { ext: isPng ? 'png' : isJpg ? 'jpg' : 'webp', buf };
      }
      if (USE_REDIS) {
        try {
          if (photo) await redis(['SET', `${REDIS_KEY}:photo`, `${photo.ext}:${photo.buf.toString('base64')}`]);
          else await redis(['DEL', `${REDIS_KEY}:photo`]);
        } catch (err) {
          console.error('! Could not store the photo:', err.message);
          return send(res, 503, { error: 'The photo could not be saved. Please try again.', code: 'SAVE' });
        }
      }
      for (const f of await fsp.readdir(MEDIA_DIR).catch(() => [])) {
        if (/^owner\./.test(f)) await fsp.unlink(path.join(MEDIA_DIR, f)).catch(() => {});
      }
      if (photo) {
        await fsp.writeFile(path.join(MEDIA_DIR, `owner.${photo.ext}`), photo.buf);
        db.settings.owner.photo = `/media/owner.${photo.ext}?v=${Date.now()}`;
      } else db.settings.owner.photo = '';
      await mustSave();
      return send(res, 200, adminData());
    }

    if (m === 'GET' && p === '/api/admin/export') {
      const type = url.searchParams.get('type') === 'ballots' ? 'ballots' : 'results';
      const teamName = new Map(db.teams.map((t) => [t.id, t.name]));
      let rows;
      if (type === 'results') {
        rows = [['Competition', 'Rank', 'Name', 'Average score', 'Total score', 'Votes received']];
        for (const c of db.competitions)
          for (const r of computeResults(c)) rows.push([c.title, r.votes ? r.rank : '', r.name, r.votes ? r.avg : '', r.total, r.votes]);
      } else {
        rows = [['Competition', 'Voting team', 'Scored', 'Score', 'Submitted at']];
        for (const c of db.competitions) {
          const names = new Map(entriesFor(c).map((e) => [e.id, e.name]));
          for (const b of db.ballots.filter((x) => x.competitionId === c.id))
            for (const [id, s] of Object.entries(b.scores))
              rows.push([c.title, teamName.get(b.teamId) || '(removed team)', names.get(id) || '(removed)', s, b.at]);
        }
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="diwali-utsav-${type}.csv"`,
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS,
      });
      return res.end(csv(rows));
    }
  }

  return send(res, 404, { error: 'Not found' });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!err.expose) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.expose ? err.message : 'Something went wrong. Please try again.' });
    else res.end();
  }
});

async function start() {
  try {
    await loadDb();
  } catch (err) {
    console.error(`\n  ! Could not load the voting data: ${err.message}`);
    if (USE_REDIS) console.error('    Check UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. The server did not start, so no data was overwritten.');
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => `http://${i.address}:${PORT}`);
    console.log('\n  🪔  Mobilise Diwali Utsav — voting app is running');
    console.log(`      This computer : http://localhost:${PORT}`);
    for (const u of lan) console.log(`      Office network: ${u}`);
    console.log(`      Organiser     : http://localhost:${PORT}/admin`);
    console.log(`      Data stored in: ${USE_REDIS ? `Upstash Redis (key "${REDIS_KEY}")` : DB_FILE}`);
    if (!process.env.ADMIN_PASSWORD) console.log('      ! Admin password is the default "diwali2026" — set ADMIN_PASSWORD to change it.');
    if (process.env.RENDER && !USE_REDIS)
      console.log('      ! Render free disks are wiped on restart — set the UPSTASH_REDIS_REST_* variables to keep votes safe.');
    console.log('\n      Team PINs:');
    for (const t of db.teams) console.log(`        ${t.pin}  ${t.name}`);
    console.log('');
  });
}
start();

function shutdown() {
  saveChain.finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
