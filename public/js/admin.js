/* admin.js — organiser console: live results, setup, teams & PINs, on-screen winner reveal. */
(function () {
  'use strict';
  const { FX, Sound, Art, ICONS, LS, esc } = window.DW;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const root = $('#admin');
  const A = { token: LS.get('dw_admin'), data: null, tab: LS.get('dw_admin_tab') || 'live', expanded: new Set(), revealing: false, poll: null };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ordinal = (n) => ['', '1st', '2nd', '3rd'][n] || n + 'th';
  const fmtAvg = (n) => String(Math.round(n * 100) / 100);
  const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const comp = (id) => A.data.competitions.find((c) => c.id === id);
  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }
  const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  /* ---------------- api ---------------- */
  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json' };
    const init = { method: opts.method || 'GET', headers, cache: 'no-store' };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (A.token) headers.Authorization = 'Bearer ' + A.token;
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw new Error('Cannot reach the server. Is it still running?');
    }
    if (res.status === 401 && path !== '/api/admin/login') {
      logout('Please log in again.');
      throw new Error('Please log in again.');
    }
    if (opts.raw) {
      if (!res.ok) throw new Error('Download failed.');
      return res;
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* not JSON */
    }
    if (!res.ok) throw new Error((data && data.error) || `Something went wrong (${res.status}).`);
    return data;
  }

  /* ---------------- ui helpers ---------------- */
  let toastTimer;
  function toast(msg, isError) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('is-error', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
  }

  function sheet(html, label = 'Dialog') {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `<div class="sheet-backdrop" data-close></div><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}"><div class="sheet-handle" aria-hidden="true"></div>${html}</div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      wrap.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => wrap.remove(), 300);
    };
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => e.target.closest('[data-close]') && close());
    setTimeout(() => {
      const b = wrap.querySelector('.sheet .btn-danger, .sheet .btn-gold, .sheet button');
      if (b) b.focus();
    }, 80);
    return { el: wrap, close };
  }

  function confirmSheet({ title, body, cta, danger = true }) {
    return new Promise((resolve) => {
      const s = sheet(
        `<h2 class="sheet-title">${esc(title)}</h2><p class="muted">${body}</p>
<div class="sheet-actions"><button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-gold'}" type="button" id="cfOk">${esc(cta)}</button></div>`,
        title
      );
      let answered = false;
      s.el.querySelector('#cfOk').addEventListener('click', () => {
        answered = true;
        s.close();
        resolve(true);
      });
      s.el.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]') && !answered) resolve(false);
      });
    });
  }

  async function copy(text, okMsg = 'Copied!') {
    try {
      await navigator.clipboard.writeText(text);
      return toast(okMsg);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      ta.remove();
      if (ok) return toast(okMsg);
      sheet(
        `<h2 class="sheet-title">Copy this text</h2><textarea class="copy-area" rows="8" readonly>${esc(text)}</textarea><div class="sheet-actions"><button class="btn btn-gold" type="button" data-close>Done</button></div>`,
        'Copy'
      );
    }
  }

  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn && document.body.contains(btn)) btn.disabled = false;
    }
  }

  const publicBase = () => (A.data.settings.publicUrl || location.origin).replace(/\/+$/, '');
  const inviteUrl = (t) => `${publicBase()}/?team=${encodeURIComponent(t.id)}&pin=${encodeURIComponent(t.pin)}`;
  const inviteText = (t) => `🪔 ${A.data.settings.eventTitle} · voting link for ${t.name}\n${inviteUrl(t)}\nPlease keep this link within your team.`;

  /* ---------------- login / shell ---------------- */
  function loginView(msg) {
    document.body.classList.remove('signed-in');
    root.innerHTML = `
<section class="admin-login">
  <img class="brand-mark" src="assets/mobilise-logo-white.svg" alt="Mobilise" width="150" height="31">
  <div class="login-diya" aria-hidden="true">${Art.diya({ cls: 'md' })}</div>
  <h1 class="h1">Organiser console</h1>
  <p class="muted">Manage teams, voting and the live winner reveal.</p>
  <form id="loginForm" class="panel login-card" novalidate>
    <label class="field">Admin password<input id="pw" type="password" autocomplete="current-password" required autofocus></label>
    <p class="form-error" role="alert">${esc(msg || '')}</p>
    <button class="btn btn-gold wide" type="submit">Log in</button>
  </form>
  <a class="link-btn" href="./">${ICONS.back} Back to the voting app</a>
</section>`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      const err = e.target.querySelector('.form-error');
      btn.disabled = true;
      err.textContent = '';
      try {
        const d = await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } });
        A.token = d.token;
        LS.set('dw_admin', d.token);
        await enter();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    });
  }

  function logout(msg) {
    A.token = null;
    A.data = null;
    LS.del('dw_admin');
    clearInterval(A.poll);
    loginView(msg);
  }

  async function enter() {
    A.data = await api('/api/admin/data');
    document.body.classList.add('signed-in');
    root.innerHTML = `
<header class="admin-top">
  <div class="at-left"><img class="brand-mark sm" src="assets/mobilise-logo-white.svg" alt="Mobilise" width="110" height="23"><span class="at-title">Organiser console</span></div>
  <div class="at-right">
    <a class="chip-btn" href="./" target="_blank" rel="noopener">${ICONS.eye}<span class="hide-sm"> Open app</span></a>
    <button class="icon-btn" type="button" data-sound-toggle></button>
    <button class="chip-btn" type="button" id="logoutBtn">Log out</button>
  </div>
</header>
<nav class="tabs" role="tablist" aria-label="Sections">
  ${[['live', 'Live results'], ['setup', 'Setup'], ['teams', 'Teams & PINs']]
    .map(([k, l]) => `<button role="tab" type="button" class="tab" data-tab="${k}">${l}</button>`)
    .join('')}
</nav>
<div id="banner"></div>
<main class="admin-body" id="tabBody"></main>`;
    $$('[data-sound-toggle]').forEach(Sound.syncButton);
    $('#logoutBtn').addEventListener('click', () => logout());
    renderTab();
    startPolling();
  }

  function renderTab() {
    const body = $('#tabBody');
    if (!body || !A.data) return;
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === A.tab;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
    });
    const banners = [];
    if (A.data.storageIsTemporary)
      banners.push(
        `<div class="banner danger">${ICONS.lock}<span><b>Votes are not being saved permanently.</b> This host wipes its disk on every restart. Add the <code>UPSTASH_REDIS_REST_URL</code> and <code>UPSTASH_REDIS_REST_TOKEN</code> settings (see README) before voting starts.</span></div>`
      );
    if (A.data.adminPasswordIsDefault)
      banners.push(
        `<div class="banner">${ICONS.lock}<span>You are using the default admin password. Restart the server with <code>ADMIN_PASSWORD</code> set before sharing the link.</span></div>`
      );
    $('#banner').innerHTML = banners.join('');
    if (A.tab === 'setup') {
      body.innerHTML = setupTab();
      bindSetup();
    } else if (A.tab === 'teams') {
      body.innerHTML = teamsTab();
      bindTeams();
    } else body.innerHTML = liveTab();
  }

  /* ---------------- live tab ---------------- */
  function liveTab() {
    const d = A.data;
    const teams = d.teams;
    const panels = d.competitions
      .map((c) => {
        const voted = new Set(c.voted.map((v) => v.teamId));
        const hasVotes = c.results.some((r) => r.votes > 0);
        const open = A.expanded.has(c.id);
        const rows = c.results
          .map(
            (r, i) => `<tr class="${i >= 5 && !open ? 'more' : ''}${r.votes && r.rank <= 3 ? ' top r' + r.rank : ''}">
  <td>${r.votes ? r.rank : '–'}</td><td>${esc(r.name)}</td><td class="num">${r.votes ? fmtAvg(r.avg) : '–'}</td><td class="num">${r.votes}</td></tr>`
          )
          .join('');
        return `
<article class="panel comp-panel k-${c.kind}" data-id="${esc(c.id)}">
  <header class="panel-head">
    <span class="pc-ic">${ICONS[c.kind]}</span>
    <div class="ph-text"><h2>${esc(c.title)}</h2><p class="muted sm">${c.entryCount} ${c.kind === 'teams' ? 'teams' : 'participants'} · <b>${voted.size}/${teams.length}</b> teams voted</p></div>
    <div class="seg" role="group" aria-label="Voting status for ${esc(c.title)}">
      <button type="button" class="${c.status === 'open' ? 'on' : ''}" data-act="status" data-v="open">Open</button>
      <button type="button" class="${c.status === 'closed' ? 'on' : ''}" data-act="status" data-v="closed">Closed</button>
    </div>
  </header>
  <div class="meter" aria-hidden="true"><span style="width:${teams.length ? (voted.size / teams.length) * 100 : 0}%"></span></div>
  <div class="team-chips">${teams
    .map((t) =>
      voted.has(t.id)
        ? `<button type="button" class="tchip done" data-act="ballot" data-team="${esc(t.id)}" title="Voted · click to manage">${ICONS.check}${esc(t.name)}</button>`
        : `<span class="tchip">${esc(t.name)}</span>`
    )
    .join('')}</div>
  <h3 class="sub-h">Live leaderboard <span class="faint">(average score)</span></h3>
  ${
    c.results.length
      ? `<table class="lb"><thead><tr><th>#</th><th>Name</th><th class="num">Avg</th><th class="num">Votes</th></tr></thead><tbody>${rows}</tbody></table>
         ${c.results.length > 5 ? `<button class="link-btn sm" type="button" data-act="more">${open ? 'Show top 5' : `Show all ${c.results.length}`}</button>` : ''}`
      : `<p class="muted sm">No ${c.kind === 'teams' ? 'teams' : 'participants'} yet. Add them in Setup.</p>`
  }
  <footer class="panel-actions">
    <label class="switch"><input type="checkbox" data-act="publish" ${c.published ? 'checked' : ''}><span class="sw" aria-hidden="true"></span>Show winners in the app</label>
    <div class="row-btns">
      <button class="btn btn-gold sm" type="button" data-act="reveal" ${hasVotes ? '' : 'disabled'}>${ICONS.sparkle} Reveal on screen</button>
      <button class="btn btn-danger sm" type="button" data-act="reset" ${c.voted.length ? '' : 'disabled'}>Reset votes</button>
    </div>
  </footer>
</article>`;
      })
      .join('');
    return `
<div class="live-grid">${panels}</div>
<div class="panel export-panel">
  <div><h2>Exports</h2><p class="muted sm">${d.ballotCount} ballots so far. Download a backup any time.</p></div>
  <div class="row-btns">
    <button class="btn btn-ghost sm" type="button" data-act="export" data-type="results">${ICONS.download} Results (CSV)</button>
    <button class="btn btn-ghost sm" type="button" data-act="export" data-type="ballots">${ICONS.download} Every ballot (CSV)</button>
  </div>
</div>`;
  }

  async function setComp(id, patch) {
    A.data = await api('/api/admin/competition', { method: 'POST', body: { id, ...patch } });
    renderTab();
  }

  async function download(type) {
    const res = await api('/api/admin/export?type=' + encodeURIComponent(type), { raw: true });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `diwali-utsav-${type}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1500);
  }

  /* ---------------- setup tab ---------------- */
  function setupTab() {
    const d = A.data;
    const s = d.settings;
    return `
<div class="setup-grid">
  <form class="panel" id="eventForm" novalidate>
    <h2>Event</h2>
    <label class="field">Event title<input name="eventTitle" value="${esc(s.eventTitle)}" maxlength="60"></label>
    <label class="field">Public link of this app<input name="publicUrl" value="${esc(s.publicUrl)}" placeholder="${esc(location.origin)}" inputmode="url">
      <small>Used to build team invite links. Leave empty to use ${esc(location.origin)}</small></label>
    <label class="switch"><input type="checkbox" name="requirePin" ${s.requirePin ? 'checked' : ''}><span class="sw" aria-hidden="true"></span>Teams need their PIN to vote (recommended)</label>
    <button class="btn btn-gold sm" type="submit">Save event</button>
  </form>

  <form class="panel" id="ownerForm" novalidate>
    <h2>Intro · greeting from the owner</h2>
    <div class="owner-edit">
      <div class="owner-thumb">${s.owner.photo ? `<img src="${esc(s.owner.photo)}" alt="">` : `<span>${esc(initials(s.owner.name))}</span>`}</div>
      <div class="owner-photo-actions">
        <label class="btn btn-ghost sm file-btn">${ICONS.plus} ${s.owner.photo ? 'Change photo' : 'Upload photo'}<input type="file" id="photoInput" accept="image/png,image/jpeg,image/webp" hidden></label>
        ${s.owner.photo ? `<button class="btn btn-ghost sm" type="button" data-act="photo-remove">${ICONS.trash} Remove</button>` : ''}
        <small class="faint">A square, front-facing photo looks best. Without a photo the intro shows initials.</small>
      </div>
    </div>
    <label class="field">Name<input name="name" value="${esc(s.owner.name)}" maxlength="60"></label>
    <label class="field">Title<input name="title" value="${esc(s.owner.title)}" maxlength="80"></label>
    <label class="field">Message<textarea name="message" rows="4" maxlength="600">${esc(s.owner.message)}</textarea></label>
    <div class="row-btns">
      <button class="btn btn-gold sm" type="submit">Save greeting</button>
      <a class="btn btn-ghost sm" href="./?intro=1" target="_blank" rel="noopener">${ICONS.play} Preview intro</a>
    </div>
  </form>

  <form class="panel span-2" id="peopleForm" novalidate>
    <h2>Best Dress participants</h2>
    <p class="muted sm">One name per line. Use full names so nobody gets confused (for example “Rahul Verma” and “Rahul Singh”).</p>
    <div class="two-col">
      <label class="field"><span class="field-label">${ICONS.male} Male <span class="count" id="maleCount"></span></span><textarea name="male" rows="12" spellcheck="false">${esc(d.people.male.map((p) => p.name).join('\n'))}</textarea></label>
      <label class="field"><span class="field-label">${ICONS.female} Female <span class="count" id="femaleCount"></span></span><textarea name="female" rows="12" spellcheck="false">${esc(d.people.female.map((p) => p.name).join('\n'))}</textarea></label>
    </div>
    <p class="form-note" id="peopleNote"></p>
    <button class="btn btn-gold sm" type="submit">Save participants</button>
  </form>

  <form class="panel span-2" id="compForm" novalidate>
    <h2>Competition names</h2>
    ${d.competitions
      .map(
        (c) => `<div class="comp-edit"><span class="pc-ic">${ICONS[c.kind]}</span>
  <input name="title-${esc(c.id)}" value="${esc(c.title)}" maxlength="60" aria-label="Title for ${esc(c.title)}">
  <input name="subtitle-${esc(c.id)}" value="${esc(c.subtitle)}" maxlength="120" aria-label="Description for ${esc(c.title)}"></div>`
      )
      .join('')}
    <button class="btn btn-gold sm" type="submit">Save names</button>
  </form>

  <div class="panel span-2 danger-zone">
    <div><h2>Danger zone</h2><p class="muted sm">Delete every ballot in all three competitions. Teams, PINs and names stay as they are.</p></div>
    <button class="btn btn-danger sm" type="button" data-act="reset-all" ${d.ballotCount ? '' : 'disabled'}>Reset all votes</button>
  </div>
</div>`;
  }

  function bindSetup() {
    $('#eventForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      busy(f.querySelector('[type=submit]'), async () => {
        A.data = await api('/api/admin/settings', {
          method: 'POST',
          body: { eventTitle: f.eventTitle.value, publicUrl: f.publicUrl.value, requirePin: f.requirePin.checked },
        });
        toast('Event settings saved');
        renderTab();
      });
    });

    $('#ownerForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      busy(f.querySelector('[type=submit]'), async () => {
        A.data = await api('/api/admin/settings', {
          method: 'POST',
          body: { owner: { name: f.name.value, title: f.title.value, message: f.message.value } },
        });
        toast('Greeting saved');
        renderTab();
      });
    });

    $('#photoInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) busy(null, () => uploadPhoto(file));
    });

    const pf = $('#peopleForm');
    const check = () => {
      const male = lines(pf.male.value);
      const female = lines(pf.female.value);
      $('#maleCount').textContent = `(${male.length})`;
      $('#femaleCount').textContent = `(${female.length})`;
      const seen = new Map();
      [...male, ...female].forEach((n) => seen.set(n.toLowerCase(), (seen.get(n.toLowerCase()) || 0) + 1));
      const dupes = [...seen.entries()].filter(([, k]) => k > 1).map(([n, k]) => `${n} ×${k}`);
      const hasVotes = A.data.competitions.some((c) => c.kind !== 'teams' && c.voted.length);
      $('#peopleNote').innerHTML = [
        dupes.length ? `<span class="warn-text">Repeated names: ${esc(dupes.join(', '))}. Add surnames so teams can tell them apart.</span>` : '',
        hasVotes ? 'Votes already cast are kept for names you don’t change. Renamed or removed names lose their scores.' : '',
      ]
        .filter(Boolean)
        .join('<br>');
    };
    pf.addEventListener('input', check);
    check();
    pf.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(pf.querySelector('[type=submit]'), async () => {
        A.data = await api('/api/admin/people', { method: 'POST', body: { male: lines(pf.male.value), female: lines(pf.female.value) } });
        toast('Participants saved');
        renderTab();
      });
    });

    const cf = $('#compForm');
    cf.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(cf.querySelector('[type=submit]'), async () => {
        for (const c of A.data.competitions) {
          A.data = await api('/api/admin/competition', {
            method: 'POST',
            body: { id: c.id, title: cf.elements['title-' + c.id].value, subtitle: cf.elements['subtitle-' + c.id].value },
          });
        }
        toast('Competition names saved');
        renderTab();
      });
    });
  }

  async function uploadPhoto(file) {
    if (!/^image\//.test(file.type)) throw new Error('Please choose an image file.');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('Could not read that image. Please use a JPG or PNG.'));
        i.src = url;
      });
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const size = Math.min(600, side);
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      // centre crop, nudged upwards because faces usually sit in the top half of portraits
      cv.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) * 0.3, side, side, 0, 0, size, size);
      A.data = await api('/api/admin/photo', { method: 'POST', body: { dataUrl: cv.toDataURL('image/jpeg', 0.85) } });
      toast('Photo updated');
      renderTab();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ---------------- teams tab ---------------- */
  function teamRow(t, i) {
    return `<div class="team-row" data-team-id="${esc(t.id || '')}">
  <span class="tr-no">${i + 1}</span>
  <input class="tr-name" value="${esc(t.name)}" maxlength="40" aria-label="Team name" placeholder="Team name">
  <input class="tr-pin" value="${esc(t.pin || '')}" maxlength="6" inputmode="numeric" aria-label="PIN" placeholder="auto">
  <button class="icon-btn sm" type="button" data-act="copy-invite" title="Copy invite link" aria-label="Copy invite link" ${t.id ? '' : 'disabled'}>${ICONS.copy}</button>
  <button class="icon-btn sm danger" type="button" data-act="remove-team" title="Remove team" aria-label="Remove team">${ICONS.trash}</button>
</div>`;
  }

  function teamsTab() {
    const d = A.data;
    const general = publicBase() + '/';
    return `
<div class="panel">
  <h2>Teams &amp; PINs</h2>
  <p class="muted sm">Send each team lead their <b>own</b> invite link on WhatsApp. It opens the app already logged in as that team. Keep PINs private: anyone with a team’s PIN can vote for that team.</p>
  <div class="share-row"><span class="faint">Link for everyone</span><code>${esc(general)}</code><button class="btn btn-ghost sm" type="button" data-act="copy" data-text="${esc(general)}">${ICONS.copy} Copy</button></div>
  <form id="teamsForm" novalidate>
    <div class="team-rows-head"><span>#</span><span>Team name</span><span>PIN</span><span></span><span></span></div>
    <div class="team-rows" id="teamRows">${d.teams.map(teamRow).join('')}</div>
    <div class="row-btns">
      <button class="btn btn-ghost sm" type="button" data-act="add-team">${ICONS.plus} Add team</button>
      <button class="btn btn-gold sm" type="submit">Save teams</button>
      <button class="btn btn-ghost sm" type="button" data-act="copy-all">${ICONS.copy} Copy all invites (for you only)</button>
    </div>
    <p class="form-note">Leave a PIN empty to generate one. Removing a team also deletes the votes it cast.</p>
  </form>
</div>`;
  }

  function bindTeams() {
    const form = $('#teamsForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rows = $$('.team-row', form);
      const teams = rows.map((r) => ({ id: r.dataset.teamId || undefined, name: $('.tr-name', r).value, pin: $('.tr-pin', r).value.trim() }));
      const keep = new Set(teams.map((t) => t.id).filter(Boolean));
      const lost = A.data.teams.filter((t) => !keep.has(t.id));
      const lostVotes = A.data.competitions.reduce((n, c) => n + c.voted.filter((v) => lost.some((t) => t.id === v.teamId)).length, 0);
      if (lostVotes) {
        const ok = await confirmSheet({
          title: 'Remove teams with votes?',
          body: `${esc(lost.map((t) => t.name).join(', '))} already voted. Removing ${lost.length > 1 ? 'them' : 'it'} deletes ${lostVotes} ballot${lostVotes > 1 ? 's' : ''}.`,
          cta: 'Remove and save',
        });
        if (!ok) return;
      }
      busy(form.querySelector('[type=submit]'), async () => {
        A.data = await api('/api/admin/teams', { method: 'POST', body: { teams } });
        toast('Teams saved');
        renderTab();
      });
    });
    form.addEventListener('input', (e) => {
      if (e.target.classList.contains('tr-pin')) e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });
  }

  /* ---------------- events ---------------- */
  root.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      A.tab = tab.dataset.tab;
      LS.set('dw_admin_tab', A.tab);
      renderTab();
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    const panel = el.closest('.comp-panel');
    const cid = panel && panel.dataset.id;
    const row = el.closest('.team-row');
    try {
      if (act === 'status') await setComp(cid, { status: el.dataset.v });
      else if (act === 'more') {
        if (A.expanded.has(cid)) A.expanded.delete(cid);
        else A.expanded.add(cid);
        renderTab();
      } else if (act === 'reveal') openReveal(comp(cid));
      else if (act === 'reset') {
        const c = comp(cid);
        const ok = await confirmSheet({
          title: `Reset ${c.title}?`,
          body: `This deletes all ${c.voted.length} ballot${c.voted.length === 1 ? '' : 's'} for ${esc(c.title)}. Every team will be able to vote again.`,
          cta: `Delete ${c.voted.length} ballot${c.voted.length === 1 ? '' : 's'}`,
        });
        if (ok) {
          A.data = await api('/api/admin/reset', { method: 'POST', body: { competitionId: cid } });
          renderTab();
          toast('Votes reset');
        }
      } else if (act === 'ballot') {
        const c = comp(cid);
        const t = A.data.teams.find((x) => x.id === el.dataset.team);
        const v = c.voted.find((x) => x.teamId === el.dataset.team);
        const ok = await confirmSheet({
          title: t.name,
          body: `Voted in ${esc(c.title)} on ${esc(fmtTime(v.at))}.<br>If the team made a mistake, delete their ballot so they can vote again.`,
          cta: 'Delete this ballot',
        });
        if (ok) {
          A.data = await api('/api/admin/reset', { method: 'POST', body: { competitionId: cid, teamId: t.id } });
          renderTab();
          toast(`${t.name} can vote again in ${c.title}`);
        }
      } else if (act === 'export') await busy(el, () => download(el.dataset.type));
      else if (act === 'reset-all') {
        const ok = await confirmSheet({
          title: 'Reset ALL votes?',
          body: `This permanently deletes all ${A.data.ballotCount} ballots in every competition.`,
          cta: 'Delete everything',
        });
        if (ok) {
          A.data = await api('/api/admin/reset', { method: 'POST', body: { all: true } });
          renderTab();
          toast('All votes deleted');
        }
      } else if (act === 'photo-remove') {
        A.data = await api('/api/admin/photo', { method: 'POST', body: { remove: true } });
        renderTab();
        toast('Photo removed');
      } else if (act === 'copy') await copy(el.dataset.text, 'Link copied');
      else if (act === 'copy-invite') {
        const t = A.data.teams.find((x) => x.id === row.dataset.teamId);
        if (!t) return;
        if ($('.tr-pin', row).value.trim() !== t.pin || $('.tr-name', row).value.trim() !== t.name) return toast('Save the teams first, then copy the link.', true);
        await copy(inviteText(t), `Invite for ${t.name} copied — send it to the team lead`);
      } else if (act === 'copy-all') {
        await copy(A.data.teams.map((t) => `${t.name} (PIN ${t.pin})\n${inviteUrl(t)}`).join('\n\n'), 'All invites copied');
      } else if (act === 'add-team') {
        const rows = $('#teamRows');
        const n = rows.children.length;
        rows.insertAdjacentHTML('beforeend', teamRow({ name: `Team ${n + 1}`, pin: '' }, n));
        const input = rows.lastElementChild.querySelector('.tr-name');
        input.focus();
        input.select();
      } else if (act === 'remove-team') {
        const rows = $('#teamRows');
        if (rows.children.length <= 2) return toast('You need at least 2 teams.', true);
        row.remove();
        $$('.tr-no', rows).forEach((x, i) => (x.textContent = i + 1));
        toast('Team removed. Click “Save teams” to confirm.');
      }
    } catch (ex) {
      toast(ex.message, true);
    }
  });

  root.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-act="publish"]');
    if (!el) return;
    const cid = el.closest('.comp-panel').dataset.id;
    try {
      await setComp(cid, { published: el.checked });
      toast(el.checked ? 'Winners are now visible in the app 🏆' : 'Winners hidden from the app');
    } catch (ex) {
      el.checked = !el.checked;
      toast(ex.message, true);
    }
  });

  /* ---------------- polling ---------------- */
  function startPolling() {
    clearInterval(A.poll);
    A.poll = setInterval(async () => {
      if (document.hidden || A.revealing || !A.token || !A.data) return;
      let d;
      try {
        d = await api('/api/admin/data');
      } catch (e) {
        return;
      }
      if (!A.data) return;
      const before = new Set();
      A.data.competitions.forEach((c) => c.voted.forEach((v) => before.add(c.id + '|' + v.teamId)));
      const fresh = [];
      d.competitions.forEach((c) =>
        c.voted.forEach((v) => {
          if (!before.has(c.id + '|' + v.teamId)) {
            const t = d.teams.find((x) => x.id === v.teamId);
            fresh.push(`${t ? t.name : 'A team'} voted in ${c.title}`);
          }
        })
      );
      const changed = JSON.stringify(d) !== JSON.stringify(A.data);
      A.data = d;
      if (fresh.length) {
        toast('✓ ' + fresh.join(' · '));
        Sound.chime(1046.5, 0.08);
      }
      if (changed && A.tab === 'live' && !document.querySelector('.sheet-wrap')) {
        const y = window.scrollY;
        renderTab();
        window.scrollTo(0, y);
      }
    }, 5000);
  }

  /* ---------------- winner reveal (for the projector) ---------------- */
  function openReveal(c) {
    const winners = c.results.filter((r) => r.votes > 0 && r.rank <= 3);
    if (!winners.length) return toast('No votes yet for ' + c.title, true);
    const groups = [3, 2, 1].map((rank) => ({ rank, list: winners.filter((w) => w.rank === rank) })).filter((g) => g.list.length);
    const el = $('#reveal');
    A.revealing = true;
    document.body.classList.add('revealing');
    $('#garland').innerHTML = Art.garland(window.innerWidth);
    el.hidden = false;
    el.innerHTML = `
<div class="rv-top">
  <img class="brand-mark sm" src="assets/mobilise-logo-white.svg" alt="Mobilise" width="110" height="23">
  <span class="rv-event">${esc(A.data.settings.eventTitle)}</span>
  <button class="icon-btn" type="button" data-sound-toggle></button>
  <button class="chip-btn" type="button" id="rvExit">Exit</button>
</div>
<div class="rv-stage">
  <p class="rv-kicker"><span class="pc-ic">${ICONS[c.kind]}</span>${esc(c.title)}</p>
  <h1 class="rv-title gold-text" id="rvTitle">And the winners are…</h1>
  <div class="rv-cards" id="rvCards"></div>
</div>
<div class="rv-controls"><button class="btn btn-gold btn-lg" type="button" id="rvNext"></button><span class="rv-hint">Space or → for next · Esc to exit</span></div>`;
    $$('[data-sound-toggle]', el).forEach(Sound.syncButton);
    Sound.unlock();
    FX.setLevel('calm');
    try {
      if (document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    } catch (e) {
      /* not allowed */
    }

    let step = 0;
    let working = false;
    const nextBtn = $('#rvNext');
    const title = $('#rvTitle');
    const label = () => (step < groups.length ? `Reveal ${ordinal(groups[step].rank)} place ${ICONS.next}` : 'Finish');
    nextBtn.innerHTML = label();
    setTimeout(() => nextBtn.focus(), 100);

    async function advance() {
      if (working) return;
      if (step >= groups.length) return close();
      working = true;
      nextBtn.disabled = true;
      const g = groups[step];
      if (g.rank === 1) {
        title.textContent = g.list.length > 1 ? 'And the joint winners are…' : 'And the winner is…';
        title.classList.add('suspense');
        Sound.drumroll(2.4);
        await wait(2500);
        title.classList.remove('suspense');
      } else {
        title.textContent = g.rank === 2 ? 'In second place…' : 'In third place…';
        await wait(1000);
      }
      if (!A.revealing) return;
      addCard(g);
      celebrate(g.rank);
      step++;
      if (step >= groups.length) title.textContent = 'Congratulations! 🎉';
      nextBtn.innerHTML = label();
      nextBtn.disabled = false;
      working = false;
      nextBtn.focus();
    }
    function addCard(g) {
      const card = document.createElement('div');
      card.className = `rv-card r${g.rank}`;
      card.innerHTML = `<div class="rv-medal" aria-hidden="true">${['', '🥇', '🥈', '🥉'][g.rank]}</div>
<div class="rv-rank">${g.list.length > 1 ? 'Joint ' : ''}${ordinal(g.rank)} place</div>
${g.list.map((w) => `<div class="rv-name">${esc(w.name)}</div>`).join('')}
<div class="rv-avg">${fmtAvg(g.list[0].avg)} / 10 average · ${g.list[0].votes} votes</div>`;
      $('#rvCards').appendChild(card);
    }
    function celebrate(rank) {
      const card = $('#rvCards').lastElementChild;
      const r = card.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = Math.max(80, r.top);
      if (rank === 1) {
        Sound.chime(1046.5, 0.2);
        setTimeout(() => Sound.chime(1318.5, 0.16), 170);
        FX.burst(x, y, { size: 1.6, palette: ['gold', 'white'], type: 'peony' });
        FX.finale(9, { vol: 0.7 });
        FX.setLevel('high');
        setTimeout(() => A.revealing && FX.setLevel('medium'), 7000);
      } else {
        Sound.chime(rank === 2 ? 880 : 783.99, 0.16);
        FX.burst(x, y, { size: 1.15, palette: rank === 2 ? ['white', 'cyan'] : ['marigold', 'gold'] });
        FX.setLevel('low');
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if ([' ', 'Enter', 'ArrowRight', 'PageDown'].includes(e.key)) {
        e.preventDefault();
        advance();
      }
    }
    function close() {
      if (!A.revealing) return;
      A.revealing = false;
      document.removeEventListener('keydown', onKey);
      el.hidden = true;
      el.innerHTML = '';
      $('#garland').innerHTML = '';
      document.body.classList.remove('revealing');
      FX.setLevel('off');
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      renderTab();
    }
    document.addEventListener('keydown', onKey);
    nextBtn.addEventListener('click', advance);
    $('#rvExit').addEventListener('click', close);
  }

  /* ---------------- boot ---------------- */
  FX.init();
  FX.setLevel('off');
  if (A.token) enter().catch((e) => loginView(e.message === 'Please log in again.' ? '' : e.message));
  else loginView();
})();
