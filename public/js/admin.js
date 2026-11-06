/* admin.js — organiser console: live results + voters, setup (employees, email/SMTP, greeting),
 * teams, and the on-screen winner reveal. Every employee logs in with an email OTP and votes. */
(function () {
  'use strict';
  const { FX, Sound, Art, ICONS, LS, esc } = window.DW;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const root = $('#admin');
  const A = {
    token: LS.get('dw_admin'),
    data: null,
    tab: LS.get('dw_admin_tab') || 'live',
    expanded: new Set(),
    revealing: false,
    poll: null,
    voterQuery: '',
  };
  if (!['live', 'setup', 'teams'].includes(A.tab)) A.tab = 'live';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ordinal = (n) => ['', '1st', '2nd', '3rd'][n] || n + 'th';
  const fmtAvg = (n) => String(Math.round(n * 100) / 100);
  const comp = (id) => A.data.competitions.find((c) => c.id === id);
  const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }
  const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const employees = () => (A.data && A.data.employees) || [];
  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

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
    toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
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
      if (typeof wrap.onClosed === 'function') wrap.onClosed();
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
      s.el.onClosed = () => {
        if (!answered) {
          answered = true;
          resolve(false);
        }
      };
      s.el.querySelector('#cfOk').addEventListener('click', () => {
        answered = true;
        s.close();
        resolve(true);
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
  const shareMessage = () =>
    `🪔 ${A.data.settings.eventTitle}: voting is live!\n${publicBase()}/\nLog in with your office email, enter the code we email you, and score Best Desk & Best Dress. Happy Diwali! ✨`;

  /* ---------------- login / shell ---------------- */
  function loginView(msg) {
    document.body.classList.remove('signed-in');
    root.innerHTML = `
<section class="admin-login">
  <img class="brand-mark" src="assets/mobilise-logo-white.svg" alt="Mobilise" width="150" height="31">
  <div class="login-diya" aria-hidden="true">${Art.diya({ cls: 'md' })}</div>
  <h1 class="h1">Organiser console</h1>
  <p class="muted">Manage employees, email login, voting and the live winner reveal.</p>
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
  ${[['live', 'Live results'], ['setup', 'Setup'], ['teams', 'Teams']]
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
    if (!A.data.smtpConfigured)
      banners.push(
        `<div class="banner">${ICONS.lock}<span><b>Email login is not set up yet:</b> add the SMTP settings in <a href="#" data-goto="setup">Setup</a> so people can get their login codes.</span></div>`
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
    } else {
      body.innerHTML = liveTab();
      bindLive();
    }
  }

  /* ---------------- live tab ---------------- */
  function compPanel(c) {
    const d = A.data;
    const eligible = c.eligibleVoters != null ? c.eligibleVoters : d.voterCount || 0;
    const votedCount = c.votedCount || 0;
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
    <div class="ph-text"><h2>${esc(c.title)}</h2><p class="muted sm">${plural(c.entryCount, c.kind === 'teams' ? 'team' : 'participant', c.kind === 'teams' ? 'teams' : 'participants')} · <b>${votedCount}</b> of ${eligible} people voted</p></div>
    <div class="seg" role="group" aria-label="Voting status for ${esc(c.title)}">
      <button type="button" class="${c.status === 'open' ? 'on' : ''}" data-act="status" data-v="open">Open</button>
      <button type="button" class="${c.status === 'closed' ? 'on' : ''}" data-act="status" data-v="closed">Closed</button>
    </div>
  </header>
  <div class="meter" aria-hidden="true"><span style="width:${eligible ? Math.min(100, (votedCount / eligible) * 100) : 0}%"></span></div>
  <h3 class="sub-h">Live leaderboard <span class="faint">(average score)</span></h3>
  ${
    c.results.length
      ? `<table class="lb"><thead><tr><th>#</th><th>Name</th><th class="num">Avg</th><th class="num">Votes</th></tr></thead><tbody>${rows}</tbody></table>
         ${c.results.length > 5 ? `<button class="link-btn sm" type="button" data-act="more">${open ? 'Show top 5' : `Show all ${c.results.length}`}</button>` : ''}`
      : `<p class="muted sm">No ${c.kind === 'teams' ? 'teams' : 'participants'} yet. ${c.kind === 'teams' ? 'Add them in the Teams tab.' : 'Import employees in Setup.'}</p>`
  }
  <label class="switch own-team-rule" title="Applies to every voter who has a team"><input type="checkbox" data-act="own-team" ${c.noOwnTeam ? 'checked' : ''}><span class="sw" aria-hidden="true"></span>${
    c.kind === 'teams' ? 'Members can’t vote for their own team’s desk' : 'Members can’t vote for people from their own team'
  }</label>
  <footer class="panel-actions">
    <label class="switch"><input type="checkbox" data-act="publish" ${c.published ? 'checked' : ''}><span class="sw" aria-hidden="true"></span>Show winners in the app</label>
    <div class="row-btns">
      <button class="btn btn-gold sm" type="button" data-act="reveal" ${hasVotes ? '' : 'disabled'}>${ICONS.sparkle} Reveal on screen</button>
      <button class="btn btn-danger sm" type="button" data-act="reset" ${votedCount ? '' : 'disabled'}>Reset votes</button>
    </div>
  </footer>
</article>`;
  }

  function votersPanel() {
    const d = A.data;
    const emps = employees();
    const comps = d.competitions;
    const voters = emps.filter((e) => e.email);
    const allDone = voters.filter((e) => comps.every((c) => e.voted && e.voted[c.id])).length;
    const allWord = comps.length === 3 ? 'all three' : `all ${comps.length}`;
    const leaders = leaderEmails();
    const head = comps
      .map((c) => `<th class="ck-col" title="${esc(c.title)}"><span class="pc-ic sm k-${c.kind}">${ICONS[c.kind]}</span><span class="sr-only">${esc(c.title)}</span></th>`)
      .join('');
    const rows = emps
      .map((e) => {
        const cells = comps
          .map((c) => {
            if (!e.email) return `<td class="ck na" title="No email: cannot log in">·</td>`;
            const at = e.voted && e.voted[c.id];
            return at
              ? `<td class="ck"><button type="button" class="ck-btn" data-act="voter-ballot" data-voter="${esc(e.id)}" data-comp="${esc(c.id)}" title="Voted ${esc(fmtTime(at))} · click to manage" aria-label="${esc(e.name)} voted in ${esc(c.title)}">${ICONS.check}</button></td>`
              : `<td class="ck no" title="Not voted yet">–</td>`;
          })
          .join('');
        const isLeader = !!(e.email && leaders.has(String(e.email).toLowerCase()));
        const search = `${e.name} ${e.email || ''} ${e.teamName || ''}${isLeader ? ' leader' : ''}`.toLowerCase();
        const gender = e.gender === 'M' ? 'Male' : e.gender === 'F' ? 'Female' : '—';
        return `<tr data-s="${esc(search)}"><td class="vt-name">${esc(e.name)}${isLeader ? ' <span class="lead-tag" title="Team leader">leader</span>' : ''}</td><td class="vt-email">${e.email ? esc(e.email) : '<span class="faint">no email</span>'}</td><td>${esc(e.teamName || '—')}</td><td>${gender}</td>${cells}</tr>`;
      })
      .join('');
    return `
<section class="panel voters-panel">
  <div class="vp-head">
    <div><h2>Voters</h2><p class="muted sm"><b>${allDone}</b> of ${voters.length} ${voters.length === 1 ? 'person has' : 'people have'} voted in ${allWord}.</p></div>
    ${emps.length ? `<label class="search vp-search">${ICONS.search}<input type="search" id="voterSearch" placeholder="Search name, email or team" value="${esc(A.voterQuery)}" autocomplete="off" aria-label="Search voters"></label>` : ''}
  </div>
  ${
    emps.length
      ? `<div class="table-scroll"><table class="lb vt"><thead><tr><th>Name</th><th>Email</th><th>Team</th><th>Gender</th>${head}</tr></thead><tbody id="voterRows">${rows}</tbody></table></div>
         <p class="no-match" id="voterNoMatch" hidden>No one matches your search.</p>`
      : `<p class="muted sm">No employees yet. Import them in <a href="#" data-goto="setup">Setup → Employees</a>.</p>`
  }
</section>`;
  }

  function liveTab() {
    const d = A.data;
    return `
<div class="live-grid">${d.competitions.map(compPanel).join('')}</div>
${votersPanel()}
<div class="panel export-panel">
  <div><h2>Exports</h2><p class="muted sm">${d.ballotCount} ballots so far. Download a backup any time.</p></div>
  <div class="row-btns">
    <button class="btn btn-ghost sm" type="button" data-act="export" data-type="results">${ICONS.download} Results (CSV)</button>
    <button class="btn btn-ghost sm" type="button" data-act="export" data-type="ballots">${ICONS.download} Every ballot (CSV)</button>
  </div>
</div>`;
  }

  function filterVoters() {
    const q = (A.voterQuery || '').trim().toLowerCase();
    const rows = $$('#voterRows tr');
    let shown = 0;
    rows.forEach((r) => {
      const ok = !q || r.dataset.s.includes(q);
      r.hidden = !ok;
      if (ok) shown++;
    });
    const nm = $('#voterNoMatch');
    if (nm) nm.hidden = shown > 0 || !rows.length;
  }

  function bindLive() {
    const input = $('#voterSearch');
    if (!input) return;
    filterVoters();
    input.addEventListener('input', () => {
      A.voterQuery = input.value;
      filterVoters();
    });
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

  /* ---------------- employees import (paste from Excel / CSV) ---------------- */
  function detectDelimiter(line) {
    if (line.includes('\t')) return '\t';
    const semis = line.split(';').length;
    const commas = line.split(',').length;
    return semis > commas ? ';' : ',';
  }

  function splitRow(line, d) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else quoted = false;
        } else cur += ch;
      } else if (ch === '"' && cur.trim() === '') {
        quoted = true;
        cur = '';
      } else if (ch === d) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  const MALE_RE = /^(m|male|man|men|boy|gents?|mr\.?)$/i;
  const FEMALE_RE = /^(f|female|woman|women|girl|lady|ladies|mrs\.?|ms\.?|miss)$/i;
  const normGender = (g) => (MALE_RE.test(String(g || '').trim()) ? 'M' : FEMALE_RE.test(String(g || '').trim()) ? 'F' : '');

  /** Without a header row: the email column is the one full of "@", gender the one full of M/F words. */
  function guessColumns(cells) {
    const sample = cells.slice(0, 40);
    const cols = Math.max(...sample.map((r) => r.length));
    const score = (test) => Array.from({ length: cols }, (_, i) => sample.filter((r) => test(r[i] || '')).length);
    const at = score((v) => v.includes('@'));
    const gen = score((v) => MALE_RE.test(v.trim()) || FEMALE_RE.test(v.trim()));
    const best = (arr, skip) => {
      let idx = -1;
      arr.forEach((v, i) => {
        if (v > 0 && !skip.includes(i) && (idx < 0 || v > arr[idx])) idx = i;
      });
      return idx;
    };
    const email = best(at, []);
    const gender = best(gen, [email]);
    const rest = Array.from({ length: cols }, (_, i) => i).filter((i) => i !== email && i !== gender);
    return { name: rest.length ? rest[0] : -1, email, team: rest.length > 1 ? rest[1] : -1, gender };
  }

  function parseEmployees(text) {
    const res = { rows: [], problems: [], notes: [], teams: new Set(), withEmail: 0, male: 0, female: 0, header: false };
    const all = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const lines = [];
    all.forEach((l, i) => {
      if (l.trim()) lines.push({ text: l, no: i + 1 });
    });
    if (!lines.length) return res;
    const delim = detectDelimiter(lines[0].text);
    const cells = lines.map((l) => splitRow(l.text, delim));
    const h = cells[0].map((c) => c.toLowerCase());
    const isHeader = h.some((c) => /e-?mail/.test(c)) || h.some((c) => /^(full\s*)?name$|^employee(\s*name)?$/.test(c));
    let idx;
    let start = 0;
    if (isHeader) {
      const find = (test) => h.findIndex(test);
      let name = find((c) => /name/.test(c) && !/team|dept|department|group|mail|user/.test(c));
      if (name < 0) name = find((c) => /employee|person|staff/.test(c) && !/mail|id|code|no\b/.test(c));
      idx = {
        name,
        email: find((c) => /mail/.test(c)),
        team: find((c) => /team|dept|department|group/.test(c) && !/mail/.test(c)),
        gender: find((c) => /gender|sex/.test(c)),
      };
      start = 1;
      res.header = true;
    } else idx = guessColumns(cells);

    const cell = (row, i) => (i >= 0 && i < row.length ? row[i].trim() : '');
    const seenEmail = new Map();
    let noEmail = 0;
    let noGender = 0;
    const oddGender = new Set();
    for (let r = start; r < cells.length; r++) {
      const row = cells[r];
      const no = lines[r].no;
      const name = cell(row, idx.name).replace(/\s+/g, ' ');
      const email = cell(row, idx.email).toLowerCase();
      const team = cell(row, idx.team).replace(/\s+/g, ' ');
      const genderRaw = cell(row, idx.gender);
      if (!name && !email && !team && !genderRaw) continue;
      if (!name) {
        res.problems.push(`Row ${no}: the name is missing.`);
        continue;
      }
      if (email && !EMAIL_RE.test(email)) {
        res.problems.push(`Row ${no}: “${email}” is not a valid email.`);
        continue;
      }
      if (email && seenEmail.has(email)) {
        res.problems.push(`Row ${no}: ${email} is repeated (also on row ${seenEmail.get(email)}).`);
        continue;
      }
      if (email) seenEmail.set(email, no);
      const gender = normGender(genderRaw);
      if (genderRaw && !gender) oddGender.add(genderRaw);
      if (!email) noEmail++;
      else res.withEmail++;
      if (gender === 'M') res.male++;
      else if (gender === 'F') res.female++;
      else noGender++;
      if (team) res.teams.add(team.toLowerCase());
      res.rows.push({ name, email, team, gender });
    }
    if (noEmail) res.notes.push(`${plural(noEmail, 'person has', 'people have')} no email. They can be scored but cannot log in to vote.`);
    if (noGender) res.notes.push(`${plural(noGender, 'person has', 'people have')} no gender (M/F), so they won't appear in Best Dress.`);
    if (oddGender.size) res.notes.push(`Gender values not understood: ${[...oddGender].slice(0, 5).join(', ')}. Use M or F.`);
    if (res.rows.length && !res.withEmail) res.notes.push('No email column was found. Add an Email column (or a header row: Name, Email, Team, Gender).');
    return res;
  }

  function employeesToText() {
    const emps = employees();
    if (!emps.length) return '';
    const clean = (v) => String(v || '').replace(/\t/g, ' ');
    return ['Name\tEmail\tTeam\tGender', ...emps.map((e) => [e.name, e.email, e.teamName, e.gender].map(clean).join('\t'))].join('\n');
  }

  /* ---------------- setup tab ---------------- */
  function setupTab() {
    const d = A.data;
    const s = d.settings;
    const smtp = s.smtp || {};
    const emps = employees();
    const withEmail = emps.filter((e) => e.email).length;
    const male = emps.filter((e) => e.gender === 'M').length;
    const female = emps.filter((e) => e.gender === 'F').length;
    const port = smtp.port || 587;
    const ssl = !!smtp.secure;
    return `
<div class="setup-grid">
  <form class="panel span-2" id="empForm" novalidate>
    <h2>Employees <span class="faint sm">(voters and Best Dress participants)</span></h2>
    <p class="muted sm">Paste straight from Excel or Google Sheets, or from a CSV file. Use the columns <b>Name, Email, Team, Gender</b>; a header row is optional.<br>
      Everyone with an email can log in and vote. Gender (M/F) puts them in Best Dress (Male) or (Female). Team is used for Best Desk, and nobody scores their own team.</p>
    <p class="emp-current">${
      emps.length
        ? `Saved now: <b>${emps.length}</b> employees · ${withEmail} with email · ${male} male · ${female} female · ${plural(d.teams.length, 'team', 'teams')}. The box below shows this list. Edit it, or paste a new one.`
        : 'No employees saved yet.'
    }</p>
    <label class="field"><span class="field-label">List</span>
      <textarea name="emp" class="emp-textarea" rows="12" spellcheck="false" placeholder="Name&#9;Email&#9;Team&#9;Gender&#10;Rahul Verma&#9;rahul.verma@mobilise.co.in&#9;OpsSuite&#9;M&#10;Priya Sharma&#9;priya.sharma@mobilise.co.in&#9;HRevO&#9;F">${esc(employeesToText())}</textarea>
    </label>
    <div class="row-btns">
      <label class="btn btn-ghost sm file-btn">${ICONS.plus} Load a CSV file<input type="file" id="empFile" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden></label>
    </div>
    <div class="import-stats" id="empStats"></div>
    <ul class="problems" id="empProblems" hidden></ul>
    <ul class="problems notes" id="empNotes" hidden></ul>
    <label class="switch"><input type="checkbox" name="syncTeams"><span class="sw" aria-hidden="true"></span>Replace the Best Desk team list with the teams from this import</label>
    <p class="import-warning">⚠️ <b>Saving replaces the WHOLE employee list</b>, including the members that team leaders added themselves in “Manage my team”. Anyone missing from the new list is removed and loses their votes. People keep their votes as long as their email stays the same. To add a few people, edit the list in the box above (it already holds everyone saved now) instead of pasting an old file.</p>
    <button class="btn btn-gold sm" type="submit" id="empSave">Save employees</button>
  </form>

  <form class="panel span-2" id="mailApiForm" novalidate autocomplete="off">
    <h2>Email for login codes · your mail API ${A.data.emailVia === 'api' ? '<span class="badge ok">In use</span>' : ''}</h2>
    <p class="muted sm">Recommended on Render's free plan, which blocks SMTP. The app sends every login code to your own HTTPS endpoint, and that endpoint sends it with your normal mail account. Example: <code>https://alpha.mobilisepro.com/Global/Communication/diwali_utsav_mail.php</code>. When the URL and key are filled in, this is used instead of SMTP.</p>
    <div class="smtp-grid">
      <label class="field">Mail API URL<input name="url" value="${esc((A.data.settings.mailApi || {}).url || '')}" placeholder="https://…/diwali_utsav_mail.php" autocomplete="off" spellcheck="false" inputmode="url"></label>
      <label class="field">Mail API key<input name="key" type="password" value="" placeholder="${(A.data.settings.mailApi || {}).keySet ? '•••••• saved' : 'the key from the PHP file'}" autocomplete="new-password"><small>${(A.data.settings.mailApi || {}).keySet ? 'Leave empty to keep the saved key.' : ''}</small></label>
    </div>
    <div class="row-btns">
      <button class="btn btn-gold sm" type="submit">Save mail API</button>
      ${(A.data.settings.mailApi || {}).url ? '<button class="btn btn-ghost sm" type="button" id="mailApiOff">Turn off (use SMTP instead)</button>' : ''}
    </div>
    <p class="form-note">Then use “Send a test email” below to check it.</p>
  </form>

  <form class="panel span-2" id="smtpForm" novalidate autocomplete="off">
    <h2>Email for login codes · SMTP ${A.data.emailVia === 'smtp' ? '<span class="badge ok">In use</span>' : ''}</h2>
    <p class="muted sm">Everyone logs in with a 6-digit code sent to their office email. Add the details of the mailbox or email service that sends those codes.</p>
    <p class="note">Render's free plan blocks ports 25, 465 and 587. Use an email provider that offers port 2525 (Brevo, SendGrid, Mailgun, SMTP2GO), or upgrade the Render service to a paid instance.<br>
      Example for Brevo: host <code>smtp-relay.brevo.com</code> · port <code>2525</code> · STARTTLS · username = your Brevo SMTP login · password = an SMTP key. The "From email" must be a sender you verified with the provider.</p>
    <div class="smtp-grid">
      <label class="field">SMTP host<input name="host" value="${esc(smtp.host || '')}" placeholder="smtp-relay.brevo.com" autocomplete="off" spellcheck="false"></label>
      <label class="field">Port<input name="port" type="number" min="1" max="65535" value="${esc(port)}" inputmode="numeric"></label>
      <label class="field">Security<select name="security">
        <option value="starttls" ${ssl ? '' : 'selected'}>STARTTLS: port 587 or 2525</option>
        <option value="ssl" ${ssl ? 'selected' : ''}>SSL/TLS: port 465</option>
      </select></label>
      <label class="field">Username<input name="user" value="${esc(smtp.user || '')}" autocomplete="off" spellcheck="false"></label>
      <label class="field">Password<input name="pass" type="password" value="" placeholder="${smtp.passSet ? '•••••• saved' : ''}" autocomplete="new-password"><small>${smtp.passSet ? 'Leave empty to keep the saved password.' : ''}</small></label>
      <span class="smtp-spacer" aria-hidden="true"></span>
      <label class="field">From email<input name="fromEmail" type="email" value="${esc(smtp.fromEmail || '')}" placeholder="diwali@mobilise.co.in" autocomplete="off" spellcheck="false"></label>
      <label class="field">From name<input name="fromName" value="${esc(smtp.fromName || 'Mobilise Diwali Utsav')}" maxlength="60"></label>
    </div>
    <button class="btn btn-gold sm" type="submit">Save email settings</button>
    <div class="smtp-test-box">
      <label class="field-label" for="smtpTestTo">Send a test email to</label>
      <div class="smtp-test">
        <input class="inp" id="smtpTestTo" type="email" placeholder="you@mobilise.co.in" autocomplete="email">
        <button class="btn btn-ghost sm" type="button" id="smtpTestBtn">Send test email</button>
      </div>
      <p class="smtp-result" id="smtpTestResult" role="status"></p>
    </div>
  </form>

  <form class="panel" id="eventForm" novalidate>
    <h2>Event</h2>
    <label class="field">Event title<input name="eventTitle" value="${esc(s.eventTitle)}" maxlength="60"></label>
    <label class="field">Public link of this app<input name="publicUrl" value="${esc(s.publicUrl || '')}" placeholder="${esc(location.origin)}" inputmode="url">
      <small>Used for the share link. Leave empty to use ${esc(location.origin)}</small></label>
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
    <div><h2>Danger zone</h2><p class="muted sm">Delete every ballot in all three competitions. Employees, teams and settings stay as they are.</p></div>
    <button class="btn btn-danger sm" type="button" data-act="reset-all" ${d.ballotCount ? '' : 'disabled'}>Reset all votes</button>
  </div>
</div>`;
  }

  function bindSetup() {
    /* --- employees --- */
    const ef = $('#empForm');
    const ta = ef.elements.emp;
    const syncBox = ef.elements.syncTeams;
    let syncTouched = false;
    let parsed = parseEmployees(ta.value);
    syncBox.addEventListener('change', () => (syncTouched = true));
    const renderPreview = () => {
      const p = parsed;
      $('#empStats').innerHTML = p.rows.length
        ? [`<b>${p.rows.length}</b> people`, `<b>${p.withEmail}</b> with email`, `<b>${p.male}</b> male`, `<b>${p.female}</b> female`, `<b>${p.teams.size}</b> teams`]
            .map((x) => `<span class="stat">${x}</span>`)
            .join('')
        : `<span class="faint sm">Paste the list above to see a preview.</span>`;
      const probs = $('#empProblems');
      probs.hidden = !p.problems.length;
      probs.innerHTML =
        p.problems
          .slice(0, 8)
          .map((x) => `<li>${esc(x)}</li>`)
          .join('') + (p.problems.length > 8 ? `<li>…and ${p.problems.length - 8} more.</li>` : '');
      const notes = $('#empNotes');
      notes.hidden = !p.notes.length;
      notes.innerHTML = p.notes.map((x) => `<li>${esc(x)}</li>`).join('');
      if (!syncTouched) syncBox.checked = p.teams.size > 0;
      $('#empSave').disabled = !p.rows.length || p.problems.length > 0;
    };
    const refresh = () => {
      parsed = parseEmployees(ta.value);
      renderPreview();
    };
    ta.addEventListener('input', debounce(refresh, 150));
    renderPreview();
    $('#empFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        ta.value = String(reader.result || '').replace(/^﻿/, '');
        refresh();
        toast(`Loaded ${file.name}. Check the preview, then save.`);
      };
      reader.onerror = () => toast('Could not read that file.', true);
      reader.readAsText(file);
      e.target.value = '';
    });
    ef.addEventListener('submit', async (e) => {
      e.preventDefault();
      refresh();
      if (!parsed.rows.length) return toast('Paste the employee list first.', true);
      if (parsed.problems.length) return toast('Please fix the problems listed above first.', true);
      const keys = new Set(parsed.rows.map((r) => (r.email ? 'e:' + r.email : 'n:' + r.name.toLowerCase())));
      const dropped = employees().filter((x) => !keys.has(x.email ? 'e:' + x.email.toLowerCase() : 'n:' + x.name.toLowerCase()));
      const lostVoters = dropped.filter((x) => x.voted && Object.keys(x.voted).length);
      // people in a team (often added by their team leader) who are missing from the new list
      const lostMembers = dropped.filter((x) => x.teamId && !lostVoters.includes(x));
      const names = (list) => `${esc(list.slice(0, 6).map((x) => x.name).join(', '))}${list.length > 6 ? ` and ${list.length - 6} more` : ''}`;
      if (lostVoters.length) {
        const ok = await confirmSheet({
          title: 'Remove people who already voted?',
          body: `${names(lostVoters)} ${lostVoters.length === 1 ? 'is' : 'are'} not in the new list. Their votes will be deleted.${
            lostMembers.length ? `<br>${plural(lostMembers.length, 'team member', 'team members')} (${names(lostMembers)}) will also be removed.` : ''
          }`,
          cta: 'Save and delete their votes',
        });
        if (!ok) return;
      } else if (lostMembers.length) {
        const ok = await confirmSheet({
          title: `Remove ${plural(lostMembers.length, 'team member', 'team members')}?`,
          body: `${names(lostMembers)} ${lostMembers.length === 1 ? 'is' : 'are'} in a team (maybe added by their team leader) but not in the new list. Saving removes ${lostMembers.length === 1 ? 'them' : 'them all'}.`,
          cta: 'Save and remove them',
        });
        if (!ok) return;
      }
      busy($('#empSave'), async () => {
        A.data = await api('/api/admin/employees', { method: 'POST', body: { rows: parsed.rows, syncTeams: !!syncBox.checked } });
        toast(`Saved ${employees().length} employees`);
        renderTab();
      });
    });

    /* --- mail API --- */
    const af = $('#mailApiForm');
    let apiDirty = false;
    af.addEventListener('input', () => (apiDirty = true));
    const saveApi = async () => {
      const url = af.elements.url.value.trim();
      if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error('The mail API URL must start with https://');
      A.data = await api('/api/admin/mailapi', { method: 'POST', body: { url, key: af.elements.key.value } });
      apiDirty = false;
    };
    af.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(af.querySelector('[type=submit]'), async () => {
        await saveApi();
        toast(A.data.emailVia === 'api' ? 'Mail API saved: login codes will go through it' : 'Mail API saved');
        renderTab();
      });
    });
    const apiOff = $('#mailApiOff');
    if (apiOff)
      apiOff.addEventListener('click', () =>
        busy(apiOff, async () => {
          A.data = await api('/api/admin/mailapi', { method: 'POST', body: { url: '', key: '' } });
          toast('Mail API turned off');
          renderTab();
        })
      );

    /* --- SMTP --- */
    const sf = $('#smtpForm');
    let smtpDirty = false;
    // typing the test address must not count as an SMTP change (the test box lives inside this form)
    sf.addEventListener('input', (e) => {
      if (!e.target.closest('.smtp-test-box')) smtpDirty = true;
    });
    sf.elements.security.addEventListener('change', () => {
      const p = Number(sf.elements.port.value);
      if (sf.elements.security.value === 'ssl' && (p === 587 || p === 2525 || p === 25 || !p)) sf.elements.port.value = 465;
      if (sf.elements.security.value === 'starttls' && (p === 465 || !p)) sf.elements.port.value = 587;
    });
    const smtpBody = () => ({
      host: sf.elements.host.value.trim(),
      port: Number(sf.elements.port.value) || 587,
      secure: sf.elements.security.value === 'ssl',
      user: sf.elements.user.value.trim(),
      pass: sf.elements.pass.value,
      fromEmail: sf.elements.fromEmail.value.trim(),
      fromName: sf.elements.fromName.value.trim(),
    });
    const saveSmtp = async () => {
      const b = smtpBody();
      if (!b.host) throw new Error('Please enter the SMTP host.');
      if (!EMAIL_RE.test(b.fromEmail)) throw new Error('Please enter a valid "From email".');
      A.data = await api('/api/admin/smtp', { method: 'POST', body: b });
      smtpDirty = false;
    };
    sf.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(sf.querySelector('[type=submit]'), async () => {
        await saveSmtp();
        toast('Email settings saved');
        renderTab();
      });
    });
    const testBtn = $('#smtpTestBtn');
    const testTo = $('#smtpTestTo');
    const out = $('#smtpTestResult');
    testTo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        testBtn.click();
      }
    });
    testBtn.addEventListener('click', () => {
      const to = testTo.value.trim();
      if (!EMAIL_RE.test(to)) {
        out.className = 'smtp-result err';
        out.textContent = 'Enter the email address to send the test to.';
        return;
      }
      busy(testBtn, async () => {
        const savingFirst = smtpDirty || apiDirty;
        let cls;
        let text;
        out.className = 'smtp-result';
        out.textContent = savingFirst ? 'Saving the settings, then sending…' : 'Sending… (this can take up to 30 seconds)';
        try {
          if (apiDirty) await saveApi();
          if (smtpDirty) await saveSmtp();
          const r = await api('/api/admin/smtp/test', { method: 'POST', body: { to } });
          cls = 'smtp-result ok';
          text = `✓ Test email sent to ${to}${r && r.via === 'api' ? ' through the mail API' : ' over SMTP'}${r && r.message ? ` (${r.message})` : ''}. Check the inbox, and the spam folder too.`;
          toast('Test email sent');
        } catch (ex) {
          cls = 'smtp-result err';
          text = '✗ ' + ex.message;
          toast('Test email failed', true);
        }
        if (savingFirst && !smtpDirty && !apiDirty) {
          // settings were saved: re-render so the banners and the "saved" password hint update
          const y = window.scrollY;
          renderTab();
          window.scrollTo(0, y);
        }
        const o = $('#smtpTestResult');
        if (o) {
          o.className = cls;
          o.textContent = text;
        }
        const t = $('#smtpTestTo');
        if (t) t.value = to;
      });
    });

    /* --- event / owner / photo / names --- */
    $('#eventForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      busy(f.querySelector('[type=submit]'), async () => {
        A.data = await api('/api/admin/settings', { method: 'POST', body: { eventTitle: f.eventTitle.value, publicUrl: f.publicUrl.value } });
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
          body: { owner: { name: f.elements.name.value, title: f.elements.title.value, message: f.elements.message.value } },
        });
        toast('Greeting saved');
        renderTab();
      });
    });

    $('#photoInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) busy(null, () => uploadPhoto(file));
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
  const leaderEmails = () => new Set(A.data.teams.map((t) => String(t.leaderEmail || '').toLowerCase()).filter(Boolean));
  function leaderMessage(t) {
    const first = String(t.leaderName || '').trim().split(/\s+/)[0] || String(t.leaderEmail || '').split('@')[0] || 'there';
    return `Namaste ${first}! 🪔 Please add your team members for ${A.data.settings.eventTitle}: open ${publicBase()}/, log in with ${t.leaderEmail} (you'll get a code by email) and tap 'Manage my team'. Add each person's name, email and gender.`;
  }

  function teamRow(t, i) {
    const members = t.members || 0;
    const canCopy = !!(t.id && t.leaderEmail);
    return `<div class="team-row v3" data-team-id="${esc(t.id || '')}">
  <span class="tr-no">${i + 1}</span>
  <input class="tr-name" value="${esc(t.name || '')}" maxlength="40" aria-label="Team name" placeholder="Team name">
  <input class="tr-lname" value="${esc(t.leaderName || '')}" maxlength="60" aria-label="Leader name" placeholder="Leader name" autocomplete="off">
  <input class="tr-lemail" type="email" value="${esc(t.leaderEmail || '')}" maxlength="254" aria-label="Leader email" placeholder="leader@mobilise.co.in" autocomplete="off" spellcheck="false">
  <span class="tr-members" title="People in this team">${t.id ? plural(members, 'person', 'people') : 'new'}</span>
  <button class="icon-btn sm" type="button" data-act="copy-leader" title="${canCopy ? 'Copy message for leader' : 'Save a leader email first'}" aria-label="Copy message for the leader of ${esc(t.name || 'this team')}" ${canCopy ? '' : 'disabled'}>${ICONS.copy}</button>
  <button class="icon-btn sm danger" type="button" data-act="remove-team" title="Remove team" aria-label="Remove team">${ICONS.trash}</button>
</div>`;
  }

  function teamsTab() {
    const d = A.data;
    const general = publicBase() + '/';
    const canEdit = d.settings.leadersCanEdit !== false;
    const withLeader = d.teams.filter((t) => t.leaderEmail).length;
    return `
<div class="panel">
  <h2>Teams <span class="faint sm">(Best Desk entries)</span></h2>
  <p class="muted sm">Add each team's name and its <b>leader</b>. The leader logs in with their own email, taps <b>Manage my team</b> and adds the members: name, email and gender. Members can then log in and vote like everyone else.</p>
  <div class="share-row"><span class="faint">Voting link for everyone</span><code>${esc(general)}</code>
    <button class="btn btn-ghost sm" type="button" data-act="copy" data-text="${esc(general)}">${ICONS.copy} Copy link</button>
    <button class="btn btn-ghost sm" type="button" data-act="copy" data-text="${esc(shareMessage())}">${ICONS.copy} Copy WhatsApp message</button>
  </div>
  <div class="leaders-rule">
    <label class="switch"><input type="checkbox" data-act="leaders-edit" ${canEdit ? 'checked' : ''}><span class="sw" aria-hidden="true"></span>Team leaders can add and edit their members</label>
    <p class="form-note">Switch this off when voting starts to freeze the team lists.</p>
  </div>
  <form id="teamsForm" novalidate>
    <div class="team-rows-head v3"><span>#</span><span>Team name</span><span>Leader name</span><span>Leader email</span><span>Members</span><span></span><span></span></div>
    <div class="team-rows" id="teamRows">${d.teams.map(teamRow).join('')}</div>
    <div class="row-btns">
      <button class="btn btn-ghost sm" type="button" data-act="add-team">${ICONS.plus} Add team</button>
      <button class="btn btn-gold sm" type="submit">Save teams</button>
      <button class="btn btn-ghost sm" type="button" data-act="copy-leaders" ${withLeader ? '' : 'disabled'}>${ICONS.copy} Copy all leader messages</button>
    </div>
    <p class="form-note">Save the teams, then use the copy button next to each team to send its leader a WhatsApp message with the link and what to do. Renaming a team keeps its members and scores. Removing a team drops the scores it received, and its members are left without a team.</p>
  </form>
</div>`;
  }

  function bindTeams() {
    const form = $('#teamsForm');
    form.addEventListener('input', (e) => {
      if (e.target.classList.contains('is-bad')) e.target.classList.remove('is-bad');
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rows = $$('.team-row', form);
      const teams = rows.map((r) => ({
        id: r.dataset.teamId || undefined,
        name: $('.tr-name', r).value.trim(),
        leaderName: $('.tr-lname', r).value.trim(),
        leaderEmail: $('.tr-lemail', r).value.trim().toLowerCase(),
      }));
      if (teams.some((t) => !t.name)) return toast('Every team needs a name.', true);
      const leaderOf = new Map();
      for (let i = 0; i < teams.length; i++) {
        const t = teams[i];
        if (!t.leaderEmail) continue;
        const input = $('.tr-lemail', rows[i]);
        if (!EMAIL_RE.test(t.leaderEmail)) {
          input.classList.add('is-bad');
          input.focus();
          return toast(`Team ${i + 1} (${t.name}): “${t.leaderEmail}” is not a valid email.`, true);
        }
        if (leaderOf.has(t.leaderEmail)) {
          input.classList.add('is-bad');
          input.focus();
          return toast(`${t.leaderEmail} is the leader of two teams: ${leaderOf.get(t.leaderEmail)} and ${t.name}.`, true);
        }
        leaderOf.set(t.leaderEmail, t.name);
      }
      const keep = new Set(teams.map((t) => t.id).filter(Boolean));
      const lost = A.data.teams.filter((t) => !keep.has(t.id));
      const lostMembers = lost.reduce((n, t) => n + (t.members || 0), 0);
      const desk = A.data.competitions.find((c) => c.kind === 'teams');
      if (lost.length && (lostMembers || (desk && desk.votedCount))) {
        const ok = await confirmSheet({
          title: lost.length === 1 ? `Remove ${lost[0].name}?` : `Remove ${lost.length} teams?`,
          body: `${esc(lost.map((t) => t.name).join(', '))} will be removed.${lostMembers ? ` ${plural(lostMembers, 'person', 'people')} will be left without a team.` : ''} Scores already given to ${lost.length > 1 ? 'these teams' : 'this team'} are dropped.`,
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
    const goto = e.target.closest('[data-goto]');
    if (goto) {
      e.preventDefault();
      A.tab = goto.dataset.goto;
      LS.set('dw_admin_tab', A.tab);
      renderTab();
      window.scrollTo(0, 0);
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
        const n = c.votedCount || 0;
        const ok = await confirmSheet({
          title: `Reset ${c.title}?`,
          body: `This deletes all ${plural(n, 'ballot', 'ballots')} for ${esc(c.title)}. Everyone will be able to vote again.`,
          cta: `Delete ${plural(n, 'ballot', 'ballots')}`,
        });
        if (ok) {
          A.data = await api('/api/admin/reset', { method: 'POST', body: { competitionId: cid } });
          renderTab();
          toast('Votes reset');
        }
      } else if (act === 'voter-ballot') {
        const c = comp(el.dataset.comp);
        const v = employees().find((x) => x.id === el.dataset.voter);
        if (!c || !v) return;
        const at = v.voted && v.voted[c.id];
        const ok = await confirmSheet({
          title: v.name,
          body: `Voted in ${esc(c.title)}${at ? ` on ${esc(fmtTime(at))}` : ''}.<br>If they made a mistake, delete this ballot so they can vote again.`,
          cta: 'Delete this ballot',
        });
        if (ok) {
          A.data = await api('/api/admin/reset', { method: 'POST', body: { competitionId: c.id, voterId: v.id } });
          renderTab();
          toast(`${v.name} can vote again in ${c.title}`);
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
      } else if (act === 'copy') await copy(el.dataset.text, 'Copied');
      else if (act === 'copy-leader') {
        const t = A.data.teams.find((x) => x.id === (row && row.dataset.teamId));
        if (!t || !t.leaderEmail) return toast('Add the leader email and save the teams first.', true);
        const changed =
          $('.tr-name', row).value.trim() !== t.name ||
          $('.tr-lname', row).value.trim() !== (t.leaderName || '') ||
          $('.tr-lemail', row).value.trim().toLowerCase() !== String(t.leaderEmail).toLowerCase();
        if (changed) return toast('Save the teams first, then copy the message.', true);
        await copy(leaderMessage(t), `Message for ${t.leaderName || t.leaderEmail} copied: send it on WhatsApp`);
      } else if (act === 'copy-leaders') {
        const list = A.data.teams.filter((t) => t.leaderEmail);
        if (!list.length) return toast('No team has a leader yet. Add leader emails and save first.', true);
        await copy(list.map((t) => `*${t.name}*\n${leaderMessage(t)}`).join('\n\n'), `${plural(list.length, 'leader message', 'leader messages')} copied`);
      } else if (act === 'add-team') {
        const rows = $('#teamRows');
        const n = rows.children.length;
        rows.insertAdjacentHTML('beforeend', teamRow({ name: `Team ${n + 1}` }, n));
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
    const lead = e.target.closest('[data-act="leaders-edit"]');
    if (lead) {
      try {
        A.data = await api('/api/admin/settings', { method: 'POST', body: { leadersCanEdit: lead.checked } });
        toast(lead.checked ? 'Team leaders can now add and edit their members' : 'Team lists are frozen: leaders can no longer edit them');
      } catch (ex) {
        lead.checked = !lead.checked;
        toast(ex.message, true);
      }
      return;
    }
    const own = e.target.closest('[data-act="own-team"]');
    if (own) {
      const cid = own.closest('.comp-panel').dataset.id;
      try {
        await setComp(cid, { noOwnTeam: own.checked });
        toast(own.checked ? 'Own-team voting is now blocked for this competition' : 'Members can now vote for their own team here');
      } catch (ex) {
        own.checked = !own.checked;
        toast(ex.message, true);
      }
      return;
    }
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
  function voteKeys(emps) {
    const s = new Set();
    (emps || []).forEach((e) => Object.keys(e.voted || {}).forEach((cid) => s.add(e.id + '|' + cid)));
    return s;
  }

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
      const before = voteKeys(A.data.employees);
      const fresh = [];
      (d.employees || []).forEach((e) =>
        Object.keys(e.voted || {}).forEach((cid) => {
          if (!before.has(e.id + '|' + cid)) {
            const c = d.competitions.find((x) => x.id === cid);
            fresh.push(`${e.name} voted in ${c ? c.title : cid}`);
          }
        })
      );
      const changed = JSON.stringify(d) !== JSON.stringify(A.data);
      A.data = d;
      if (fresh.length) {
        toast(fresh.length > 3 ? `✓ ${fresh.length} new votes` : '✓ ' + fresh.join(' · '));
        Sound.chime(1046.5, 0.08);
      }
      const typingInSearch = document.activeElement && document.activeElement.id === 'voterSearch';
      if (changed && A.tab === 'live' && !document.querySelector('.sheet-wrap') && !typingInSearch) {
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
