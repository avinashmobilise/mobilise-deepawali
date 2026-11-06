/* app.js — the voting app (mobile first, works on desktop too). */
(function () {
  'use strict';
  const { FX, Sound, Art, ICONS, LS, esc, Intro, reduceMotion } = window.DW;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const app = $('#app');

  const LABELS = ['', 'Hmm', 'Okay', 'Fair', 'Decent', 'Good', 'Nice', 'Great', 'Lovely', 'Superb', 'Dazzling!'];
  const NOUN = { teams: ['team', 'teams'], male: ['participant', 'participants'], female: ['participant', 'participants'] };

  const S = { state: null, me: null, view: '', cleanup: [] };

  /* ---------------- storage ---------------- */
  const token = {
    get: () => LS.get('dw_token'),
    set: (v) => (v ? LS.set('dw_token', v) : LS.del('dw_token')),
  };
  const draftKey = (cid) => `dw_draft_${S.me.team.id}_${cid}`;
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
      S.me = await api('/api/me');
    } catch (e) {
      if (e.status === 401) {
        token.set(null);
        S.me = null;
      }
    }
  }

  /* ---------------- helpers ---------------- */
  const comp = (id) => S.state.competitions.find((c) => c.id === id);
  const entriesForMe = (c) => (c.kind === 'teams' && S.me ? c.entries.filter((e) => e.id !== S.me.team.id) : c.entries);
  const noun = (c, n) => NOUN[c.kind][n === 1 ? 0 : 1];
  const myTeamName = () => {
    if (!S.me) return '';
    const t = S.state.teams.find((x) => x.id === S.me.team.id);
    return (t || S.me.team).name;
  };
  const soundBtn = () => `<button class="icon-btn" type="button" data-sound-toggle></button>`;
  const brand = (cls = '') => `<img class="brand-mark ${cls}" src="assets/mobilise-logo-white.svg" alt="Mobilise" width="132" height="28">`;
  const scoreLabel = (v) => `<b>${v}</b><small>${LABELS[v]}</small>`;
  const fmtAvg = (n) => String(Math.round(n * 100) / 100);
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

  function logout(msg) {
    token.set(null);
    S.me = null;
    if (msg) toast(msg);
    go('#/team');
  }

  /* ---------------- router ---------------- */
  const ROUTES = [
    [/^#?\/?$/, 'landing', viewLanding],
    [/^#\/team$/, 'team', viewTeam],
    [/^#\/hub$/, 'hub', viewHub],
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
    go('#/team');
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
    const needPin = st.settings.requirePin;
    app.innerHTML = `
<section class="screen landing">
  <header class="topbar">${brand()}${soundBtn()}</header>
  <div class="hero">
    <p class="hero-hi" lang="hi">शुभ दीपावली</p>
    <h1 class="hero-title gold-text">${esc(st.settings.eventTitle)}</h1>
    <p class="hero-lead">${st.competitions.length} sparkling competitions · ${st.teams.length} teams · 1 link.<br>Your scores decide who shines brightest this Diwali.</p>
    <div class="hero-diyas" aria-hidden="true">${Art.diya({ cls: 'sm' })}${Art.diya({ cls: 'md' })}${Art.diya({ cls: 'sm' })}</div>
  </div>
  <div class="mini-cards">
    ${st.competitions.map((c) => `<div class="mini-card k-${c.kind}"><span class="mini-ic">${ICONS[c.kind]}</span><span class="mini-t">${esc(c.title)}</span></div>`).join('')}
  </div>
  <div class="cta-stack">
    ${
      S.me
        ? `<a class="btn btn-gold btn-lg" href="#/hub">Continue as ${esc(myTeamName())} ${ICONS.next}</a>`
        : `<a class="btn btn-gold btn-lg" href="#/team">Cast your team’s vote ${ICONS.next}</a>`
    }
    ${anyPub ? `<a class="btn btn-ghost" href="#/results">${ICONS.trophy} See the winners</a>` : ''}
  </div>
  <ol class="how">
    <li><b>Pick your team</b><span>${needPin ? 'Enter the team PIN from your team lead.' : 'Choose your team from the list.'}</span></li>
    <li><b>Score 1 – 10</b><span>${st.competitions.map((c) => esc(c.title)).join(', ')}.</span></li>
    <li><b>Submit</b><span>Winners are revealed live at the celebration.</span></li>
  </ol>
  <footer class="foot">
    <button class="link-btn" type="button" id="replay">${ICONS.play} Replay intro</button>
    <span>Tap the sky for fireworks 🎆</span>
  </footer>
</section>`;
    $('#replay').addEventListener('click', playIntro);
    enableSkyTaps($('.landing'));
  }

  function viewTeam() {
    setDeco('full');
    FX.setLevel('calm');
    const st = S.state;
    app.innerHTML = `
<section class="screen team-screen">
  <header class="topbar"><a class="icon-btn" href="#/" aria-label="Back">${ICONS.back}</a>${brand('sm')}${soundBtn()}</header>
  <h1 class="h1">Which team are you?</h1>
  <p class="muted">${st.settings.requirePin ? 'One vote per team. Your team lead has the team PIN.' : 'One vote per team, so choose carefully!'}</p>
  <div class="team-grid">
    ${st.teams.map((t, i) => `<button class="team-btn" type="button" data-id="${esc(t.id)}"><span class="team-no">${i + 1}</span><span class="team-name">${esc(t.name)}</span></button>`).join('')}
  </div>
</section>`;
    $('.team-grid').addEventListener('click', (e) => {
      const b = e.target.closest('.team-btn');
      if (!b) return;
      const team = st.teams.find((t) => t.id === b.dataset.id);
      if (!team) return;
      $$('.team-btn').forEach((x) => x.classList.toggle('is-sel', x === b));
      Sound.unlock();
      Sound.tap(6);
      openLogin(team);
    });
  }

  function openLogin(team) {
    const needPin = S.state.settings.requirePin;
    const s = sheet(
      `<h2 class="sheet-title">${needPin ? 'Enter team PIN' : 'Confirm your team'}</h2>
<p class="muted">Voting as <b class="gold">${esc(team.name)}</b></p>
<form class="pin-form" novalidate>
  ${needPin ? `<input class="pin-input" id="pin" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="••••" aria-label="Team PIN" autofocus>` : ''}
  <p class="form-error" role="alert"></p>
  <div class="sheet-actions">
    <button class="btn btn-ghost" type="button" data-close>Cancel</button>
    <button class="btn btn-gold" type="submit">${needPin ? 'Enter' : 'Yes, that’s us'}</button>
  </div>
</form>`,
      { label: 'Team login' }
    );
    const form = s.el.querySelector('form');
    const input = s.el.querySelector('#pin');
    const err = s.el.querySelector('.form-error');
    if (input) input.addEventListener('input', () => (input.value = input.value.replace(/\D/g, '').slice(0, 6)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      if (input && !input.value) {
        err.textContent = 'Please enter your team PIN.';
        return;
      }
      btn.disabled = true;
      err.textContent = '';
      try {
        const d = await api('/api/login', { method: 'POST', auth: false, body: { teamId: team.id, pin: input ? input.value : '' } });
        token.set(d.token);
        S.me = { team: d.team, ballots: d.ballots };
        s.close();
        Sound.chime(880, 0.14);
        go('#/hub');
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        form.classList.remove('shake');
        void form.offsetWidth;
        form.classList.add('shake');
        vibrate([30, 40, 30]);
        if (input) input.select();
      }
    });
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
    app.innerHTML = `
<section class="screen hub">
  <header class="topbar">${brand('sm')}<div class="topbar-actions">${soundBtn()}<button class="chip-btn" type="button" id="switchTeam">${ICONS.swap} Switch team</button></div></header>
  <div class="hub-hello">
    <p class="kicker">Namaste <span aria-hidden="true">🙏</span></p>
    <h1 class="h1">${esc(myTeamName())}</h1>
    <div class="hub-progress">
      <div class="hp-diyas" aria-hidden="true">${comps.map((c) => Art.diya({ lit: !!S.me.ballots[c.id], cls: 'xs' })).join('')}</div>
      <p><b>${done} of ${comps.length}</b> votes cast${done === comps.length ? ' · all done! 🎉' : ''}</p>
    </div>
  </div>
  <div class="comp-list">${comps.map(compCard).join('')}</div>
  ${comps.some((c) => c.published) ? `<a class="btn btn-ghost wide" href="#/results">${ICONS.trophy} See the winners</a>` : ''}
</section>`;
    $('#switchTeam').addEventListener('click', () => {
      const s = sheet(
        `<h2 class="sheet-title">Switch team?</h2>
<p class="muted">You’ll need the other team’s PIN to log in again.</p>
<div class="sheet-actions"><button class="btn btn-ghost" type="button" data-close>Stay</button><button class="btn btn-gold" type="button" id="doSwitch">Switch team</button></div>`,
        { label: 'Switch team' }
      );
      s.el.querySelector('#doSwitch').addEventListener('click', () => {
        s.close();
        logout();
      });
    });
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
    app.innerHTML = `
<section class="screen ballot k-${c.kind}">
  <header class="ballot-head">
    <a class="icon-btn" href="#/hub" aria-label="Back to competitions">${ICONS.back}</a>
    <div class="bh-titles"><h1>${esc(c.title)}</h1><p>${esc(myTeamName())} is scoring</p></div>
    <div class="bh-count" aria-live="polite"><b id="ratedCount">0</b><span>/${n}</span></div>
    <div class="bh-bar" aria-hidden="true"><span id="ratedBar"></span></div>
  </header>
  <p class="ballot-help">Tap a number, or slide your finger across, to score each ${noun(c, 1)}. <b>1</b> = okay · <b>10</b> = dazzling ✨${
      c.kind === 'teams' ? '<br><span class="faint">Your own team isn’t on the list.</span>' : ''
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
    function paint(li, v) {
      li.classList.add('rated');
      li.querySelector('.entry-no').innerHTML = ICONS.check;
      li.querySelectorAll('.sc').forEach((b) => {
        const k = +b.dataset.v;
        b.classList.toggle('lit', k <= v);
        b.classList.toggle('sel', k === v);
        b.setAttribute('aria-checked', String(k === v));
        b.tabIndex = k === v ? 0 : -1;
      });
      li.querySelector('.entry-score').innerHTML = scoreLabel(v);
    }
    function setValue(li, v) {
      const eid = li.dataset.id;
      if (draft[eid] === v) return false;
      draft[eid] = v;
      setDraft(c.id, draft);
      paint(li, v);
      update();
      Sound.tap(v);
      vibrate(v === 10 ? [8, 30, 8] : 6);
      return true;
    }
    function sparkAt(li, v) {
      const b = li.querySelector(`.sc[data-v="${v}"]`);
      if (!b) return;
      const r = b.getBoundingClientRect();
      FX.spark(r.left + r.width / 2, r.top + r.height / 2, {
        count: 4 + v,
        power: 0.55 + v / 14,
        palette: v >= 9 ? ['gold', 'rani'] : ['gold', 'marigold'],
      });
      if (v === 10) Sound.sparkle();
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
      const v = +b.dataset.v;
      setValue(li, v);
      sparkAt(li, v);
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
        const v = draft[drag.li.dataset.id];
        if (v) sparkAt(drag.li, v);
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
      let v = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = Math.min(10, cur + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = Math.max(1, (cur || 2) - 1);
      else if (e.key === 'Home') v = 1;
      else if (e.key === 'End') v = 10;
      else if (/^[0-9]$/.test(e.key)) v = e.key === '0' ? 10 : +e.key;
      if (v == null) return;
      e.preventDefault();
      setValue(li, v);
      li.querySelector(`.sc[data-v="${v}"]`).focus();
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
<p class="muted">${esc(myTeamName())} · ${esc(c.title)}</p>
<ol class="review-list">${rows.map((r) => `<li><span>${esc(r.e.name)}</span><b class="rv-score" style="--k:${r.v}">${r.v}</b></li>`).join('')}</ol>
<p class="warn">${ICONS.lock} Once submitted, your team’s scores are locked.</p>
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
        S.me = { team: d.team, ballots: d.ballots };
        clearDraft(c.id);
        s.close();
        go('#/done/' + c.id);
      } catch (ex) {
        btn.disabled = false;
        btn.textContent = 'Submit votes 🪔';
        if (ex.code === 'AUTH') {
          s.close();
          return logout('Please log in with your team PIN again.');
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
  <p class="lead">Thank you, <b>${esc(myTeamName())}</b>. Your scores for <b>${esc(c.title)}</b> are safely locked in.</p>
  <div class="cta-stack narrow">
    ${next ? `<a class="btn btn-gold btn-lg" href="#/vote/${esc(next.id)}">Next: ${esc(next.title)} ${ICONS.next}</a>` : ''}
    ${allDone ? `<p class="all-done">That’s all three! 🎆 Winners will be revealed at the celebration.</p>` : ''}
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
  <p class="kicker">Your team’s scores</p>
  <h1 class="h1">${esc(c.title)}</h1>
  <p class="muted">Submitted by ${esc(myTeamName())} · ${esc(fmtTime(b.at))}</p>
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
      const prev = S.state;
      let next;
      try {
        next = await api('/api/state', { auth: false });
      } catch (e) {
        return;
      }
      if (JSON.stringify(prev) === JSON.stringify(next)) return;
      S.state = next;
      for (const c of next.competitions) {
        const old = prev.competitions.find((o) => o.id === c.id);
        if (!old) continue;
        if (c.published && !old.published) toast(`🏆 Results for ${c.title} are out!`, { action: ['See winners', '#/results'], ms: 8000 });
        else if (S.me && !S.me.ballots[c.id] && old.status !== c.status)
          toast(c.status === 'open' ? `Voting for ${c.title} is now open!` : `Voting for ${c.title} has closed.`);
      }
      if (S.me && !next.teams.some((t) => t.id === S.me.team.id)) return logout('Your team was changed by the organiser. Please pick it again.');

      if (S.view === 'ballot') {
        const id = (location.hash.match(/^#\/vote\/([\w-]+)/) || [])[1];
        const c = comp(id);
        const old = prev.competitions.find((o) => o.id === id);
        if (!c || c.status !== 'open') go('#/hub');
        else if (old && JSON.stringify(old.entries) !== JSON.stringify(c.entries)) {
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

    // Personal invite links: /?team=<id>&pin=<pin> log the team straight in.
    const qs = new URLSearchParams(location.search);
    const wantsIntro = qs.has('intro');
    if (qs.get('team')) {
      try {
        const d = await api('/api/login', { method: 'POST', auth: false, body: { teamId: qs.get('team'), pin: qs.get('pin') || '' } });
        token.set(d.token);
        S.me = { team: d.team, ballots: d.ballots };
        history.replaceState(null, '', location.pathname + '#/hub');
      } catch (e) {
        history.replaceState(null, '', location.pathname + '#/team');
        setTimeout(() => toast(e.message, { error: true, ms: 6000 }), 600);
      }
    } else {
      if (token.get()) await refreshMe();
      if (wantsIntro) history.replaceState(null, '', location.pathname + location.hash);
    }

    window.addEventListener('hashchange', render);
    if (!LS.get('dw_intro_seen') || wantsIntro) playIntro();
    else render();
    startPolling();
  }

  init();
})();
