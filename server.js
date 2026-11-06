'use strict';
/**
 * Mobilise Diwali Utsav 2026 — voting server (v2: every employee votes, email OTP login)
 * ------------------------------------------------------------
 * Node 18+. Serves the web app from /public and a small JSON API.
 * Only dependency: nodemailer (for the login-code emails). Run `npm install` once.
 * Data is kept in data/db.json, or in Upstash Redis (see below).
 *
 *   npm install && node server.js        -> http://localhost:3000
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
 *
 * SMTP (for the login codes) is configured by the organiser in /admin → Setup.
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
const MAX_BODY = 3 * 1024 * 1024; // owner photo upload arrives as a data URL; employee imports can be large
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const REDIS_KEY = process.env.REDIS_KEY || 'mobilise-diwali-utsav';
const USE_REDIS = !!(UPSTASH_URL && UPSTASH_TOKEN);

// Login codes
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_TRIES = 5;
const OTP_RESEND_MS = 45 * 1000;
const OTP_EMAIL_WINDOW_MS = 30 * 60 * 1000;
const OTP_EMAIL_MAX = 5;
const OTP_IP_WINDOW_MS = 15 * 60 * 1000;
// Everyone in the office shares one public IP (NAT), so this limit is generous on purpose.
const OTP_IP_MAX = 300;
const SMTP_TIMEOUT_MS = 12000;
const RENDER_SMTP_HINT =
  "Render's free plan blocks ports 25, 465 and 587 — use port 2525 (Brevo, SendGrid, Mailgun, SMTP2GO) or a paid instance.";

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
  // noOwnTeam: organiser setting. Desk → a voter can't score their own team's desk.
  // Dress → a voter can't score people from their own team. (Nobody can ever score themself.)
  { id: 'desk', kind: 'teams', title: 'Best Desk', subtitle: 'Score every other team’s Diwali desk décor', status: 'open', published: false, noOwnTeam: true },
  { id: 'dress-male', kind: 'male', title: 'Best Dress (Male)', subtitle: 'Score the gentlemen’s festive looks', status: 'open', published: false, noOwnTeam: false },
  { id: 'dress-female', kind: 'female', title: 'Best Dress (Female)', subtitle: 'Score the ladies’ festive looks', status: 'open', published: false, noOwnTeam: false },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = (prefix) => prefix + crypto.randomBytes(4).toString('hex');
const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMultiline = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
const round2 = (n) => Math.round(n * 100) / 100;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const normEmail = (v) => String(v == null ? '' : v).trim().toLowerCase().slice(0, 254);
const validEmail = (e) => !!e && e.length <= 254 && EMAIL_RE.test(e);
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function normGender(g) {
  const s = String(g == null ? '' : g).trim().toLowerCase().replace(/\.$/, '');
  if (['m', 'male', 'man', 'men', 'boy', 'gent', 'gents', 'mr'].includes(s)) return 'M';
  if (['f', 'female', 'woman', 'women', 'girl', 'lady', 'ladies', 'ms', 'mrs', 'miss'].includes(s)) return 'F';
  return '';
}

function maskEmail(e) {
  const [u, d] = String(e).split('@');
  return d ? `${u.slice(0, 2)}***@${d}` : '***';
}

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

function defaultSmtp() {
  return { host: '', port: 587, secure: false, user: '', pass: '', fromEmail: '', fromName: 'Mobilise Diwali Utsav' };
}

/** HTTPS mail API (e.g. the company's PHP endpoint). When set it is used instead of SMTP —
 *  needed on hosts that block outgoing SMTP ports, such as Render's free plan. */
function normaliseMailApi(a) {
  const src = a && typeof a === 'object' ? a : {};
  const url = cleanText(src.url, 400);
  return {
    url: /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : '',
    key: typeof src.key === 'string' ? src.key.replace(/[\r\n]/g, '').slice(0, 300) : '',
  };
}

function defaultDb() {
  return {
    version: 3,
    secret: crypto.randomBytes(32).toString('hex'),
    settings: {
      eventTitle: 'Diwali Utsav 2026',
      publicUrl: '',
      owner: { name: 'Ashish Sharma', title: 'Founder & Managing Director', message: DEFAULT_OWNER_MESSAGE, photo: '' },
      smtp: defaultSmtp(),
      mailApi: normaliseMailApi(null),
      leadersCanEdit: true, // team leaders may add/edit their own members
    },
    teams: Array.from({ length: 10 }, (_, i) => ({ id: 't' + (i + 1), name: 'Team ' + (i + 1), leaderName: '', leaderEmail: '' })),
    employees: [],
    competitions: COMPETITION_DEFAULTS.map((c) => ({ ...c })),
    ballots: [],
  };
}

function normaliseSmtp(s) {
  const src = s && typeof s === 'object' ? s : {};
  const port = Number(src.port);
  const fromEmail = normEmail(src.fromEmail);
  return {
    host: cleanText(src.host, 200),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 587,
    secure: !!src.secure,
    user: cleanText(src.user, 254),
    pass: typeof src.pass === 'string' ? src.pass.replace(/[\r\n]/g, '').slice(0, 500) : '',
    fromEmail: validEmail(fromEmail) ? fromEmail : '',
    fromName: cleanText(src.fromName, 80) || 'Mobilise Diwali Utsav',
  };
}

/** Fill in anything missing and upgrade v1 (team PIN voting) data to v2 (employee voting). */
function migrate(d) {
  const def = defaultDb();
  if (!d || typeof d !== 'object') return def;
  if (typeof d.secret !== 'string' || d.secret.length < 32) d.secret = def.secret;

  const old = d.settings && typeof d.settings === 'object' ? d.settings : {};
  d.settings = {
    eventTitle: cleanText(old.eventTitle, 60) || def.settings.eventTitle,
    publicUrl: typeof old.publicUrl === 'string' ? old.publicUrl : '',
    owner: Object.assign({}, def.settings.owner, old.owner && typeof old.owner === 'object' ? old.owner : {}),
    smtp: normaliseSmtp(Object.assign(defaultSmtp(), old.smtp && typeof old.smtp === 'object' ? old.smtp : {})),
    mailApi: normaliseMailApi(old.mailApi),
    leadersCanEdit: old.leadersCanEdit == null ? true : !!old.leadersCanEdit,
  }; // v1 settings.requirePin is dropped here

  const seenTeams = new Set();
  const seenLeaders = new Set();
  d.teams = (Array.isArray(d.teams) ? d.teams : def.teams)
    .filter((t) => t && t.name)
    .map((t) => {
      // v1 team pins are dropped here; v3 adds the team leader
      let leaderEmail = normEmail(t.leaderEmail);
      if (!validEmail(leaderEmail) || seenLeaders.has(leaderEmail)) leaderEmail = '';
      if (leaderEmail) seenLeaders.add(leaderEmail);
      return { id: String(t.id || newId('t')), name: cleanText(t.name, 40), leaderName: cleanText(t.leaderName, 80), leaderEmail };
    })
    .filter((t) => t.name && !seenTeams.has(t.id) && seenTeams.add(t.id));
  const teamIds = new Set(d.teams.map((t) => t.id));

  const employees = Array.isArray(d.employees) ? d.employees.slice() : [];
  // v1 → v2: the old Best Dress name lists become participants without an email (they can't log in).
  if (d.people && typeof d.people === 'object') {
    for (const [k, g] of [['male', 'M'], ['female', 'F']]) {
      for (const p of Array.isArray(d.people[k]) ? d.people[k] : []) {
        const name = typeof p === 'string' ? p : p && p.name;
        if (name) employees.push({ id: (p && p.id) || newId('e'), name, email: '', teamId: null, gender: g });
      }
    }
  }
  delete d.people;
  const seenIds = new Set();
  const seenEmails = new Set();
  d.employees = employees
    .filter((e) => e && e.name)
    .map((e) => {
      const email = normEmail(e.email);
      return {
        id: String(e.id || newId('e')),
        name: cleanText(e.name, 80),
        email: validEmail(email) ? email : '',
        teamId: e.teamId && teamIds.has(String(e.teamId)) ? String(e.teamId) : null,
        gender: normGender(e.gender),
      };
    })
    .filter((e) => {
      if (!e.name || seenIds.has(e.id)) return false;
      if (e.email) {
        if (seenEmails.has(e.email)) return false;
        seenEmails.add(e.email);
      }
      seenIds.add(e.id);
      return true;
    });

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
      noOwnTeam: found.noOwnTeam == null ? base.noOwnTeam : !!found.noOwnTeam,
    };
  });

  ensureLeaders(d);

  // v2 ballots belong to an employee (voterId). v1 team ballots (teamId) are dropped.
  const employeeIds = new Set(d.employees.map((e) => e.id));
  d.ballots = (Array.isArray(d.ballots) ? d.ballots : []).filter(
    (b) =>
      b &&
      typeof b.voterId === 'string' &&
      employeeIds.has(b.voterId) &&
      typeof b.competitionId === 'string' &&
      b.scores &&
      typeof b.scores === 'object'
  );
  d.version = 3;
  return d;
}

/** Every team leader must exist as an employee of the team they lead (so they can log in).
 *  setNames: also copy team.leaderName onto the employee. reuse: Map(email → old employee)
 *  so a leader re-created after an import keeps their old id (and gender). */
function ensureLeaders(d, { setNames = false, reuse = null } = {}) {
  for (const t of d.teams) {
    if (!t.leaderEmail) continue;
    let e = d.employees.find((x) => x.email === t.leaderEmail);
    if (!e) {
      const old = reuse ? reuse.get(t.leaderEmail) : null;
      const takenIds = new Set(d.employees.map((x) => x.id));
      e = {
        id: old && !takenIds.has(old.id) ? old.id : newId('e'),
        name: t.leaderName || (old && old.name) || t.leaderEmail.split('@')[0],
        email: t.leaderEmail,
        teamId: t.id,
        gender: (old && old.gender) || '',
      };
      d.employees.push(e);
    } else {
      e.teamId = t.id;
      if (setNames && t.leaderName) e.name = t.leaderName;
    }
  }
}

/** The team this employee leads (or null). */
const leaderTeamOf = (emp) => (emp && emp.email ? db.teams.find((t) => t.leaderEmail && t.leaderEmail === emp.email) || null : null);

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
/* Auth (stateless signed tokens; they survive restarts. A voter token */
/* stops working when the employee is removed or their email changes)  */
/* ------------------------------------------------------------------ */
const sign = (s) => crypto.createHmac('sha256', db.secret).update(s).digest('base64url').slice(0, 32);
const voterSig = (e) => sign(`voter:${e.id}:${e.email}`);
const voterToken = (e) => `v.${e.id}.${voterSig(e)}`;
const adminToken = () => `admin.${sign(`admin:${ADMIN_PASSWORD}`)}`;

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function voterFromRequest(req) {
  const m = /^v\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(bearer(req));
  if (!m) return null;
  const e = db.employees.find((x) => x.id === m[1]);
  if (!e || !e.email) return null;
  return safeEqual(m[2], voterSig(e)) ? e : null;
}

const isAdmin = (req) => safeEqual(bearer(req), adminToken());

function clientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    '?'
  );
}

// Brute-force protection for the admin password.
const attempts = new Map();
const LIMIT = 10;
const WINDOW_MS = 5 * 60 * 1000;
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
/* Login codes (kept in memory only)                                   */
/* ------------------------------------------------------------------ */
const otps = new Map(); // email -> { hash, exp, tries }
const otpSends = new Map(); // email -> [timestamps]
const ipSends = new Map(); // ip -> [timestamps]
const otpHash = (email, code) => crypto.createHash('sha256').update(`${db.secret}:${email}:${code}`).digest('hex');

function recent(map, key, windowMs) {
  const now = Date.now();
  const list = (map.get(key) || []).filter((t) => now - t < windowMs);
  map.set(key, list);
  return list;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otps) if (v.exp < now) otps.delete(k);
  for (const [k, v] of otpSends) if (!v.some((t) => now - t < OTP_EMAIL_WINDOW_MS)) otpSends.delete(k);
  for (const [k, v] of ipSends) if (!v.some((t) => now - t < OTP_IP_WINDOW_MS)) ipSends.delete(k);
  for (const [k, v] of attempts) if (now - v.first > WINDOW_MS) attempts.delete(k);
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */
const smtpConfigured = () => !!(db.settings.smtp.host && db.settings.smtp.fromEmail);
const mailApiConfigured = () => !!(db.settings.mailApi.url && db.settings.mailApi.key);
/** Can the app send login codes at all (mail API or SMTP)? */
const emailConfigured = () => mailApiConfigured() || smtpConfigured();
const emailVia = () => (mailApiConfigured() ? 'api' : smtpConfigured() ? 'smtp' : 'none');

/** Make text safe for mail queues whose DB columns are not utf8mb4 (or even latin1):
 *  every non-ASCII character in the HTML becomes a numeric entity (✅ → &#9989;), which mail
 *  clients render identically; the plain-text subject is reduced to ASCII. */
const htmlToAscii = (html) => String(html).replace(/[^\x00-\x7F]/gu, (ch) => `&#${ch.codePointAt(0)};`);
const subjectToAscii = (s) =>
  String(s)
    .replace(/[–—·]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Send through the HTTPS mail API. Expects JSON {success, message} back. */
async function sendViaApi({ to, subject, html }) {
  const a = db.settings.mailApi;
  html = htmlToAscii(html);
  subject = subjectToAscii(subject) || 'Your login code';
  let res;
  try {
    res = await fetch(a.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Utsav-Key': a.key },
      // HTML goes base64-encoded so web-application firewalls don't mistake it for an attack
      body: JSON.stringify({ to, subject, html_b64: Buffer.from(html, 'utf8').toString('base64') }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const why = err && err.name === 'TimeoutError' ? 'no answer within 25 s' : (err && err.message) || 'network error';
    throw Object.assign(new Error(`Could not reach the mail API at ${a.url} (${why}).`), { code: 'EAPI' });
  }
  const body = await res.text();
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    /* not JSON */
  }
  if (!res.ok || !data || data.success !== true) {
    const why =
      (data && data.message) ||
      `HTTP ${res.status}${body ? ': ' + body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) : ''}`;
    throw Object.assign(new Error(`The mail API did not send the email: ${why}`), { code: 'EAPI' });
  }
  return { message: String(data.message || '') };
}

let transport = null;
function getTransport() {
  if (transport) return transport;
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (err) {
    throw Object.assign(new Error('nodemailer is not installed — run "npm install" in the app folder.'), { code: 'ENOMAILER' });
  }
  const s = db.settings.smtp;
  transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: !!s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return transport;
}

async function sendMail({ to, subject, text, html }) {
  if (mailApiConfigured()) return sendViaApi({ to, subject, html });
  const s = db.settings.smtp;
  await getTransport().sendMail({ from: { name: s.fromName, address: s.fromEmail }, to, subject, text, html });
  return { message: 'Sent over SMTP.' };
}

/** Turn mail errors into something an organiser can act on. Never includes passwords or keys. */
function describeSmtpError(err) {
  const code = (err && err.code) || '';
  const msg = String((err && err.message) || err || 'Unknown error').replace(/\s+/g, ' ').slice(0, 300);
  const where = `${db.settings.smtp.host}:${db.settings.smtp.port}`;
  if (code === 'ENOMAILER' || code === 'EAPI') return msg;
  if (code === 'EAUTH') return 'SMTP login failed — check username/password.';
  if (/wrong version number|ssl3_get_record|packet length too long|unknown protocol/i.test(msg))
    return `TLS mismatch talking to ${where} (${msg}). Port 465 needs “SSL/TLS” on; ports 587/2525 need it off (STARTTLS).`;
  if (['ETIMEDOUT', 'ECONNREFUSED', 'ESOCKET', 'ECONNECTION', 'EDNS', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND'].includes(code) || /timed? ?out|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg))
    return `Could not connect to ${where} (${code || 'connection error'}: ${msg}). ${RENDER_SMTP_HINT}`;
  if (code === 'EENVELOPE') return `The email address was rejected by the mail server: ${msg}`;
  return `${code ? code + ': ' : ''}${msg}`;
}

function emailShell(title, inner) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#00122E">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#00122E;padding:32px 12px;font-family:Arial,Helvetica,sans-serif">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#0A2350;border:1px solid #6b5420;border-radius:18px;padding:28px 24px;color:#FFF5E1">
<tr><td align="center" style="font-size:26px;line-height:1">🪔</td></tr>
<tr><td align="center" style="padding-top:8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#FFC94A">${escHtml(title)}</td></tr>
${inner}
<tr><td align="center" style="padding-top:22px;font-size:12px;color:#c9c2b0">— Team Mobilise · Shubh Deepawali ✨</td></tr>
</table></td></tr></table></body></html>`;
}

function otpEmail(emp, code) {
  const title = db.settings.eventTitle;
  const first = emp.name.split(/\s+/)[0] || emp.name;
  return {
    to: emp.email,
    subject: `${code} is your ${title} login code`,
    text: `Namaste ${first},\n\nYour login code for ${title} is: ${code}\n\nIt is valid for 10 minutes. If you did not ask for it, you can ignore this email.\n\n— Team Mobilise 🪔`,
    html: emailShell(
      title,
      `<tr><td style="padding-top:18px;font-size:16px">Namaste ${escHtml(first)},</td></tr>
<tr><td style="padding-top:8px;font-size:15px;color:#e8e1cf">Your login code is:</td></tr>
<tr><td align="center" style="padding:18px 0 6px"><span style="display:inline-block;padding:14px 22px;border-radius:14px;background:#00122E;border:1px solid #FFC94A;font-size:34px;font-weight:bold;letter-spacing:8px;color:#FFC94A">${code}</span></td></tr>
<tr><td align="center" style="font-size:13px;color:#c9c2b0">Valid for 10 minutes. If you did not ask for it, you can ignore this email.</td></tr>`
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Domain                                                              */
/* ------------------------------------------------------------------ */
const teamNameOf = (teamId) => {
  const t = teamId ? db.teams.find((x) => x.id === teamId) : null;
  return t ? t.name : '';
};

function entriesFor(comp) {
  if (comp.kind === 'teams') return db.teams.map((t) => ({ id: t.id, name: t.name }));
  const g = comp.kind === 'male' ? 'M' : 'F';
  return db.employees.filter((e) => e.gender === g).map((e) => ({ id: e.id, name: e.name, teamId: e.teamId || null }));
}

/** What one voter has to score. Never themself; and when the organiser switched on
 *  "noOwnTeam" for this competition, never their own team (desk) / own team-mates (dress). */
function entriesForVoter(comp, voter) {
  const list = entriesFor(comp);
  const ownTeam = comp.noOwnTeam && voter.teamId ? voter.teamId : null;
  if (comp.kind === 'teams') return ownTeam ? list.filter((e) => e.id !== ownTeam) : list;
  return list.filter((e) => e.id !== voter.id && !(ownTeam && e.teamId === ownTeam));
}

/** Ranked results. Ranking is by average score (fair even if not everyone voted),
 *  then by number of votes; identical average + votes share a rank. */
function computeResults(comp) {
  const rows = entriesFor(comp).map((e) => ({ id: e.id, name: e.name, total: 0, votes: 0, avg: 0, rank: 0 }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const liveVoters = new Set(db.employees.map((e) => e.id));
  for (const b of db.ballots) {
    if (b.competitionId !== comp.id || !liveVoters.has(b.voterId)) continue;
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
      noOwnTeam: !!c.noOwnTeam,
      entries: entriesFor(c),
      // Only the top 3 are ever shown publicly, and only once the organiser publishes.
      podium: c.published
        ? computeResults(c)
            .filter((r) => r.votes > 0 && r.rank <= 3)
            .map(({ id, name, avg, rank, votes }) => ({ id, name, avg, rank, votes }))
        : null,
    })),
    emailLogin: { ready: emailConfigured() },
  };
}

function voterView(e) {
  const led = leaderTeamOf(e);
  return {
    id: e.id,
    name: e.name,
    email: e.email,
    teamId: e.teamId,
    teamName: teamNameOf(e.teamId),
    gender: e.gender || '',
    leaderOf: led ? { teamId: led.id, teamName: led.name } : null,
  };
}

/** What a team leader sees on "Manage my team": leader first, then by name. */
function teamPayload(team) {
  const voted = new Set(db.ballots.map((b) => b.voterId));
  const members = db.employees
    .filter((e) => e.teamId === team.id)
    .map((e) => ({
      id: e.id,
      name: e.name,
      email: e.email,
      gender: e.gender || '',
      isLeader: !!team.leaderEmail && e.email === team.leaderEmail,
      hasVoted: voted.has(e.id),
    }))
    .sort((a, b) => Number(b.isLeader) - Number(a.isLeader) || a.name.localeCompare(b.name));
  return { team: { id: team.id, name: team.name }, canEdit: !!db.settings.leadersCanEdit, members };
}

function meFor(voter) {
  const ballots = {};
  for (const b of db.ballots) if (b.voterId === voter.id) ballots[b.competitionId] = { at: b.at, scores: b.scores };
  return { voter: voterView(voter), ballots };
}

function adminData() {
  const s = db.settings;
  const teamName = new Map(db.teams.map((t) => [t.id, t.name]));
  const members = new Map();
  for (const e of db.employees) if (e.teamId) members.set(e.teamId, (members.get(e.teamId) || 0) + 1);
  const votedBy = new Map();
  for (const b of db.ballots) {
    if (!votedBy.has(b.voterId)) votedBy.set(b.voterId, {});
    votedBy.get(b.voterId)[b.competitionId] = b.at;
  }
  const voters = db.employees.filter((e) => e.email);
  return {
    settings: {
      eventTitle: s.eventTitle,
      publicUrl: s.publicUrl,
      owner: s.owner,
      smtp: {
        host: s.smtp.host,
        port: s.smtp.port,
        secure: s.smtp.secure,
        user: s.smtp.user,
        fromEmail: s.smtp.fromEmail,
        fromName: s.smtp.fromName,
        passSet: !!s.smtp.pass,
      },
      mailApi: { url: s.mailApi.url, keySet: !!s.mailApi.key },
      leadersCanEdit: !!s.leadersCanEdit,
    },
    teams: db.teams.map((t) => ({
      id: t.id,
      name: t.name,
      leaderName: t.leaderName || '',
      leaderEmail: t.leaderEmail || '',
      members: members.get(t.id) || 0,
    })),
    employees: db.employees.map((e) => ({
      id: e.id,
      name: e.name,
      email: e.email,
      teamId: e.teamId,
      teamName: e.teamId ? teamName.get(e.teamId) || '' : '',
      gender: e.gender,
      isLeader: !!e.email && db.teams.some((t) => t.leaderEmail === e.email),
      voted: votedBy.get(e.id) || {},
    })),
    competitions: db.competitions.map((c) => ({
      ...c,
      entryCount: entriesFor(c).length,
      eligibleVoters: voters.filter((v) => entriesForVoter(c, v).length > 0).length,
      votedCount: db.ballots.filter((b) => b.competitionId === c.id).length,
      results: computeResults(c),
    })),
    ballotCount: db.ballots.length,
    voterCount: voters.length,
    adminPasswordIsDefault: !process.env.ADMIN_PASSWORD,
    storage: USE_REDIS ? 'upstash' : 'file',
    // Render's free plan wipes the local disk on every restart / sleep.
    storageIsTemporary: !USE_REDIS && !!process.env.RENDER,
    smtpConfigured: emailConfigured(), // "can send login codes" (mail API or SMTP)
    emailVia: emailVia(),
  };
}

/** Replace the employee list from an import, keeping ids stable so existing ballots survive. */
function importEmployees(rows, syncTeams) {
  const problems = [];
  const parsed = [];
  const seenEmail = new Map();
  rows.forEach((r, i) => {
    const n = i + 1;
    const src = r && typeof r === 'object' ? r : {};
    const name = cleanText(src.name, 80);
    const email = normEmail(src.email);
    const team = cleanText(src.team, 40);
    const gender = normGender(src.gender);
    if (!name) {
      if (email || team) problems.push(`row ${n}: the name is missing`);
      return; // fully empty rows are skipped silently
    }
    if (email && !validEmail(email)) return problems.push(`row ${n} (${name}): “${email}” is not a valid email`);
    if (email) {
      if (seenEmail.has(email)) return problems.push(`row ${n} (${name}): ${email} is repeated (row ${seenEmail.get(email)})`);
      seenEmail.set(email, n);
    }
    parsed.push({ name, email, team, gender });
  });
  if (problems.length)
    throw Object.assign(
      httpError(400, `Please fix ${problems.length} problem${problems.length > 1 ? 's' : ''} in the import: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; …' : ''}`, 'IMPORT'),
      { problems: problems.slice(0, 50) }
    );
  if (!parsed.length) throw httpError(400, 'No employees found in the import.', 'IMPORT');

  // Teams
  const importTeams = [];
  const seenTeam = new Set();
  for (const r of parsed) {
    if (r.team && !seenTeam.has(r.team.toLowerCase())) {
      seenTeam.add(r.team.toLowerCase());
      importTeams.push(r.team);
    }
  }
  const existingByName = new Map(db.teams.map((t) => [t.name.toLowerCase(), t]));
  let teams;
  if (syncTeams && importTeams.length) {
    teams = importTeams.map((name) => {
      const ex = existingByName.get(name.toLowerCase());
      // keep the leader of a team that already existed under the same name
      return { id: ex ? ex.id : newId('t'), name, leaderName: ex ? ex.leaderName || '' : '', leaderEmail: ex ? ex.leaderEmail || '' : '' };
    });
  } else {
    teams = db.teams.map((t) => ({ ...t }));
    for (const name of importTeams)
      if (!existingByName.has(name.toLowerCase())) {
        const t = { id: newId('t'), name, leaderName: '', leaderEmail: '' };
        teams.push(t);
        existingByName.set(name.toLowerCase(), t);
      }
  }
  if (teams.length > 200) throw httpError(400, `The import has ${teams.length} teams — the limit is 200.`, 'IMPORT');
  const teamIdByName = new Map(teams.map((t) => [t.name.toLowerCase(), t.id]));

  // Employees (same email → same id; same name → same id when one side has no email)
  const oldByEmail = new Map(db.employees.filter((e) => e.email).map((e) => [e.email, e]));
  const oldByName = new Map();
  for (const e of db.employees) {
    const k = e.name.toLowerCase();
    if (!oldByName.has(k)) oldByName.set(k, []);
    oldByName.get(k).push(e);
  }
  const used = new Set();
  const employees = parsed.map((r) => {
    let prev = r.email ? oldByEmail.get(r.email) : null;
    if (prev && used.has(prev.id)) prev = null;
    if (!prev) prev = (oldByName.get(r.name.toLowerCase()) || []).find((e) => !used.has(e.id) && (!r.email || !e.email)) || null;
    const id = prev ? prev.id : newId('e');
    used.add(id);
    return { id, name: r.name, email: r.email, teamId: r.team ? teamIdByName.get(r.team.toLowerCase()) || null : null, gender: r.gender };
  });

  db.teams = teams;
  db.employees = employees;
  // team leaders missing from the import are put back into their team (keeping their old id)
  ensureLeaders(db, { reuse: oldByEmail });
  const keepIds = new Set(db.employees.map((e) => e.id));
  const keepEmails = new Set(db.employees.filter((e) => e.email).map((e) => e.email));
  db.ballots = db.ballots.filter((b) => keepIds.has(b.voterId));
  for (const email of [...otps.keys()]) if (!keepEmails.has(email)) otps.delete(email);
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

  if (m === 'POST' && p === '/api/otp/request') {
    const b = await readJson(req);
    const email = normEmail(b.email);
    if (!validEmail(email)) return send(res, 400, { code: 'EMAIL', error: 'Please enter a valid email address.' });
    if (!emailConfigured()) return send(res, 503, { code: 'EMAIL_OFF', error: 'Email login is not set up yet. Please ask the organiser.' });
    const ipList = recent(ipSends, clientIp(req), OTP_IP_WINDOW_MS);
    if (ipList.length >= OTP_IP_MAX) {
      const retry = Math.max(1, Math.ceil((OTP_IP_WINDOW_MS - (Date.now() - ipList[0])) / 1000));
      return send(res, 429, { code: 'WAIT', error: 'Too many login codes were requested from this network. Please try again in a few minutes.', retryInSec: retry });
    }
    const emp = db.employees.find((e) => e.email === email);
    if (!emp)
      return send(res, 404, { code: 'NOT_FOUND', error: "This email isn't on the employee list. Please check it or ask the organiser." });
    const sends = recent(otpSends, email, OTP_EMAIL_WINDOW_MS);
    const last = sends[sends.length - 1];
    if (last && Date.now() - last < OTP_RESEND_MS) {
      const retry = Math.max(1, Math.ceil((OTP_RESEND_MS - (Date.now() - last)) / 1000));
      return send(res, 429, { code: 'WAIT', error: `Please wait ${retry} seconds before asking for a new code.`, retryInSec: retry });
    }
    if (sends.length >= OTP_EMAIL_MAX) {
      const retry = Math.max(1, Math.ceil((OTP_EMAIL_WINDOW_MS - (Date.now() - sends[0])) / 1000));
      return send(res, 429, { code: 'WAIT', error: 'Too many codes were requested for this email. Please try again later.', retryInSec: retry });
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const stamp = Date.now();
    sends.push(stamp);
    ipList.push(stamp);
    try {
      await sendMail(otpEmail(emp, code));
    } catch (err) {
      sends.pop(); // a failed send should not block an immediate retry
      console.error(`! Login code email to ${maskEmail(email)} failed: ${describeSmtpError(err)}`);
      return send(res, 502, { code: 'SEND_FAILED', error: 'We could not send the email. Please try again in a minute.' });
    }
    otps.set(email, { hash: otpHash(email, code), exp: Date.now() + OTP_TTL_MS, tries: 0 }); // newest code replaces older ones
    return send(res, 200, { ok: true, email, expiresInSec: OTP_TTL_MS / 1000, resendInSec: OTP_RESEND_MS / 1000 });
  }

  if (m === 'POST' && p === '/api/otp/verify') {
    const b = await readJson(req);
    const email = normEmail(b.email);
    const code = String(b.code == null ? '' : b.code).replace(/\s+/g, '');
    const entry = otps.get(email);
    if (!entry || entry.exp < Date.now()) {
      otps.delete(email);
      return send(res, 410, { code: 'EXPIRED', error: 'This code has expired. Please request a new one.' });
    }
    if (!/^\d{6}$/.test(code) || !safeEqual(otpHash(email, code), entry.hash)) {
      entry.tries++;
      const left = Math.max(0, OTP_MAX_TRIES - entry.tries);
      if (!left) otps.delete(email); // the next try gets 410 EXPIRED
      return send(res, 401, {
        code: 'OTP',
        error: left ? 'That code is not right.' : 'That code is not right. Please request a new code.',
        attemptsLeft: left,
      });
    }
    otps.delete(email); // single use
    const emp = db.employees.find((e) => e.email === email);
    if (!emp)
      return send(res, 404, { code: 'NOT_FOUND', error: "This email isn't on the employee list. Please check it or ask the organiser." });
    console.log(`  → ${emp.name} logged in`);
    return send(res, 200, { token: voterToken(emp), ...meFor(emp) });
  }

  if (m === 'GET' && p === '/api/me') {
    const voter = voterFromRequest(req);
    if (!voter) return send(res, 401, { error: 'Please log in again.', code: 'AUTH' });
    return send(res, 200, meFor(voter));
  }

  if (m === 'POST' && p === '/api/vote') {
    const voter = voterFromRequest(req);
    if (!voter) return send(res, 401, { error: 'Please log in again.', code: 'AUTH' });
    const body = await readJson(req);
    const comp = db.competitions.find((c) => c.id === body.competitionId);
    if (!comp) return send(res, 404, { error: 'Competition not found.', code: 'NOT_FOUND' });
    if (comp.status !== 'open') return send(res, 403, { error: 'Voting for this competition is closed.', code: 'CLOSED' });
    if (db.ballots.some((b) => b.voterId === voter.id && b.competitionId === comp.id))
      return send(res, 409, { error: 'You have already voted in this competition.', code: 'ALREADY_VOTED' });
    const entries = entriesForVoter(comp, voter);
    if (!entries.length) return send(res, 400, { error: 'There is nobody for you to score in this competition yet.', code: 'EMPTY' });
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
    const ballot = { voterId: voter.id, competitionId: comp.id, scores: clean, at: new Date().toISOString() };
    db.ballots.push(ballot);
    if (!(await saveDb())) {
      db.ballots = db.ballots.filter((x) => x !== ballot);
      return send(res, 503, { error: 'Your votes could not be saved. Please tap Submit again.', code: 'SAVE' });
    }
    console.log(`  ✓ ${voter.name} voted in ${comp.title}`);
    return send(res, 200, { ok: true, ...meFor(voter) });
  }

  // ---------- team leaders: manage their own members ----------
  if (p === '/api/team' && (m === 'GET' || m === 'POST')) {
    const voter = voterFromRequest(req);
    if (!voter) return send(res, 401, { error: 'Please log in again.', code: 'AUTH' });
    const team = leaderTeamOf(voter);
    if (!team) return send(res, 403, { code: 'NOT_LEADER', error: "You're not a team leader." });
    if (m === 'GET') return send(res, 200, teamPayload(team));

    if (!db.settings.leadersCanEdit) return send(res, 403, { code: 'LOCKED', error: 'The organiser has locked the team lists.' });
    const b = await readJson(req);
    if (!Array.isArray(b.members)) return send(res, 400, { code: 'INVALID', error: 'No members were sent.' });
    if (b.members.length > 200) return send(res, 400, { code: 'INVALID', error: 'A team can have at most 200 members.' });

    const current = db.employees.filter((e) => e.teamId === team.id);
    const currentById = new Map(current.map((e) => [e.id, e]));
    const byEmail = new Map(db.employees.filter((e) => e.email).map((e) => [e.email, e]));
    const seen = new Set();
    const rows = [];
    for (let i = 0; i < b.members.length; i++) {
      const r = b.members[i] && typeof b.members[i] === 'object' ? b.members[i] : {};
      const row = i + 1;
      const name = cleanText(r.name, 60);
      const email = normEmail(r.email);
      const gender = normGender(r.gender);
      if (!name) return send(res, 400, { code: 'INVALID', error: `Row ${row}: the name is missing.`, row });
      if (!validEmail(email)) return send(res, 400, { code: 'INVALID', error: `Row ${row} (${name}): please enter a valid email.`, row });
      if (gender !== 'M' && gender !== 'F') return send(res, 400, { code: 'INVALID', error: `Row ${row} (${name}): please choose M or F.`, row });
      if (seen.has(email)) return send(res, 400, { code: 'INVALID', error: `Row ${row}: ${email} is in the list twice.`, row });
      seen.add(email);
      let match = r.id != null && currentById.has(String(r.id)) ? currentById.get(String(r.id)) : null;
      const owner = byEmail.get(email);
      if (owner && (!match || owner.id !== match.id)) {
        if (owner.teamId && owner.teamId !== team.id)
          return send(res, 409, { code: 'TAKEN', error: `${email} is already in team ${teamNameOf(owner.teamId)}.`, row });
        if (match) return send(res, 409, { code: 'TAKEN', error: `${email} already belongs to ${owner.name}.`, row });
        match = owner; // same email already in this team, or an employee without a team who joins it
      }
      rows.push({ row, name, email, gender, match });
    }

    const leaderRow = rows.find((x) => x.match && x.match.id === voter.id);
    if (!leaderRow) return send(res, 400, { code: 'INVALID', error: "You can't remove yourself." });
    if (leaderRow.email !== voter.email)
      return send(res, 400, { code: 'INVALID', error: "You can't change your own email here. Please ask the organiser.", row: leaderRow.row });

    const keepIds = new Set(rows.filter((x) => x.match).map((x) => x.match.id));
    const removed = current.filter((e) => !keepIds.has(e.id));
    const votedIds = new Set(db.ballots.map((x) => x.voterId));
    const blocked = removed.find((e) => votedIds.has(e.id));
    if (blocked)
      return send(res, 409, { code: 'HAS_VOTED', error: `${blocked.name} has already voted and can't be removed. Ask the organiser.` });

    // all checks passed: apply
    const removedIds = new Set(removed.map((e) => e.id));
    db.employees = db.employees.filter((e) => !removedIds.has(e.id));
    for (const e of removed) if (e.email) otps.delete(e.email);
    for (const x of rows) {
      if (x.match) {
        if (x.match.email && x.match.email !== x.email) otps.delete(x.match.email);
        Object.assign(x.match, { name: x.name, email: x.email, gender: x.gender, teamId: team.id });
      } else {
        db.employees.push({ id: newId('e'), name: x.name, email: x.email, teamId: team.id, gender: x.gender });
      }
    }
    await mustSave();
    console.log(`  ✓ ${voter.name} saved team ${team.name} (${rows.length} members)`);
    return send(res, 200, teamPayload(team));
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
      if (b.publicUrl != null) {
        const u = cleanText(b.publicUrl, 200).replace(/\/+$/, '');
        s.publicUrl = /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : '';
      }
      if (b.owner && typeof b.owner === 'object') {
        if (b.owner.name != null) s.owner.name = cleanText(b.owner.name, 60);
        if (b.owner.title != null) s.owner.title = cleanText(b.owner.title, 80);
        if (b.owner.message != null) s.owner.message = cleanMultiline(b.owner.message, 600);
      }
      if (b.leadersCanEdit != null) s.leadersCanEdit = !!b.leadersCanEdit;
      await mustSave();
      return send(res, 200, adminData());
    }

    if (m === 'POST' && p === '/api/admin/smtp') {
      const b = await readJson(req);
      const cur = db.settings.smtp;
      const host = b.host != null ? cleanText(b.host, 200) : cur.host;
      const fromEmail = b.fromEmail != null ? normEmail(b.fromEmail) : cur.fromEmail;
      const port = b.port != null && b.port !== '' ? Number(b.port) : cur.port;
      if (host && !/^[a-z0-9.-]+$/i.test(host)) return send(res, 400, { error: 'The SMTP host looks wrong (example: smtp-relay.brevo.com).' });
      if (!Number.isInteger(port) || port < 1 || port > 65535) return send(res, 400, { error: 'The SMTP port must be a number such as 2525, 587 or 465.' });
      if (fromEmail && !validEmail(fromEmail)) return send(res, 400, { error: 'The “From” email is not a valid address.' });
      db.settings.smtp = normaliseSmtp({
        host,
        port,
        secure: b.secure != null ? !!b.secure : cur.secure,
        user: b.user != null ? b.user : cur.user,
        pass: typeof b.pass === 'string' && b.pass !== '' ? b.pass : cur.pass, // empty = keep the stored password
        fromEmail,
        fromName: b.fromName != null ? b.fromName : cur.fromName,
      });
      transport = null;
      await mustSave();
      return send(res, 200, adminData());
    }

    if (m === 'POST' && p === '/api/admin/smtp/test') {
      const b = await readJson(req);
      const to = normEmail(b.to);
      if (!validEmail(to)) return send(res, 400, { error: 'Enter a valid email address to send the test to.' });
      if (!emailConfigured()) return send(res, 400, { error: 'Save the mail API (URL + key) or the SMTP settings first.' });
      const title = db.settings.eventTitle;
      try {
        const sent = await sendMail({
          to,
          subject: `Test email from ${title}`,
          text: `It works! Login codes for ${title} will be sent from this address.\n\n— Team Mobilise 🪔`,
          html: emailShell(
            title,
            `<tr><td align="center" style="padding-top:18px;font-size:18px;font-weight:bold">It works! ✅</td></tr>
<tr><td align="center" style="padding-top:8px;font-size:14px;color:#e8e1cf">Login codes will be sent from this address.</td></tr>`
          ),
        });
        return send(res, 200, { ok: true, via: emailVia(), message: sent && sent.message ? sent.message : '' });
      } catch (err) {
        const reason = describeSmtpError(err);
        console.error('! Test email failed:', reason);
        return send(res, 502, { error: reason });
      }
    }

    if (m === 'POST' && p === '/api/admin/mailapi') {
      const b = await readJson(req);
      const cur = db.settings.mailApi;
      const url = b.url != null ? cleanText(b.url, 400) : cur.url;
      if (url && !/^https?:\/\/[^\s"'<>]+$/i.test(url)) return send(res, 400, { error: 'The mail API URL must start with https://' });
      db.settings.mailApi = normaliseMailApi({
        url,
        key: typeof b.key === 'string' && b.key !== '' ? b.key : url ? cur.key : '', // empty = keep; clearing the URL clears the key
      });
      if (url && !db.settings.mailApi.key) return send(res, 400, { error: 'Enter the mail API key.' });
      await mustSave();
      return send(res, 200, adminData());
    }

    if (m === 'POST' && p === '/api/admin/employees') {
      const b = await readJson(req);
      if (!Array.isArray(b.rows)) return send(res, 400, { error: 'No rows were sent.' });
      if (b.rows.length > 3000) return send(res, 400, { error: 'Too many rows — the limit is 3000.' });
      try {
        importEmployees(b.rows, !!b.syncTeams);
      } catch (err) {
        if (err.problems) return send(res, err.status || 400, { error: err.message, code: err.code, problems: err.problems });
        throw err;
      }
      await mustSave();
      console.log(`  ✓ Imported ${db.employees.length} employees, ${db.teams.length} teams`);
      return send(res, 200, adminData());
    }

    if (m === 'POST' && p === '/api/admin/teams') {
      const b = await readJson(req);
      if (!Array.isArray(b.teams) || b.teams.length < 2 || b.teams.length > 200)
        return send(res, 400, { error: 'Please keep between 2 and 200 teams.' });
      const names = new Set();
      const leaders = new Map();
      const next = [];
      for (const t of b.teams) {
        const name = cleanText(t && t.name, 40);
        if (!name) return send(res, 400, { error: 'Every team needs a name.' });
        if (names.has(name.toLowerCase())) return send(res, 400, { error: `Two teams are called “${name}”.` });
        names.add(name.toLowerCase());
        const leaderName = cleanText(t.leaderName, 80);
        const leaderEmail = normEmail(t.leaderEmail);
        if (leaderEmail) {
          if (!validEmail(leaderEmail)) return send(res, 400, { error: `The leader email of “${name}” is not a valid address.` });
          if (leaders.has(leaderEmail))
            return send(res, 400, { error: `${leaderEmail} is the leader of both “${leaders.get(leaderEmail)}” and “${name}”. One person can lead one team.` });
          leaders.set(leaderEmail, name);
        }
        const existing = t.id ? db.teams.find((x) => x.id === t.id) : null;
        next.push({ id: existing ? existing.id : newId('t'), name, leaderName, leaderEmail });
      }
      const keep = new Set(next.map((t) => t.id));
      for (const e of db.employees) if (e.teamId && !keep.has(e.teamId)) e.teamId = null;
      db.teams = next;
      ensureLeaders(db, { setNames: true }); // leaders become (or are moved into) their team's members
      await mustSave();
      return send(res, 200, adminData());
    }

    if (m === 'POST' && p === '/api/admin/competition') {
      const b = await readJson(req);
      const c = db.competitions.find((x) => x.id === b.id);
      if (!c) return send(res, 404, { error: 'Competition not found.' });
      if (b.status === 'open' || b.status === 'closed') c.status = b.status;
      if (b.published != null) c.published = !!b.published;
      if (b.noOwnTeam != null) c.noOwnTeam = !!b.noOwnTeam;
      if (b.title != null) c.title = cleanText(b.title, 60) || c.title;
      if (b.subtitle != null) c.subtitle = cleanText(b.subtitle, 120);
      await mustSave();
      return send(res, 200, adminData());
    }

    if (m === 'POST' && p === '/api/admin/reset') {
      const b = await readJson(req);
      const before = db.ballots.length;
      if (b.all === true) db.ballots = [];
      else if (b.voterId && b.competitionId)
        db.ballots = db.ballots.filter((x) => !(x.competitionId === b.competitionId && x.voterId === b.voterId));
      else if (b.voterId) db.ballots = db.ballots.filter((x) => x.voterId !== b.voterId);
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
      let rows;
      if (type === 'results') {
        rows = [['Competition', 'Rank', 'Name', 'Average score', 'Total score', 'Votes received']];
        for (const c of db.competitions)
          for (const r of computeResults(c)) rows.push([c.title, r.votes ? r.rank : '', r.name, r.votes ? r.avg : '', r.total, r.votes]);
      } else {
        const byId = new Map(db.employees.map((e) => [e.id, e]));
        rows = [['Competition', 'Voter', 'Voter email', 'Voter team', 'Scored', 'Score', 'Submitted at']];
        for (const c of db.competitions) {
          const names = new Map(entriesFor(c).map((e) => [e.id, e.name]));
          for (const b of db.ballots.filter((x) => x.competitionId === c.id)) {
            const v = byId.get(b.voterId);
            for (const [id, s] of Object.entries(b.scores))
              rows.push([c.title, v ? v.name : '(removed)', v ? v.email : '', v ? teamNameOf(v.teamId) : '', names.get(id) || '(removed)', s, b.at]);
          }
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
    if (!res.headersSent) send(res, err.status || 500, { error: err.expose ? err.message : 'Something went wrong. Please try again.', code: err.code });
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
    const s = db.settings.smtp;
    console.log('\n  🪔  Mobilise Diwali Utsav — voting app is running');
    console.log(`      This computer : http://localhost:${PORT}`);
    for (const u of lan) console.log(`      Office network: ${u}`);
    console.log(`      Organiser     : http://localhost:${PORT}/admin`);
    console.log(`      Data stored in: ${USE_REDIS ? `Upstash Redis (key "${REDIS_KEY}")` : DB_FILE}`);
    console.log(
      `      Teams         : ${db.teams.length} (${db.teams.filter((t) => t.leaderEmail).length} with a leader; leaders ${db.settings.leadersCanEdit ? 'can' : 'cannot'} edit members)`
    );
    console.log(`      Employees     : ${db.employees.length} (${db.employees.filter((e) => e.email).length} can log in with email)`);
    console.log(
      `      Email         : ${
        mailApiConfigured()
          ? `mail API ${db.settings.mailApi.url}`
          : smtpConfigured()
            ? `SMTP ${s.host}:${s.port}${s.secure ? ' (SSL/TLS)' : ''} from ${s.fromEmail}`
            : 'not set up yet — add it in /admin → Setup'
      }`
    );
    if (!process.env.ADMIN_PASSWORD) console.log('      ! Admin password is the default "diwali2026" — set ADMIN_PASSWORD to change it.');
    if (process.env.RENDER && !USE_REDIS)
      console.log('      ! Render free disks are wiped on restart — set the UPSTASH_REDIS_REST_* variables to keep votes safe.');
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
