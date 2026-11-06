/* app.js — the voting app (mobile first, works on desktop too).
 * Every employee logs in with their office email + a 6-digit code (OTP) and votes individually.
 */
(function () {
  'use strict';
  const { FX, Sound, Art, ICONS, LS, esc, Intro, reduceMotion } = window.DW;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const app = $('#app');

  const LABELS = ['', 'Hmm', 'Okay', 'Fair', 'Decent', 'Good', 'Nice', 'Great', 'Lovely', 'Superb', 'Dazzling!'];
  const NOUN = { teams: ['team', 'teams'], male: ['participant', 'participants'], female: ['participant', 'participants'] };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const OTP_TTL_MS = 10 * 60 * 1000;
  const svg = (body) =>
    `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  const IC_LOGOUT = svg('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>');
  const IC_MAIL = svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>');

  const S = { state: null, me: null, view: '', cleanup: [], polls: 0 };

  /* ---------------- storage ---------------- */
  const token = {
    get: () => LS.get('dw_token'),
    set: (v) => (v ? LS.set('dw_token', v) : LS.del('dw_token')),
  };
  const draftKey = (cid) => `dw_draft_${S.me.voter.id}_${cid}`;
  function getDraft(cid) {
    try {
      const d = JSON.parse(LS.get(draftKey(cid)) || '{}');
      return d && typeof d === 'object' ? d : {};
    } catch (e) {
      return {};
    }
  }
  const setDraft = (cid, d) => LS.set(draftKey(cid), JSON.stringify(d));
  const clearDraft = (cid) => LS.del(draftKey(cid));

  /** A code that was emailed recently (survives the phone switching to the mail app and back). */
  function getPending() {
    try {
      const p = JSON.parse(LS.get('dw_otp_pending') || 'null');
      if (p && p.email && Date.now() - p.sentAt < OTP_TTL_MS) return p;
    } catch (e) {
      /* ignore */
    }
    LS.del('dw_otp_pending');
    return null;
  }
  const setPending = (p) => (p ? LS.set('dw_otp_pending', JSON.stringify(p)) : LS.del('dw_otp_pending'));

  /* ---------------- api ---------------- */
  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json' };
    const init = { method: opts.method || 'GET', headers, cache: 'no-store' };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const tk = token.get();
    if (tk && opts.auth !== false) headers.Authorization = 'Bearer ' + tk;
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw Object.assign(new Error('No connection. Please check your internet and try again.'), { code: 'NETWORK' });
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* not JSON */
    }
    if (!res.ok) {
      throw Object.assign(new Error((data && data.error) || `Something went wrong (${res.status}).`), {
        status: res.status,
        code: data && data.code,
        data,
      });
    }
    return data;
  }
  async function refreshState() {
    try {
      S.state = await api('/api/state', { auth: false });
    } catch (e) {
      /* keep the last known state */
    }
  }
  async function refreshMe() {
    if (!token.get()) return;
    try {
      const d = await api('/api/me');
      if (d && d.voter) S.me = { voter: d.voter, ballots: d.ballots || {} };
      else {
        token.set(null);
        S.me = null;
      }
    } catch (e) {
      if (e.status === 401) {
        token.set(null);
        S.me = null;
      }
    }
  }

  /* ---------------- helpers ---------------- */
  const comp = (id) => S.state.competitions.find((c) => c.id === id);
  /** Must match the server: nobody scores themself; when the organiser switched on
   *  "noOwnTeam" for a competition, nobody scores their own team (desk) / team-mates (dress). */
  function entriesForMe(c) {
    if (!S.me) return c.entries;
    const v = S.me.voter;
    const ownTeam = c.noOwnTeam && v.teamId ? v.teamId : null;
    if (c.kind === 'teams') return ownTeam ? c.entries.filter((e) => e.id !== ownTeam) : c.entries;
    return c.entries.filter((e) => e.id !== v.id && !(ownTeam && e.teamId === ownTeam));
  }
  const noun = (c, n) => NOUN[c.kind][n === 1 ? 0 : 1];
  const myName = () => (S.me ? S.me.voter.name || S.me.voter.email || '' : '');
  const firstName = () => myName().trim().split(/\s+/)[0] || '';
  function myTeamName() {
    if (!S.me || !S.me.voter.teamId) return '';
    const t = S.state.teams.find((x) => x.id === S.me.voter.teamId);
    return t ? t.name : S.me.voter.teamName || '';
  }
  const emailReady = () => !!(S.state.emailLogin && S.state.emailLogin.ready);
  const soundBtn = () => `<button class="icon-btn" type="button" data-sound-toggle></button>`;
  const brand = (cls = '') => `<img class="brand-mark ${cls}" src="assets/mobilise-logo-white.svg" alt="Mobilise" width="132" height="28">`;
  const scoreLabel = (v) => `<b>${v}</b><small>${LABELS[v]}</small>`;
  const fmtAvg = (n) => String(Math.round(n * 100) / 100);
  const fmtWait = (sec) => (sec > 90 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec}s`);
  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }
  function setDeco(mode) {
    document.body.dataset.deco = mode;
  }
  function vibrate(p) {
    try {
      if (navigator.vibrate) navigator.vibrate(p);
    } catch (e) {
      /* unsupported */
    }
  }
  function shake(el) {
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    vibrate([30, 40, 30]);
  }

  let toastTimer;
  function toast(msg, opts = {}) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.innerHTML = `<span>${esc(msg)}</span>${opts.action ? `<a class="toast-act" href="${esc(opts.action[1])}">${esc(opts.action[0])}</a>` : ''}`;
    el.classList.toggle('is-error', !!opts.error);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), opts.ms || 4000);
  }

  /** Bottom sheet on phones, centred dialog on desktop. */
  function sheet(html, { label = 'Dialog' } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `<div class="sheet-backdrop" data-close></div><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}"><div class="sheet-handle" aria-hidden="true"></div>${html}</div>`;
    document.body.appendChild(wrap);
    const prevFocus = document.activeElement;
    requestAnimationFrame(() => wrap.classList.add('open'));
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      wrap.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => wrap.remove(), 300);
      if (prevFocus && prevFocus.focus && document.body.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) close();
    });
    setTimeout(() => {
      const first = wrap.querySelector('[autofocus]') || wrap.querySelector('.sheet .btn-gold, .sheet button');
      if (first) first.focus({ preventScroll: true });
    }, 80);
    S.cleanup.push(close);
    return { el: wrap, close };
  }

  function enableSkyTaps(el) {
    let last = 0;
    el.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input,textarea,select,label,.mini-card,.how,.podium-card,.empty-card')) return;
      const now = Date.now();
      if (now - last < 280) return;
      last = now;
      Sound.unlock();
      FX.burst(e.clientX, e.clientY, { size: 0.8, vol: 0.6 });
    });
  }

  function buildGarland() {
    const g = $('#garland');
    if (!g) return;
    let w = 0;
    const draw = () => {
      if (Math.abs(window.innerWidth - w) < 2) return;
      w = window.innerWidth;
      g.innerHTML = Art.garland(w);
    };
    draw();
    let t;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(draw, 200);
    });
  }

  function logout(msg, to = '#/login') {
    token.set(null);
    S.me = null;
    if (msg) toast(msg);
    go(to);
  }

  /* ---------------- router ---------------- */
  const ROUTES = [
    [/^#?\/?$/, 'landing', viewLanding],
    [/^#\/(?:login|team)$/, 'login', viewLogin],
    [/^#\/hub$/, 'hub', viewHub],
    [/^#\/myteam$/, 'myteam', viewMyTeam],
    [/^#\/vote\/([\w-]+)$/, 'ballot', viewBallot],
    [/^#\/done\/([\w-]+)$/, 'done', viewDone],
    [/^#\/mine\/([\w-]+)$/, 'mine', viewMine],
    [/^#\/results$/, 'results', viewResults],
  ];
  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }
  function render() {
    S.cleanup.splice(0).forEach((fn) => fn());
    const h = location.hash || '#/';
    for (const [re, name, fn] of ROUTES) {
      const m = h.match(re);
      if (m) {
        S.view = name;
        document.body.dataset.view = name;
        window.scrollTo(0, 0);
        fn(...m.slice(1));
        $$('[data-sound-toggle]').forEach(Sound.syncButton);
        return;
      }
    }
    go('#/');
  }
  function requireAuth() {
    if (S.me) return true;
    go('#/login');
    return false;
  }

  /* ================================================================ */
  /* Views                                                            */
  /* ================================================================ */
  function viewLanding() {
    setDeco('full');
    FX.setLevel('low');
    const st = S.state;
    const anyPub = st.competitions.some((c) => c.published);
    app.innerHTML = `
<section class="screen landing">
  <header class="topbar">${brand()}${soundBtn()}</header>
  <div class="hero">
    <p class="hero-hi" lang="hi">शुभ दीपावली</p>
    <h1 class="hero-title gold-text">${esc(st.settings.eventTitle)}</h1>
    <p class="hero-lead">${st.competitions.length} sparkling competitions · ${st.teams.length} teams · every Mobilian votes.<br>Your scores decide who shines brightest this Diwali.</p>
    <div class="hero-diyas" aria-hidden="true">${Art.diya({ cls: 'sm' })}${Art.diya({ cls: 'md' })}${Art.diya({ cls: 'sm' })}</div>
  </div>
  <div class="mini-cards">
    ${st.competitions.map((c) => `<div class="mini-card k-${c.kind}"><span class="mini-ic">${ICONS[c.kind]}</span><span class="mini-t">${esc(c.title)}</span></div>`).join('')}
  </div>
  <div class="cta-stack">
    ${
      S.me
        ? `<a class="btn btn-gold btn-lg" href="#/hub">Continue as ${esc(firstName())} ${ICONS.next}</a>`
        : `<a class="btn btn-gold btn-lg" href="#/login">${IC_MAIL} Log in with your office email</a>`
    }
    ${anyPub ? `<a class="btn btn-ghost" href="#/results">${ICONS.trophy} See the winners</a>` : ''}
  </div>
  <ol class="how">
    <li><b>Log in with your office email</b><span>Use the email address you use at work.</span></li>
    <li><b>Enter the 6-digit code</b><span>We send a one-time code to your inbox. No password needed.</span></li>
    <li><b>Score 1 – 10 and submit</b><span>${st.competitions.map((c) => esc(c.title)).join(', ')}. Winners are revealed live at the celebration.</span></li>
  </ol>
  <footer class="foot">
    <button class="link-btn" type="button" id="replay">${ICONS.play} Replay intro</button>
    <span>Tap the sky for fireworks 🎆</span>
  </footer>
</section>`;
    $('#replay').addEventListener('click', playIntro);
    enableSkyTaps($('.landing'));
  }

  /* ---------------- login: office email → 6-digit code ---------------- */
  function viewLogin() {
    if (S.me) return go('#/hub');
    setDeco('full');
    FX.setLevel('calm');
    app.innerHTML = `
<section class="screen login-screen">
  <header class="topbar"><a class="icon-btn" href="#/" aria-label="Back">${ICONS.back}</a>${brand('sm')}${soundBtn()}</header>
  <div class="login-card">
    <div class="login-diya" aria-hidden="true">${Art.diya({ cls: 'md' })}</div>
    <div id="loginBody"></div>
  </div>
</section>`;
    const body = $('#loginBody');
    let timer = null;
    S.cleanup.push(() => clearInterval(timer));

    if (!emailReady()) {
      body.innerHTML = `
<h1 class="h1">Almost there! 🪔</h1>
<p class="muted login-lead">Email login isn’t switched on yet. Please check back soon.</p>
<a class="btn btn-ghost wide" href="#/">Back to the celebration</a>`;
      return;
    }

    const pending = getPending();
    if (pending) showCode(pending);
    else showEmail();

    function showEmail(msg = '') {
      clearInterval(timer);
      const remembered = LS.get('dw_email') || '';
      body.innerHTML = `
<h1 class="h1">Log in to vote</h1>
<p class="muted login-lead">Use your office email. We’ll send you a 6-digit code, no password needed.</p>
<form class="login-form" id="emailForm" novalidate>
  <label class="field-lbl" for="email">Office email</label>
  <input class="text-input" id="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="you@mobilise.co.in" value="${esc(remembered)}">
  <p class="form-error" role="alert">${esc(msg)}</p>
  <button class="btn btn-gold btn-lg wide" type="submit">${IC_MAIL} Send login code</button>
</form>
<p class="login-note faint">Only employees on the Diwali Utsav list can log in.</p>`;
      const form = $('#emailForm');
      const input = $('#email');
      const err = form.querySelector('.form-error');
      const btn = form.querySelector('[type=submit]');
      setTimeout(() => input.focus({ preventScroll: true }), 60);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        const email = input.value.trim().toLowerCase();
        if (!EMAIL_RE.test(email)) {
          err.classList.remove('is-info');
          err.textContent = 'Please enter a valid email address.';
          shake(form);
          input.focus();
          return;
        }
        sendCode(email, { btn, err, box: form });
      });
    }

    /** Countdown on a button after the server says "wait" (email step). */
    function countdownButton(btn, ms) {
      const end = Date.now() + ms;
      const label = btn.innerHTML;
      btn.disabled = true;
      clearInterval(timer);
      const t = () => {
        if (!document.body.contains(btn)) return clearInterval(timer);
        const left = Math.ceil((end - Date.now()) / 1000);
        if (left <= 0) {
          clearInterval(timer);
          btn.disabled = false;
          btn.innerHTML = label;
          return;
        }
        btn.textContent = `Try again in ${fmtWait(left)}`;
      };
      t();
      timer = setInterval(t, 1000);
    }

    async function sendCode(email, ui, resend) {
      ui.btn.disabled = true;
      ui.err.classList.add('is-info');
      ui.err.textContent = resend ? 'Sending a new code…' : 'Sending your code…';
      Sound.unlock();
      try {
        const d = await api('/api/otp/request', { method: 'POST', auth: false, body: { email } });
        const now = Date.now();
        const p = { email: (d && d.email) || email, sentAt: now, resendAt: now + (Number(d && d.resendInSec) || 45) * 1000 };
        LS.set('dw_email', p.email);
        setPending(p);
        if (S.view === 'login') showCode(p, resend ? 'A new code is on its way. Please use the newest email.' : '');
      } catch (ex) {
        if (!document.body.contains(ui.btn)) return; // left the page meanwhile
        ui.btn.disabled = false;
        ui.err.classList.remove('is-info');
        ui.err.textContent = ex.message;
        if (ex.code === 'WAIT') {
          const waitMs = Math.max(1, Number(ex.data && ex.data.retryInSec) || 45) * 1000;
          if (resend && ui.p) {
            ui.p.resendAt = Date.now() + waitMs;
            setPending(ui.p);
            ui.btn.disabled = true;
            return;
          }
          const prev = getPending();
          if (prev && prev.email === email) {
            // A code was emailed moments ago: go back to the code step.
            prev.resendAt = Date.now() + waitMs;
            setPending(prev);
            return showCode(prev, ex.message);
          }
          return countdownButton(ui.btn, waitMs);
        }
        if (ex.code === 'EMAIL_OFF') refreshState();
        shake(ui.box);
      }
    }

    function showCode(p, msg = '') {
      clearInterval(timer);
      body.innerHTML = `
<h1 class="h1">Check your inbox 📩</h1>
<p class="muted login-lead">We sent a 6-digit code to <b class="gold">${esc(p.email)}</b>. It works for 10 minutes.</p>
<form class="login-form" id="codeForm" novalidate>
  <label class="field-lbl" for="code">Login code</label>
  <input class="pin-input otp-input" id="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="••••••">
  <p class="form-error${msg ? ' is-info' : ''}" role="alert">${esc(msg)}</p>
  <button class="btn btn-gold btn-lg wide" type="submit">Verify &amp; continue ${ICONS.next}</button>
</form>
<div class="login-links">
  <button class="link-btn" type="button" id="resendBtn" disabled>Resend code</button>
  <button class="link-btn" type="button" id="changeEmail">Use a different email</button>
</div>
<p class="login-note faint">Can’t find it? Check your Spam or Promotions folder.</p>`;
      const form = $('#codeForm');
      const input = $('#code');
      const err = form.querySelector('.form-error');
      const btn = form.querySelector('[type=submit]');
      const resendBtn = $('#resendBtn');
      let busy = false;
      setTimeout(() => input.focus({ preventScroll: true }), 60);

      const tick = () => {
        if (!document.body.contains(resendBtn)) return clearInterval(timer);
        const left = Math.ceil(((p.resendAt || 0) - Date.now()) / 1000);
        if (left > 0) {
          resendBtn.disabled = true;
          resendBtn.textContent = `Resend code in ${fmtWait(left)}`;
        } else {
          resendBtn.disabled = false;
          resendBtn.textContent = 'Resend code';
        }
      };
      tick();
      timer = setInterval(tick, 1000);

      async function verify() {
        const code = input.value.replace(/\D/g, '');
        if (code.length !== 6) {
          err.classList.remove('is-info');
          err.textContent = 'Please enter the 6-digit code from the email.';
          shake(form);
          return;
        }
        if (busy) return;
        busy = true;
        btn.disabled = true;
        err.classList.remove('is-info');
        err.textContent = '';
        try {
          const d = await api('/api/otp/verify', { method: 'POST', auth: false, body: { email: p.email, code } });
          token.set(d.token);
          S.me = { voter: d.voter, ballots: d.ballots || {} };
          setPending(null);
          Sound.unlock();
          Sound.chime(880, 0.14);
          go('#/hub');
        } catch (ex) {
          busy = false;
          btn.disabled = false;
          if (ex.code === 'EXPIRED') {
            setPending(null);
            return showEmail(ex.message);
          }
          let m = ex.message;
          const left = ex.data && ex.data.attemptsLeft;
          if (ex.code === 'OTP' && typeof left === 'number') m += ` ${left} ${left === 1 ? 'try' : 'tries'} left.`;
          err.textContent = m;
          shake(form);
          input.select();
        }
      }

      input.addEventListener('input', () => {
        const v = input.value.replace(/\D/g, '').slice(0, 6);
        if (v !== input.value) input.value = v;
        if (v.length === 6) verify();
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        verify();
      });
      resendBtn.addEventListener('click', () => sendCode(p.email, { btn: resendBtn, err, box: form, p }, true));
      $('#changeEmail').addEventListener('click', () => {
        setPending(null);
        showEmail();
      });
    }
  }

  function compCard(c) {
    const voted = S.me.ballots[c.id];
    const entries = entriesForMe(c);
    const draft = getDraft(c.id);
    const rated = entries.filter((e) => draft[e.id]).length;
    let status;
    let action;
    if (voted) {
      status = `<span class="badge ok">${ICONS.check} Voted</span>`;
      action = `<a class="btn btn-ghost sm" href="#/mine/${esc(c.id)}">${ICONS.eye} View my scores</a>`;
    } else if (c.status !== 'open') {
      status = `<span class="badge lock">${ICONS.lock} Closed</span>`;
      action = `<p class="cc-note">Voting is closed for now.</p>`;
    } else if (!entries.length) {
      status = `<span class="badge soon">Coming soon</span>`;
      action = `<p class="cc-note">Participants will be added shortly.</p>`;
    } else {
      status = `<span class="badge live"><i></i>Live</span>`;
      action = `<a class="btn btn-gold" href="#/vote/${esc(c.id)}">${rated ? `Continue · ${rated}/${entries.length} scored` : 'Start scoring'} ${ICONS.next}</a>`;
    }
    if (c.published) status += ` <span class="badge win">${ICONS.trophy} Results out</span>`;
    return `
<article class="comp-card k-${c.kind}">
  <div class="cc-icon">${ICONS[c.kind]}</div>
  <div class="cc-body">
    <div class="cc-top"><h2>${esc(c.title)}</h2><div class="cc-badges">${status}</div></div>
    <p class="muted">${esc(c.subtitle)}</p>
    <p class="cc-meta">${entries.length} ${noun(c, entries.length)} to score</p>
    ${action}
  </div>
</article>`;
  }

  function viewHub() {
    if (!requireAuth()) return;
    setDeco('none');
    FX.setLevel('calm');
    const comps = S.state.competitions;
    const done = comps.filter((c) => S.me.ballots[c.id]).length;
    const team = myTeamName();
    const lead = S.me.voter.leaderOf || null;
    app.innerHTML = `
<section class="screen hub">
  <header class="topbar">${brand('sm')}<div class="topbar-actions">${soundBtn()}<button class="chip-btn" type="button" id="logoutBtn">${IC_LOGOUT} Log out</button></div></header>
  <div class="hub-hello">
    <p class="kicker">Namaste, ${esc(firstName())} <span aria-hidden="true">🙏</span></p>
    <h1 class="h1">${esc(myName())}</h1>
    ${team ? `<span class="team-chip">${ICONS.teams} Team: ${esc(team)}</span>` : ''}
    <div class="hub-progress">
      <div class="hp-diyas" aria-hidden="true">${comps.map((c) => Art.diya({ lit: !!S.me.ballots[c.id], cls: 'xs' })).join('')}</div>
      <p><b>${done} of ${comps.length}</b> votes cast${done === comps.length ? ' · all done! 🎉' : ''}</p>
    </div>
  </div>
  ${lead ? leaderCard(lead) : ''}
  <div class="comp-list">${comps.map(compCard).join('')}</div>
  ${comps.some((c) => c.published) ? `<a class="btn btn-ghost wide" href="#/results">${ICONS.trophy} See the winners</a>` : ''}
</section>`;
    if (lead) refreshTeamCount(lead);
    $('#logoutBtn').addEventListener('click', () => {
      const s = sheet(
        `<h2 class="sheet-title">Log out?</h2>
<p class="muted">To log in again you’ll need a new code from your email. Votes you have already submitted stay safe.</p>
<div class="sheet-actions"><button class="btn btn-ghost" type="button" data-close>Stay</button><button class="btn btn-gold" type="button" id="doLogout">Log out</button></div>`,
        { label: 'Log out' }
      );
      s.el.querySelector('#doLogout').addEventListener('click', () => {
        s.close();
        logout('', '#/');
      });
    });
  }

  /* ================================================================ */
  /* Team leaders: "Manage my team"                                    */
  /* ================================================================ */
  const TEAM_MAX = 200;
  let teamCache = null; // { teamId, count, canEdit, at } from the last GET /api/team
  const memberCount = (n) => `${n} member${n === 1 ? '' : 's'} on your team`;
  function normGender(v) {
    const s = String(v == null ? '' : v).trim();
    if (/^(m|male|man|boy|gent|gents)$/i.test(s)) return 'M';
    if (/^(f|female|woman|girl|lady|ladies)$/i.test(s)) return 'F';
    return '';
  }
  const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 60);
  /** Loose name key for matching pasted names to the employee master ("KRISHNA ." = "Krishna"). */
  const normName = (s) =>
    String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^a-z0-9ऀ-ॿ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const leadTeamName = (lead) => lead.teamName || ((S.state.teams || []).find((t) => t.id === lead.teamId) || {}).name || 'your team';

  function leaderCard(lead) {
    const known = teamCache && teamCache.teamId === lead.teamId;
    const locked = known && !teamCache.canEdit;
    return `
<article class="leader-card">
  <div class="lc-crown" aria-hidden="true">👑</div>
  <div class="lc-body">
    <h2>You lead ${esc(leadTeamName(lead))}</h2>
    <p class="muted">${locked ? 'The organiser has locked the team lists. You can still see your team.' : 'Pick your team members from the employee list and set their gender, so they can vote.'}</p>
    <p class="lc-meta" id="lcCount">${known ? esc(memberCount(teamCache.count)) : ''}</p>
    <a class="btn btn-gold" href="#/myteam">${ICONS.teams} ${locked ? 'View my team' : 'Manage my team'}</a>
  </div>
</article>`;
  }

  /** Fill in the member count on the hub card (at most once a minute). */
  async function refreshTeamCount(lead) {
    if (teamCache && teamCache.teamId === lead.teamId && Date.now() - teamCache.at < 60000) return;
    try {
      const d = await api('/api/team');
      teamCache = { teamId: d.team.id, count: (d.members || []).length, canEdit: !!d.canEdit, at: Date.now() };
      const el = $('#lcCount');
      if (el && S.view === 'hub') el.textContent = memberCount(teamCache.count);
    } catch (e) {
      /* the card works without the count */
    }
  }

  /** One CSV / TSV / semicolon line, with simple "quoted, fields" support. */
  function splitLine(line) {
    const d = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ',';
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = false;
        } else cur += ch;
      } else if (ch === '"' && cur.trim() === '') {
        q = true;
        cur = '';
      } else if (ch === d) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  /** Lines of Name, Email, Gender pasted from Excel / Sheets (header row optional, any column order). */
  function parsePaste(text) {
    const lines = String(text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .filter((l) => l.trim());
    if (!lines.length) return [];
    let cols = null;
    const head = splitLine(lines[0]).map((c) => c.toLowerCase());
    if (head.some((c) => /e-?mail/.test(c)) && !head.some((c) => EMAIL_RE.test(c))) {
      cols = { name: head.findIndex((c) => /name/.test(c)), email: head.findIndex((c) => /e-?mail/.test(c)), gender: head.findIndex((c) => /gender|sex/.test(c)) };
      if (cols.name < 0) cols.name = [0, 1, 2].find((i) => i !== cols.email && i !== cols.gender);
      lines.shift();
    }
    return lines
      .map((l) => {
        const cells = splitLine(l);
        if (cols) return { name: cleanName(cells[cols.name]), email: String(cells[cols.email] || '').trim(), gender: cols.gender >= 0 ? normGender(cells[cols.gender]) : '' };
        let name = '';
        let email = '';
        let gender = '';
        for (const c of cells) {
          if (!email && EMAIL_RE.test(c)) email = c;
          else if (!gender && normGender(c)) gender = normGender(c);
          else if (!name && c) name = c;
        }
        return { name: cleanName(name), email: email.trim(), gender };
      })
      .filter((p) => p.name || p.email);
  }

  function viewMyTeam() {
    if (!requireAuth()) return;
    if (!S.me.voter.leaderOf) {
      toast('Only team leaders can manage a team.');
      return go('#/hub');
    }
    setDeco('none');
    FX.setLevel('off');
    const loadingHtml = `<div class="loading mt-loading"><div class="loading-diya">${Art.diya({ cls: 'md' })}</div><p>Loading your team…</p></div>`;
    app.innerHTML = `
<section class="screen myteam">
  <header class="topbar"><a class="icon-btn" href="#/hub" id="mtBack" aria-label="Back to competitions">${ICONS.back}</a>${brand('sm')}${soundBtn()}</header>
  <div class="mt-body" id="mtBody">${loadingHtml}</div>
</section>`;

    let team = null;
    let canEdit = false;
    let rows = []; // { key, id, gender, isLeader, hasVoted } — name/email come from the employee master
    let directory = []; // every employee with an email, from GET /api/team
    let people = new Map(); // id → { id, name, email, teamId, teamName }
    let seq = 0;
    let dirty = false;
    const combos = new Map(); // row key → DW.Combo
    const body = () => $('#mtBody');
    const live = () => S.view === 'myteam' && !!body();
    const person = (id) => (id ? people.get(id) || null : null);
    const rowOf = (el) => {
      const li = el.closest('.mt-row');
      const k = li ? Number(li.dataset.key) : NaN;
      return rows.find((r) => r.key === k);
    };
    const destroyCombos = () => {
      combos.forEach((c) => c.destroy());
      combos.clear();
    };
    S.cleanup.push(destroyCombos);

    const onBeforeUnload = (e) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    S.cleanup.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
    $('#mtBack').addEventListener('click', (e) => {
      if (!dirty) return;
      e.preventDefault();
      const s = sheet(
        `<h2 class="sheet-title">Leave without saving?</h2>
<p class="muted">Your changes to the team list are not saved yet.</p>
<div class="sheet-actions"><button class="btn btn-ghost" type="button" data-close>Keep editing</button><button class="btn btn-gold" type="button" id="mtDiscard">Leave</button></div>`,
        { label: 'Unsaved changes' }
      );
      s.el.querySelector('#mtDiscard').addEventListener('click', () => {
        dirty = false;
        s.close();
        go('#/hub');
      });
    });

    function apply(d) {
      team = d.team;
      canEdit = !!d.canEdit;
      directory = (d.directory || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
      people = new Map(directory.map((p) => [p.id, { ...p }]));
      for (const m of d.members || []) {
        const known = people.get(m.id) || {};
        // members belong to this team (this also covers members who have no email)
        people.set(m.id, { id: m.id, name: m.name || known.name || '', email: m.email || known.email || '', teamId: team.id, teamName: team.name });
      }
      rows = (d.members || []).map((m) => ({
        key: ++seq,
        id: m.id,
        gender: m.gender === 'M' || m.gender === 'F' ? m.gender : '',
        isLeader: !!m.isLeader,
        hasVoted: !!m.hasVoted,
      }));
      rows.sort((a, b) => Number(b.isLeader) - Number(a.isLeader));
      teamCache = { teamId: team.id, count: rows.length, canEdit, at: Date.now() };
      dirty = false;
    }

    async function loadTeam() {
      destroyCombos();
      if (body()) body().innerHTML = loadingHtml;
      let d;
      try {
        d = await api('/api/team');
      } catch (e) {
        if (!live()) return;
        if (e.status === 401) return logout('Please log in again with your office email.');
        if (e.code === 'NOT_LEADER' || e.status === 403) {
          toast('You’re not a team leader.');
          await refreshMe();
          return go('#/hub');
        }
        body().innerHTML = `<div class="loading"><p>${esc(e.message)}</p><button class="btn btn-gold" type="button" id="mtRetry">Try again</button></div>`;
        $('#mtRetry').addEventListener('click', loadTeam);
        return;
      }
      if (!live()) return;
      apply(d);
      draw();
    }

    /** Picker options for one row: people in another team, or already picked in another row, are shown but disabled. */
    function itemsFor(r) {
      const taken = new Set(rows.filter((x) => x !== r && x.id).map((x) => x.id));
      return directory.map((p) => {
        const cur = people.get(p.id) || p;
        const otherTeam = !!(cur.teamId && cur.teamId !== team.id);
        const inList = taken.has(p.id);
        return {
          id: p.id,
          label: cur.name,
          sub: cur.email,
          disabled: otherTeam || inList,
          hint: otherTeam ? `in ${cur.teamName || 'another team'}` : inList ? 'already in your list' : '',
        };
      });
    }
    function refreshItems() {
      for (const r of rows) {
        const c = combos.get(r.key);
        if (c) c.setItems(itemsFor(r));
      }
    }

    function rowHtml(r, i, bad) {
      const f = bad || new Set();
      const p = person(r.id);
      const pick = canEdit && !r.isLeader;
      const nameCell = pick
        ? `<div class="mt-pick${f.has('pick') ? ' bad' : ''}" data-key="${r.key}"></div>`
        : `<div class="mt-static">${esc(p ? p.name : 'Unknown person')}</div>`;
      const email = p && p.email ? p.email : '';
      return `<li class="mt-row${pick ? ' has-pick' : ''}${r.isLeader ? ' is-leader' : ''}${r.hasVoted ? ' has-voted' : ''}${f.size ? ' has-error' : ''}" data-key="${r.key}">
  <span class="mt-no">${i + 1}</span>
  <div class="mt-fields">
    <div class="mt-field mt-name">${nameCell}</div>
    <div class="mt-field mt-email"><div class="mt-email-ro${email ? '' : ' empty'}" title="From the employee master">${email ? esc(email) : pick ? 'Pick a person' : '—'}</div></div>
    <label class="mt-field mt-gender"><span class="sr-only">Gender</span><select class="mt-in${f.has('gender') ? ' bad' : ''}" data-f="gender"${canEdit ? '' : ' disabled'}>
      <option value=""${r.gender ? '' : ' selected'}>Gender…</option><option value="M"${r.gender === 'M' ? ' selected' : ''}>Male</option><option value="F"${r.gender === 'F' ? ' selected' : ''}>Female</option>
    </select></label>
  </div>
  <div class="mt-side">
    ${r.isLeader ? '<span class="mt-tag you">You · leader</span>' : ''}
    ${r.hasVoted ? `<span class="mt-tag voted">${ICONS.check} Voted</span>` : ''}
    ${canEdit && !r.isLeader ? `<button class="icon-btn sm danger mt-del" type="button" aria-label="Remove ${esc(p ? p.name : 'this row')} from the team" title="Remove from the team">${ICONS.trash}</button>` : ''}
  </div>
</li>`;
    }

    function drawSummary() {
      const el = $('#mtSummary');
      if (!el) return;
      const m = rows.filter((r) => r.gender === 'M').length;
      const f = rows.filter((r) => r.gender === 'F').length;
      const missing = rows.length - m - f;
      el.innerHTML = `<span class="mt-pill">${rows.length} member${rows.length === 1 ? '' : 's'}</span><span class="mt-pill">${m} male</span><span class="mt-pill">${f} female</span>${
        missing ? `<span class="mt-pill warn">${missing} without gender</span>` : ''
      }${dirty ? '<span class="mt-pill unsaved">Unsaved changes</span>' : ''}`;
    }

    /** bad: Map(rowKey → Set('pick' | 'gender')) of fields to highlight */
    function drawList(bad = new Map()) {
      const list = $('#mtList');
      if (!list) return;
      destroyCombos();
      list.innerHTML = rows.length
        ? rows.map((r, i) => rowHtml(r, i, bad.get(r.key))).join('')
        : '<li class="mt-empty muted">Nobody on the team yet. Add members below.</li>';
      if (canEdit) {
        for (const r of rows) {
          if (r.isLeader) continue;
          const holder = list.querySelector(`.mt-pick[data-key="${r.key}"]`);
          if (!holder) continue;
          combos.set(
            r.key,
            DW.Combo.create(holder, {
              items: itemsFor(r),
              value: r.id || null,
              placeholder: 'Search name or email…',
              onChange: (id) => onPick(r, id),
            })
          );
        }
      }
      drawSummary();
    }

    function onPick(r, id) {
      r.id = id;
      const li = $(`#mtList .mt-row[data-key="${r.key}"]`);
      if (li) {
        const p = person(id);
        const em = li.querySelector('.mt-email-ro');
        if (em) {
          em.textContent = p && p.email ? p.email : 'Pick a person';
          em.classList.toggle('empty', !(p && p.email));
        }
        const holder = li.querySelector('.mt-pick');
        if (holder) holder.classList.remove('bad');
        if (!li.querySelector('.bad')) li.classList.remove('has-error');
      }
      refreshItems();
      if (!$('#mtList .bad')) showErrors([]);
      markDirty();
    }

    function showErrors(list, extraHtml = '') {
      const box = $('#mtErrors');
      if (!box) return;
      if (!list.length) {
        box.innerHTML = '';
        return;
      }
      const shown = list.slice(0, 6);
      box.innerHTML = `<b>${list.length === 1 ? 'Please check this:' : `Please fix these ${list.length} things:`}</b><ul>${shown.map((p) => `<li>${esc(p)}</li>`).join('')}${
        list.length > 6 ? `<li>…and ${list.length - 6} more.</li>` : ''
      }</ul>${extraHtml}`;
    }

    function scrollToFirstBad() {
      const target = $('#mtList .mt-row.has-error') || $('#mtErrors');
      if (target) target.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
    }

    function markDirty() {
      dirty = true;
      drawSummary();
    }

    function validate() {
      const problems = [];
      const bad = new Map();
      const flag = (r, field) => {
        if (!bad.has(r.key)) bad.set(r.key, new Set());
        bad.get(r.key).add(field);
      };
      const seen = new Map();
      rows.forEach((r, i) => {
        const n = i + 1;
        const p = person(r.id);
        const who = p ? p.name : `Row ${n}`;
        if (!p) {
          problems.push(`Row ${n}: pick a person from the employee list.`);
          flag(r, 'pick');
        } else if (seen.has(r.id)) {
          problems.push(`${who} is in the list twice (rows ${seen.get(r.id)} and ${n}).`);
          flag(r, 'pick');
        } else {
          seen.set(r.id, n);
          if (p.teamId && p.teamId !== team.id) {
            problems.push(`${who} is already in ${p.teamName || 'another team'}.`);
            flag(r, 'pick');
          }
        }
        if (r.gender !== 'M' && r.gender !== 'F') {
          problems.push(`${who}: choose Male or Female.`);
          flag(r, 'gender');
        }
      });
      if (rows.length > TEAM_MAX) problems.push(`A team can have at most ${TEAM_MAX} members.`);
      return { problems, bad };
    }

    /** "Paste from Excel": match each line to the employee master by email, then by exact name. */
    function pasteAdd() {
      const ta = $('#mtPasteIn');
      const note = $('#mtPasteNote');
      const parsed = parsePaste(ta.value);
      if (!parsed.length) {
        note.textContent = 'Nothing to add. Paste names or emails, one person per line (gender optional).';
        return;
      }
      const byEmail = new Map(directory.filter((p) => p.email).map((p) => [String(p.email).toLowerCase(), p]));
      const byName = new Map();
      for (const p of directory) {
        const k = normName(p.name);
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(p);
      }
      const inList = new Set(rows.map((r) => r.id).filter(Boolean));
      const added = [];
      const already = [];
      const otherTeam = [];
      const missing = [];
      const twoMatches = [];
      const leftLines = [];
      let over = 0;
      for (const line of parsed) {
        const label = line.name || line.email;
        let p = line.email ? byEmail.get(line.email.toLowerCase()) || null : null;
        if (!p && line.name) {
          const hits = byName.get(normName(line.name)) || [];
          if (hits.length > 1) {
            twoMatches.push(label);
            leftLines.push(line);
            continue;
          }
          p = hits[0] || null;
        }
        if (!p) {
          missing.push(label);
          leftLines.push(line);
          continue;
        }
        const cur = people.get(p.id) || p;
        if (inList.has(p.id)) {
          already.push(cur.name);
          continue;
        }
        if (cur.teamId && cur.teamId !== team.id) {
          otherTeam.push(`${cur.name} (${cur.teamName || 'another team'})`);
          continue;
        }
        if (rows.length >= TEAM_MAX) {
          over++;
          leftLines.push(line);
          continue;
        }
        rows.push({ key: ++seq, id: p.id, gender: line.gender || '', isLeader: false, hasVoted: false });
        inList.add(p.id);
        added.push(cur.name);
      }
      if (added.length) {
        markDirty();
        drawList();
        showErrors([]);
      }
      // keep only the lines that still need attention in the box
      ta.value = leftLines.map((l) => [l.name, l.email, l.gender].filter(Boolean).join('\t')).join('\n');
      const noGender = added.length ? rows.filter((r) => !r.isLeader && added.length && !r.gender).length : 0;
      const parts = [];
      parts.push(added.length ? `<b>Added ${added.length}.</b>` : '<b>Nobody new was added.</b>');
      if (noGender) parts.push(`Choose the gender for ${noGender} ${noGender === 1 ? 'person' : 'people'}, then tap Save team.`);
      else if (added.length) parts.push('Check the list, then tap Save team.');
      if (already.length) parts.push(`Already in your list: ${esc(already.join(', '))}.`);
      if (otherTeam.length) parts.push(`<span class="warn-text">In another team (ask the organiser): ${esc(otherTeam.join(', '))}.</span>`);
      if (missing.length) parts.push(`<span class="warn-text">Not in the employee master: ${esc(missing.join(', '))}.</span>`);
      if (twoMatches.length) parts.push(`<span class="warn-text">More than one person with this name, paste the email instead: ${esc(twoMatches.join(', '))}.</span>`);
      if (over) parts.push(`${over} left out (a team can have at most ${TEAM_MAX}).`);
      note.innerHTML = parts.map((x) => `<span>${x}</span>`).join('');
    }

    async function save() {
      const btn = $('#mtSave');
      // rows that were added but never filled in are simply dropped
      const before = rows.length;
      rows = rows.filter((r) => r.isLeader || r.id || r.gender);
      if (rows.length !== before) drawList();
      const { problems, bad } = validate();
      if (problems.length) {
        drawList(bad);
        showErrors(problems);
        scrollToFirstBad();
        shake(btn);
        return;
      }
      showErrors([]);
      const label = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const d = await api('/api/team', { method: 'POST', body: { members: rows.map((r) => ({ id: r.id, gender: r.gender })) } });
        if (!live()) return;
        apply(d);
        draw();
        toast(`Team saved · ${rows.length} member${rows.length === 1 ? '' : 's'}`);
        Sound.chime(880, 0.12);
        // the leader's own gender may have changed, and new members change the Best Dress lists
        refreshMe();
        refreshState();
      } catch (e) {
        if (!live()) return;
        btn.disabled = false;
        btn.innerHTML = label;
        handleSaveError(e, btn);
      }
    }

    function handleSaveError(e, btn) {
      if (e.status === 401 || e.code === 'AUTH') return logout('Please log in again with your office email.');
      if (e.code === 'NOT_LEADER') {
        toast('You’re no longer a team leader.');
        dirty = false;
        refreshMe().then(() => go('#/hub'));
        return;
      }
      if (e.code === 'LOCKED') {
        canEdit = false;
        dirty = false;
        draw();
        showErrors([e.message]);
        return;
      }
      const bad = new Map();
      const flagRow = (r, field) => r && bad.set(r.key, new Set([field]));
      if (e.code === 'INVALID' && e.data && e.data.row) {
        const r = rows[e.data.row - 1];
        flagRow(r, /gender/i.test(String(e.message || '')) ? 'gender' : 'pick');
      } else if (e.code === 'TAKEN') {
        // "<name> is already in team <X>." — our list was out of date; mark that person as taken
        const m = /^(.+?) is already in team (.+?)\.?$/i.exec(String(e.message || '').trim());
        if (m) {
          const nm = normName(m[1]);
          const r = rows.find((x) => {
            const p = person(x.id);
            return p && normName(p.name) === nm;
          });
          if (r) {
            const p = person(r.id);
            if (!p.teamId || p.teamId === team.id) p.teamId = '__other__';
            p.teamName = m[2];
            flagRow(r, 'pick');
          }
        }
      }
      drawList(bad);
      showErrors([e.message], e.code === 'TAKEN' ? '<button class="link-btn" type="button" id="mtReload">Reload the employee list</button>' : '');
      const rl = $('#mtReload');
      if (rl) rl.addEventListener('click', loadTeam);
      scrollToFirstBad();
      shake(btn);
    }

    function draw() {
      const b = body();
      if (!b) return;
      destroyCombos();
      b.innerHTML = `
  <p class="kicker">👑 Team leader</p>
  <h1 class="h1">${esc(team.name)}</h1>
  <p class="muted mt-lead">Pick everyone in your team from the employee list and choose their gender. They log in with their office email to vote, and gender puts them in Best Dress (Male) or Best Dress (Female).</p>
  ${canEdit ? '' : `<div class="mt-notice">${ICONS.lock}<span>The organiser has locked the team lists.</span></div>`}
  ${
    canEdit && !directory.length
      ? `<div class="mt-notice">${ICONS.lock}<span>The employee list is empty. Ask the organiser to import the employee master first.</span></div>`
      : ''
  }
  <div class="mt-summary" id="mtSummary"></div>
  <div class="mt-errors" id="mtErrors" role="alert"></div>
  <div class="mt-head" aria-hidden="true"><span>#</span><span>Name</span><span>Email</span><span>Gender</span><span></span></div>
  <ol class="mt-list" id="mtList"></ol>
  ${
    canEdit
      ? `<div class="mt-actions"><button class="btn btn-ghost" type="button" id="mtAdd">${ICONS.plus} Add member</button></div>
  <details class="mt-paste" id="mtPaste">
    <summary>${ICONS.copy} Paste from Excel</summary>
    <p class="muted sm">One person per line: their <b>email</b> or <b>full name</b>, and optionally the gender (M/F). Everyone must already be in the employee master. Copy the columns from Excel or Google Sheets and paste them here. A header row is fine.</p>
    <textarea class="mt-paste-in" id="mtPasteIn" rows="5" spellcheck="false" placeholder="Rahul Verma&#9;rahul@mobilise.co.in&#9;M&#10;priya@mobilise.co.in&#9;F"></textarea>
    <div class="mt-paste-row"><button class="btn btn-ghost sm" type="button" id="mtPasteAdd">Add these people</button></div>
    <div class="mt-paste-note sm" id="mtPasteNote" role="status"></div>
  </details>
  <div class="mt-foot"><button class="btn btn-gold" type="button" id="mtSave">${ICONS.check} Save team</button></div>`
      : ''
  }`;
      drawList();
      bind();
    }

    function bind() {
      const list = $('#mtList');
      list.addEventListener('change', (e) => {
        const sel = e.target.closest('select.mt-in');
        if (!sel || sel.disabled) return;
        const r = rowOf(sel);
        if (!r || r.gender === sel.value) return;
        r.gender = sel.value;
        sel.classList.remove('bad');
        const li = sel.closest('.mt-row');
        if (li && !li.querySelector('.bad')) li.classList.remove('has-error');
        if (!list.querySelector('.bad')) showErrors([]);
        markDirty();
      });
      list.addEventListener('click', (e) => {
        const del = e.target.closest('.mt-del');
        if (!del) return;
        const r = rowOf(del);
        if (!r) return;
        rows = rows.filter((x) => x !== r);
        markDirty();
        drawList();
        showErrors([]);
      });
      if (!canEdit) return;
      $('#mtAdd').addEventListener('click', () => {
        if (rows.length >= TEAM_MAX) return showErrors([`A team can have at most ${TEAM_MAX} members.`]);
        const r = { key: ++seq, id: null, gender: '', isLeader: false, hasVoted: false };
        rows.push(r);
        markDirty();
        drawList();
        showErrors([]);
        const last = list.lastElementChild;
        if (last) last.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
        const c = combos.get(r.key);
        if (c) setTimeout(() => (typeof c.open === 'function' ? c.open() : c.focus()), 80);
      });
      $('#mtPasteAdd').addEventListener('click', pasteAdd);
      $('#mtSave').addEventListener('click', save);
    }

    loadTeam();
  }

  function entryRow(e, i, val) {
    const chips = Array.from({ length: 10 }, (_, k) => {
      const v = k + 1;
      const sel = val === v;
      const tab = sel || (!val && v === 1) ? 0 : -1;
      return `<button type="button" role="radio" class="sc${val && v <= val ? ' lit' : ''}${sel ? ' sel' : ''}" style="--k:${v}" data-v="${v}" aria-checked="${sel}" aria-label="${v} out of 10" tabindex="${tab}">${v}</button>`;
    }).join('');
    return `
<li class="entry${val ? ' rated' : ''}" data-id="${esc(e.id)}" data-name="${esc(e.name.toLowerCase())}">
  <div class="entry-top">
    <span class="entry-no">${val ? ICONS.check : i + 1}</span>
    <span class="entry-name">${esc(e.name)}</span>
    <span class="entry-score">${val ? scoreLabel(val) : '<span class="es-empty">Not scored</span>'}</span>
  </div>
  <div class="scale" role="radiogroup" aria-label="Score for ${esc(e.name)}">${chips}</div>
</li>`;
  }

  function viewBallot(id) {
    if (!requireAuth()) return;
    const c = comp(id);
    if (!c) return go('#/hub');
    if (S.me.ballots[c.id]) return go('#/mine/' + c.id);
    if (c.status !== 'open') {
      toast('Voting for this competition is closed.');
      return go('#/hub');
    }
    const entries = entriesForMe(c);
    if (!entries.length) {
      toast('Participants will be added shortly.');
      return go('#/hub');
    }
    setDeco('none');
    FX.setLevel('off');
    const draft = getDraft(c.id);
    const n = entries.length;
    const v = S.me.voter;
    const ownTeamOn = !!(c.noOwnTeam && v.teamId);
    const selfNote =
      c.kind === 'teams'
        ? ownTeamOn && c.entries.some((e) => e.id === v.teamId)
          ? 'Your own team isn’t on the list.'
          : ''
        : ownTeamOn && c.entries.some((e) => e.teamId === v.teamId && e.id !== v.id)
          ? 'You and your team-mates aren’t on the list: no voting for your own team 😉'
          : c.entries.some((e) => e.id === v.id)
            ? 'You’re not on the list: no voting for yourself 😉'
            : '';
    app.innerHTML = `
<section class="screen ballot k-${c.kind}">
  <header class="ballot-head">
    <a class="icon-btn" href="#/hub" aria-label="Back to competitions">${ICONS.back}</a>
    <div class="bh-titles"><h1>${esc(c.title)}</h1><p>Scoring as ${esc(myName())}</p></div>
    <div class="bh-count" aria-live="polite"><b id="ratedCount">0</b><span>/${n}</span></div>
    <div class="bh-bar" aria-hidden="true"><span id="ratedBar"></span></div>
  </header>
  <p class="ballot-help">Tap a number, or slide your finger across, to score each ${noun(c, 1)}. <b>1</b> = okay · <b>10</b> = dazzling ✨${
      selfNote ? `<br><span class="faint">${selfNote}</span>` : ''
    }</p>
  ${n > 8 ? `<label class="search">${ICONS.search}<input type="search" id="q" placeholder="Search a name" autocomplete="off" aria-label="Search names"></label>` : ''}
  <ol class="entry-list" id="entryList">${entries.map((e, i) => entryRow(e, i, draft[e.id])).join('')}</ol>
  <p class="no-match" id="noMatch" hidden>No names match your search.</p>
  <div class="ballot-foot">
    <button class="btn btn-ghost" type="button" id="nextUnrated">${ICONS.down} Next unscored</button>
    <button class="btn btn-gold" type="button" id="reviewBtn">Review &amp; submit</button>
  </div>
</section>`;

    const list = $('#entryList');
    const q = $('#q');
    const reviewBtn = $('#reviewBtn');
    const nextBtn = $('#nextUnrated');

    function update() {
      const rated = entries.filter((e) => draft[e.id]).length;
      $('#ratedCount').textContent = rated;
      $('#ratedBar').style.width = (rated / n) * 100 + '%';
      reviewBtn.disabled = rated < n;
      reviewBtn.textContent = rated < n ? `${n - rated} left to score` : 'Review & submit';
      nextBtn.hidden = rated === n;
    }
    function paint(li, val) {
      li.classList.add('rated');
      li.querySelector('.entry-no').innerHTML = ICONS.check;
      li.querySelectorAll('.sc').forEach((b) => {
        const k = +b.dataset.v;
        b.classList.toggle('lit', k <= val);
        b.classList.toggle('sel', k === val);
        b.setAttribute('aria-checked', String(k === val));
        b.tabIndex = k === val ? 0 : -1;
      });
      li.querySelector('.entry-score').innerHTML = scoreLabel(val);
    }
    function setValue(li, val) {
      const eid = li.dataset.id;
      if (draft[eid] === val) return false;
      draft[eid] = val;
      setDraft(c.id, draft);
      paint(li, val);
      update();
      Sound.tap(val);
      vibrate(val === 10 ? [8, 30, 8] : 6);
      return true;
    }
    function sparkAt(li, val) {
      const b = li.querySelector(`.sc[data-v="${val}"]`);
      if (!b) return;
      const r = b.getBoundingClientRect();
      FX.spark(r.left + r.width / 2, r.top + r.height / 2, {
        count: 4 + val,
        power: 0.55 + val / 14,
        palette: val >= 9 ? ['gold', 'rani'] : ['gold', 'marigold'],
      });
      if (val === 10) Sound.sparkle();
    }
    function valueAt(scale, x) {
      const r = scale.getBoundingClientRect();
      return Math.max(1, Math.min(10, Math.ceil(((x - r.left) / r.width) * 10)));
    }

    // Tap to score (click does not fire when the finger was scrolling the page).
    // Ignore only the stray click some browsers fire on the same row right after a slide.
    let lastDrag = null;
    list.addEventListener('click', (e) => {
      const b = e.target.closest('.sc');
      if (!b) return;
      if (lastDrag && Date.now() - lastDrag.t < 350 && lastDrag.scale.contains(b)) return;
      const li = b.closest('.entry');
      const val = +b.dataset.v;
      setValue(li, val);
      sparkAt(li, val);
    });

    // Slide across the numbers to score (horizontal drag only; vertical drags scroll).
    let drag = null;
    list.addEventListener('pointerdown', (e) => {
      const scale = e.target.closest('.scale');
      if (!scale || e.button > 0) return;
      drag = { scale, li: scale.closest('.entry'), x0: e.clientX, y0: e.clientY, id: e.pointerId, active: false };
    });
    list.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0;
      const dy = e.clientY - drag.y0;
      if (!drag.active) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          drag.active = true;
          try {
            drag.scale.setPointerCapture(e.pointerId);
          } catch (err) {
            /* ignore */
          }
        } else if (Math.abs(dy) > 12) {
          drag = null;
          return;
        } else return;
      }
      setValue(drag.li, valueAt(drag.scale, e.clientX));
    });
    const endDrag = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      if (drag.active) {
        const val = draft[drag.li.dataset.id];
        if (val) sparkAt(drag.li, val);
        lastDrag = { scale: drag.scale, t: Date.now() };
      }
      drag = null;
    };
    list.addEventListener('pointerup', endDrag);
    list.addEventListener('pointercancel', endDrag);

    // Keyboard: arrows / Home / End / digits (0 = 10).
    list.addEventListener('keydown', (e) => {
      const b = e.target.closest('.sc');
      if (!b) return;
      const li = b.closest('.entry');
      const cur = draft[li.dataset.id] || 0;
      let val = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') val = Math.min(10, cur + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') val = Math.max(1, (cur || 2) - 1);
      else if (e.key === 'Home') val = 1;
      else if (e.key === 'End') val = 10;
      else if (/^[0-9]$/.test(e.key)) val = e.key === '0' ? 10 : +e.key;
      if (val == null) return;
      e.preventDefault();
      setValue(li, val);
      li.querySelector(`.sc[data-v="${val}"]`).focus();
    });

    if (q) {
      q.addEventListener('input', () => {
        const term = q.value.trim().toLowerCase();
        let shown = 0;
        $$('.entry', list).forEach((li) => {
          const ok = !term || li.dataset.name.includes(term);
          li.hidden = !ok;
          if (ok) shown++;
        });
        $('#noMatch').hidden = shown > 0;
      });
    }

    nextBtn.addEventListener('click', () => {
      let li = $$('.entry', list).find((x) => !draft[x.dataset.id] && !x.hidden);
      if (!li && q && q.value) {
        q.value = '';
        q.dispatchEvent(new Event('input'));
        li = $$('.entry', list).find((x) => !draft[x.dataset.id]);
      }
      if (!li) return;
      li.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
      li.classList.remove('flash');
      void li.offsetWidth;
      li.classList.add('flash');
    });

    reviewBtn.addEventListener('click', () => openReview(c, entries, draft));
    update();
  }

  function openReview(c, entries, draft) {
    const rows = entries
      .map((e) => ({ e, v: draft[e.id] }))
      .sort((a, b) => b.v - a.v || a.e.name.localeCompare(b.e.name));
    const s = sheet(
      `<h2 class="sheet-title">Review your scores</h2>
<p class="muted">${esc(myName())} · ${esc(c.title)}</p>
<ol class="review-list">${rows.map((r) => `<li><span>${esc(r.e.name)}</span><b class="rv-score" style="--k:${r.v}">${r.v}</b></li>`).join('')}</ol>
<p class="warn">${ICONS.lock} Once submitted, your scores are locked.</p>
<p class="form-error" role="alert"></p>
<div class="sheet-actions"><button class="btn btn-ghost" type="button" data-close>Edit</button><button class="btn btn-gold" type="button" id="submitVotes">Submit votes 🪔</button></div>`,
      { label: 'Review your scores' }
    );
    const btn = s.el.querySelector('#submitVotes');
    const err = s.el.querySelector('.form-error');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Submitting…';
      err.textContent = '';
      const scores = {};
      entries.forEach((e) => (scores[e.id] = draft[e.id]));
      try {
        const d = await api('/api/vote', { method: 'POST', body: { competitionId: c.id, scores } });
        S.me = { voter: (d && d.voter) || S.me.voter, ballots: (d && d.ballots) || S.me.ballots };
        clearDraft(c.id);
        s.close();
        go('#/done/' + c.id);
      } catch (ex) {
        btn.disabled = false;
        btn.textContent = 'Submit votes 🪔';
        if (ex.code === 'AUTH') {
          s.close();
          return logout('Your login has expired. Please log in again with your office email.');
        }
        if (ex.code === 'ALREADY_VOTED' || ex.code === 'CLOSED') {
          s.close();
          await Promise.all([refreshMe(), refreshState()]);
          toast(ex.message);
          return go('#/hub');
        }
        if (ex.code === 'INCOMPLETE' || ex.code === 'EMPTY') {
          s.close();
          await refreshState();
          toast('The list was updated by the organiser. Please score the new names.');
          return render();
        }
        err.textContent = ex.message;
      }
    });
  }

  function viewDone(id) {
    if (!requireAuth()) return;
    const c = comp(id);
    if (!c) return go('#/hub');
    setDeco('full');
    FX.setLevel('low');
    const next = S.state.competitions.find((x) => x.status === 'open' && !S.me.ballots[x.id] && entriesForMe(x).length);
    const allDone = S.state.competitions.every((x) => S.me.ballots[x.id]);
    app.innerHTML = `
<section class="screen done">
  <div class="done-diya">${Art.diya({ cls: 'xl' })}</div>
  <h1 class="h1 gold-text">Votes submitted!</h1>
  <p class="lead">Thank you, <b>${esc(firstName())}</b>. Your scores for <b>${esc(c.title)}</b> are safely locked in.</p>
  <div class="cta-stack narrow">
    ${next ? `<a class="btn btn-gold btn-lg" href="#/vote/${esc(next.id)}">Next: ${esc(next.title)} ${ICONS.next}</a>` : ''}
    ${allDone ? `<p class="all-done">You’ve voted in every competition! 🎆 Winners will be revealed at the celebration.</p>` : ''}
    <a class="btn btn-ghost" href="#/hub">Back to competitions</a>
  </div>
</section>`;
    Sound.chime(783.99, 0.15);
    setTimeout(() => Sound.chime(1046.5, 0.12), 200);
    FX.finale(reduceMotion() ? 2 : 5, { vol: 0.6 });
  }

  function viewMine(id) {
    if (!requireAuth()) return;
    const c = comp(id);
    const b = c && S.me.ballots[id];
    if (!b) return go('#/hub');
    setDeco('none');
    FX.setLevel('calm');
    const names = new Map(c.entries.map((e) => [e.id, e.name]));
    const rows = Object.entries(b.scores)
      .map(([eid, v]) => ({ name: names.get(eid) || '(removed)', v }))
      .sort((x, y) => y.v - x.v || x.name.localeCompare(y.name));
    app.innerHTML = `
<section class="screen mine">
  <header class="topbar"><a class="icon-btn" href="#/hub" aria-label="Back">${ICONS.back}</a>${brand('sm')}${soundBtn()}</header>
  <p class="kicker">Your scores</p>
  <h1 class="h1">${esc(c.title)}</h1>
  <p class="muted">Submitted by ${esc(myName())} · ${esc(fmtTime(b.at))}</p>
  <ol class="review-list big">${rows.map((r) => `<li><span>${esc(r.name)}</span><b class="rv-score" style="--k:${r.v}">${r.v}</b></li>`).join('')}</ol>
</section>`;
  }

  function podiumCard(c) {
    const p = c.podium || [];
    const at = (rank) => p.filter((x) => x.rank === rank);
    const col = (rank) => {
      const list = at(rank);
      return `<div class="pod pod-${rank}${list.length ? '' : ' empty'}">
  <div class="pod-names">${
    list.length ? list.map((x) => `<span class="pod-name">${esc(x.name)}</span>`).join('') : '<span class="pod-name faint">—</span>'
  }</div>
  ${list.length ? `<span class="pod-score">${fmtAvg(list[0].avg)} / 10${list.length > 1 ? ' · tie' : ''}</span>` : ''}
  <div class="pod-block"><span class="pod-medal" aria-hidden="true">${['', '🥇', '🥈', '🥉'][rank]}</span><span class="pod-rank">${['', '1st', '2nd', '3rd'][rank]}</span></div>
</div>`;
    };
    return `
<article class="podium-card k-${c.kind}">
  <div class="pc-head"><span class="pc-ic">${ICONS[c.kind]}</span><h2>${esc(c.title)}</h2></div>
  ${p.length ? `<div class="podium">${col(2)}${col(1)}${col(3)}</div>` : '<p class="muted center">No votes were cast.</p>'}
</article>`;
  }

  function viewResults() {
    setDeco('full');
    FX.setLevel('medium');
    const pubs = S.state.competitions.filter((c) => c.published);
    app.innerHTML = `
<section class="screen results">
  <header class="topbar"><a class="icon-btn" href="${S.me ? '#/hub' : '#/'}" aria-label="Back">${ICONS.back}</a>${brand('sm')}${soundBtn()}</header>
  <p class="kicker center">${esc(S.state.settings.eventTitle)}</p>
  <h1 class="h1 center gold-text">And the winners are…</h1>
  <div class="podium-list">
  ${
    pubs.length
      ? pubs.map(podiumCard).join('')
      : `<div class="empty-card"><div class="empty-diya">${Art.diya({ cls: 'md' })}</div><p>Results will be revealed at the celebration. Stay tuned! ✨</p></div>`
  }
  </div>
</section>`;
    enableSkyTaps($('.results'));
  }

  /* ================================================================ */
  /* Intro, polling, boot                                              */
  /* ================================================================ */
  function playIntro() {
    window.scrollTo(0, 0);
    Intro.run({
      settings: S.state.settings,
      onDone: () => {
        LS.set('dw_intro_seen', '1');
        render();
      },
    });
  }

  function startPolling() {
    setInterval(async () => {
      if (document.hidden || document.body.classList.contains('intro-active')) return;
      S.polls++;
      const prev = S.state;
      let next;
      try {
        next = await api('/api/state', { auth: false });
      } catch (e) {
        return;
      }
      // Check the login every other poll: logs out removed employees, picks up ballots reset by the organiser.
      let meChanged = false;
      if (S.me && S.polls % 2 === 0) {
        try {
          const me = await api('/api/me');
          if (me && me.voter) {
            meChanged = JSON.stringify(me.ballots) !== JSON.stringify(S.me.ballots) || JSON.stringify(me.voter) !== JSON.stringify(S.me.voter);
            S.me = { voter: me.voter, ballots: me.ballots || {} };
          }
        } catch (e) {
          if (e.status === 401) {
            S.state = next;
            return logout('Your login has expired. Please log in again with your office email.');
          }
        }
      }
      const stateChanged = JSON.stringify(prev) !== JSON.stringify(next);
      if (!stateChanged && !meChanged) return;
      S.state = next;
      if (stateChanged) {
        for (const c of next.competitions) {
          const old = prev.competitions.find((o) => o.id === c.id);
          if (!old) continue;
          if (c.published && !old.published) toast(`🏆 Results for ${c.title} are out!`, { action: ['See winners', '#/results'], ms: 8000 });
          else if (S.me && !S.me.ballots[c.id] && old.status !== c.status)
            toast(c.status === 'open' ? `Voting for ${c.title} is now open!` : `Voting for ${c.title} has closed.`);
        }
      }

      if (S.view === 'login') {
        const wasReady = !!(prev.emailLogin && prev.emailLogin.ready);
        if (wasReady !== emailReady() && !document.querySelector('.sheet-wrap')) render();
      } else if (S.view === 'ballot') {
        if (!stateChanged) return;
        const id = (location.hash.match(/^#\/vote\/([\w-]+)/) || [])[1];
        const c = comp(id);
        const old = prev.competitions.find((o) => o.id === id);
        if (!c || c.status !== 'open') go('#/hub');
        else if (old && (JSON.stringify(old.entries) !== JSON.stringify(c.entries) || old.noOwnTeam !== c.noOwnTeam)) {
          toast('The list was updated by the organiser.');
          const y = window.scrollY;
          render();
          window.scrollTo(0, y);
        }
      } else if (S.view === 'landing' || S.view === 'hub' || S.view === 'results') {
        if (document.querySelector('.sheet-wrap')) return;
        const y = window.scrollY;
        render();
        window.scrollTo(0, y);
      }
    }, 12000);
  }

  async function loadState() {
    for (;;) {
      try {
        S.state = await api('/api/state', { auth: false });
        return;
      } catch (e) {
        app.innerHTML = `<div class="loading"><p>${esc(e.message)}</p><button class="btn btn-gold" type="button" id="retry">Try again</button></div>`;
        await new Promise((r) => $('#retry').addEventListener('click', r, { once: true }));
        app.innerHTML = `<div class="loading"><div class="loading-diya">${Art.diya({ cls: 'md' })}</div><p>Lighting the diyas…</p></div>`;
      }
    }
  }

  async function init() {
    FX.init();
    buildGarland();
    $$('[data-sound-toggle]').forEach(Sound.syncButton);
    app.innerHTML = `<div class="loading"><div class="loading-diya">${Art.diya({ cls: 'md' })}</div><p>Lighting the diyas…</p></div>`;
    await loadState();
    if (token.get()) await refreshMe(); // old team logins are rejected by the server and cleared here

    const qs = new URLSearchParams(location.search);
    const wantsIntro = qs.has('intro');
    if (qs.get('email')) LS.set('dw_email', qs.get('email').trim().toLowerCase()); // /?email=… pre-fills the login form
    if (qs.has('team') || qs.has('pin')) {
      // Old team invite links: team voting has been replaced by personal email login.
      history.replaceState(null, '', location.pathname + (S.me ? '#/hub' : '#/login'));
      setTimeout(() => toast('Team links are retired: everyone now logs in with their own office email.', { ms: 6000 }), 600);
    } else if (qs.has('email')) {
      history.replaceState(null, '', location.pathname + (S.me ? '#/hub' : '#/login'));
    } else if (wantsIntro) {
      history.replaceState(null, '', location.pathname + location.hash);
    }

    window.addEventListener('hashchange', render);
    if (!LS.get('dw_intro_seen') || wantsIntro) playIntro();
    else render();
    startPolling();
  }

  init();
})();
