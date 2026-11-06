/* fx.js — Diwali effects for the Mobilise Diwali Utsav app.
 * Night sky, fireworks, embers, synthesised sounds (no audio files) and SVG art
 * (diya, rangoli, marigold garland, icons, Mobilise logo).
 * Exposes window.DW = { FX, Sound, Art, ICONS, LS, esc }.
 */
(function () {
  'use strict';

  const mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const reduceMotion = () => mqReduce.matches;
  const small = () => Math.min(window.innerWidth, window.innerHeight) < 640;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  /* ---------------- tiny helpers shared by the app ---------------- */
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- icons ---------------- */
  const I = (body) =>
    `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  const ICONS = {
    teams: I('<rect x="3.5" y="4" width="17" height="10.5" rx="1.6"/><path d="M12 14.5V18M8.5 18h7M2 21h20"/><path d="M12 12.2c-.9 0-1.5-.6-1.5-1.4 0-.9.8-1.5 1.5-2.8.7 1.3 1.5 1.9 1.5 2.8 0 .8-.6 1.4-1.5 1.4z" fill="currentColor" stroke="none"/>'),
    male: I('<path d="M9 3.5 12 5.5l3-2 3.8 1.8 2 5-2.8 1.1-1-2V21H7V9.4l-1 2-2.8-1.1 2-5z"/><path d="M12 5.5V12"/><circle cx="12" cy="8" r=".5" fill="currentColor"/><circle cx="12" cy="10.3" r=".5" fill="currentColor"/>'),
    female: I('<path d="M9.2 3.2c.9 1.3 4.7 1.3 5.6 0l1.2 5c-1.6 1-6.4 1-8 0z"/><path d="M8.2 8.6 4 20.2c4.4 1.6 11.6 1.6 16 0l-4.2-11.6"/><path d="M5.8 17.3c4 1.3 8.4 1.3 12.4 0" stroke-dasharray="1 1.8"/><path d="M14.8 3.2c2.8 2.6 3.6 6.6 2 9.6"/>'),
    trophy: I('<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20.5h7M9.5 17h5v3.5h-5z"/>'),
    lock: I('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    check: I('<path d="m5 12.5 4.2 4.2L19 7"/>'),
    back: I('<path d="M15 5l-7 7 7 7"/>'),
    next: I('<path d="M9 5l7 7-7 7"/>'),
    down: I('<path d="M5 9l7 7 7-7"/>'),
    soundOn: I('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
    soundOff: I('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="m16 9.5 5 5m0-5-5 5"/>'),
    play: I('<path d="M8 5.5v13l10.5-6.5z"/>'),
    swap: I('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
    search: I('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>'),
    copy: I('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
    trash: I('<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    download: I('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
    eye: I('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
    sparkle: I('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>'),
  };

  /* ================================================================ */
  /* Sound — everything is synthesised with Web Audio                 */
  /* ================================================================ */
  const Sound = (() => {
    let ac = null;
    let master = null;
    let noise = null;
    let enabled = LS.get('dw_sound') !== 'off';
    let lastPop = 0;
    let lastWhoosh = 0;

    function ctx() {
      if (!enabled) return null;
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ac = new AC(); } catch (e) { return null; }
        master = ac.createGain();
        master.gain.value = 0.5;
        const comp = ac.createDynamicsCompressor();
        comp.threshold.value = -16;
        comp.ratio.value = 6;
        master.connect(comp);
        comp.connect(ac.destination);
        const len = ac.sampleRate * 2;
        noise = ac.createBuffer(1, len, ac.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      return ac;
    }
    function env(g, t, peak, attack, decay) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    }
    function noiseSrc(a, t, dur) {
      const s = a.createBufferSource();
      s.buffer = noise;
      s.start(t, Math.random() * 0.8, dur);
      return s;
    }
    /** Temple-bell style chime. */
    function chime(freq = 880, vol = 0.2, when = 0) {
      const a = ctx();
      if (!a) return;
      const t = a.currentTime + when + 0.005;
      [[1, 1, 2.2], [2, 0.42, 1.5], [2.76, 0.3, 1.1], [5.4, 0.13, 0.6], [8.93, 0.05, 0.35]].forEach(([ratio, g, dec]) => {
        const o = a.createOscillator();
        const gn = a.createGain();
        o.type = 'sine';
        o.frequency.value = freq * ratio;
        env(gn, t, vol * g, 0.006, dec);
        o.connect(gn);
        gn.connect(master);
        o.start(t);
        o.stop(t + dec + 0.1);
      });
    }
    function crackle(t0, vol) {
      const n = 8 + ((Math.random() * 10) | 0);
      for (let i = 0; i < n; i++) {
        const t = t0 + Math.random() * 0.7;
        const s = noiseSrc(ac, t, 0.03);
        const f = ac.createBiquadFilter();
        const g = ac.createGain();
        f.type = 'highpass';
        f.frequency.value = 2400 + Math.random() * 3200;
        env(g, t, (0.02 + Math.random() * 0.1) * vol, 0.001, 0.025);
        s.connect(f);
        f.connect(g);
        g.connect(master);
      }
    }
    /** Firework burst: noise blast + low thump + optional crackle. */
    function pop(size = 1, vol = 1) {
      const a = ctx();
      if (!a) return;
      if (a.currentTime - lastPop < 0.09) return;
      lastPop = a.currentTime;
      const t = a.currentTime + 0.01;
      const s = noiseSrc(a, t, 1.1);
      const f = a.createBiquadFilter();
      const g = a.createGain();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(2600, t);
      f.frequency.exponentialRampToValueAtTime(220, t + 0.8);
      env(g, t, 0.34 * size * vol, 0.004, 0.9);
      s.connect(f);
      f.connect(g);
      g.connect(master);
      const o = a.createOscillator();
      const og = a.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.3);
      env(og, t, 0.45 * size * vol, 0.004, 0.32);
      o.connect(og);
      og.connect(master);
      o.start(t);
      o.stop(t + 0.4);
      if (Math.random() < 0.55) crackle(t + 0.25, vol);
    }
    function whoosh(vol = 1) {
      const a = ctx();
      if (!a) return;
      if (a.currentTime - lastWhoosh < 0.25) return;
      lastWhoosh = a.currentTime;
      const t = a.currentTime + 0.01;
      const s = noiseSrc(a, t, 1);
      const f = a.createBiquadFilter();
      const g = a.createGain();
      f.type = 'bandpass';
      f.Q.value = 2.5;
      f.frequency.setValueAtTime(500, t);
      f.frequency.exponentialRampToValueAtTime(3200, t + 0.8);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06 * vol, t + 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      s.connect(f);
      f.connect(g);
      g.connect(master);
    }
    /** Rating tap — pitch follows the score on a pentatonic scale, so sliding sounds musical. */
    function tap(v = 5) {
      const a = ctx();
      if (!a) return;
      const steps = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
      const f = 440 * Math.pow(2, steps[Math.max(0, Math.min(9, v - 1))] / 12);
      const t = a.currentTime + 0.003;
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      env(g, t, 0.11, 0.004, 0.18);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + 0.25);
    }
    function sparkle() {
      [0, 0.07, 0.14, 0.22, 0.3].forEach((d, i) => chime(1568 + i * 196, 0.05, d));
    }
    function drumroll(dur = 2.4) {
      const a = ctx();
      if (!a) return;
      const t0 = a.currentTime + 0.02;
      const hits = Math.floor(dur * 22);
      for (let i = 0; i < hits; i++) {
        const t = t0 + i / 22 + Math.random() * 0.008;
        const s = noiseSrc(a, t, 0.08);
        const f = a.createBiquadFilter();
        const g = a.createGain();
        f.type = 'bandpass';
        f.frequency.value = 1700;
        f.Q.value = 0.8;
        env(g, t, 0.04 + 0.24 * (i / hits), 0.002, 0.07);
        s.connect(f);
        f.connect(g);
        g.connect(master);
      }
    }
    function syncButton(btn) {
      btn.setAttribute('aria-pressed', String(enabled));
      btn.setAttribute('aria-label', enabled ? 'Mute sounds' : 'Turn sounds on');
      btn.title = enabled ? 'Sound on' : 'Sound off';
      btn.innerHTML = enabled ? ICONS.soundOn : ICONS.soundOff;
    }
    function setEnabled(on) {
      enabled = !!on;
      LS.set('dw_sound', enabled ? 'on' : 'off');
      if (!enabled && ac) ac.suspend().catch(() => {});
      if (enabled) ctx();
      document.querySelectorAll('[data-sound-toggle]').forEach(syncButton);
    }
    // One delegated handler for every sound button on the page.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-sound-toggle]');
      if (btn) {
        setEnabled(!enabled);
        if (enabled) chime(880, 0.12);
      }
    });
    return {
      unlock: ctx, chime, pop, whoosh, tap, sparkle, drumroll, setEnabled, syncButton,
      get enabled() { return enabled; },
    };
  })();

  /* ================================================================ */
  /* FX — canvas night sky + fireworks                                */
  /* ================================================================ */
  const COLORS = {
    gold: ['#FFD86B', '#FFC94A', '#FFE7A3'],
    marigold: ['#FF9F1C', '#FF8A1F', '#FFB347'],
    rani: ['#FF4FA3', '#E5267D', '#FF7BC0'],
    cyan: ['#00AACC', '#66CCE0', '#B8F1FF'],
    white: ['#FFFFFF', '#FFF5E1'],
  };
  const PALETTES = [['gold', 'marigold'], ['cyan', 'white'], ['rani', 'gold'], ['marigold', 'rani'], ['gold', 'white'], ['cyan', 'gold']];

  const FX = (() => {
    let sky = null;
    let sctx = null;
    let cv = null; // fireworks layer, sits behind the page content
    let ctx = null;
    let cvTop = null; // small sparkles (e.g. when scoring), above the content
    let ctxTop = null;
    let layers = [];
    let W = 0;
    let H = 0;
    let stars = [];
    const rockets = [];
    const parts = [];
    const embers = [];
    const flashes = [];
    let level = 'calm';
    let nextAuto = 0;
    let lastT = 0;
    let lastSkyT = 0;
    let started = false;
    let dirty = false;
    // [min, max] ms between automatic rockets
    const LEVEL = { off: null, calm: null, low: [3400, 6500], medium: [1100, 2300], high: [380, 900] };
    const EMBERS = { off: 0, calm: 12, low: 16, medium: 20, high: 24 };

    function init() {
      sky = document.getElementById('sky');
      cv = document.getElementById('fx');
      cvTop = document.getElementById('fxTop');
      if (!cv) return;
      sctx = sky ? sky.getContext('2d') : null;
      ctx = cv.getContext('2d');
      ctxTop = cvTop ? cvTop.getContext('2d') : null;
      layers = [ctx, ctxTop].filter(Boolean);
      resize(true);
      let rt;
      window.addEventListener('resize', () => {
        clearTimeout(rt);
        rt = setTimeout(() => resize(false), 120);
      });
      if (!started) {
        started = true;
        requestAnimationFrame(loop);
      }
    }

    function resize(force) {
      const nw = window.innerWidth;
      const nh = window.innerHeight;
      const big = force || Math.abs(nw - W) > 2 || Math.abs(nh - H) > 140;
      W = nw;
      H = nh;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const c of [sky, cv, cvTop]) {
        if (!c) continue;
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      for (const c of [sctx, ...layers]) c && c.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (big || !stars.length) makeStars();
      drawSky(performance.now(), true);
    }

    function makeStars() {
      const n = Math.min(240, Math.round((W * H) / (small() ? 4200 : 6500)));
      stars = [];
      for (let i = 0; i < n; i++) {
        stars.push({ x: Math.random() * W, y: Math.pow(Math.random(), 1.4) * H * 0.92, r: rand(0.3, 1.25), a: rand(0.25, 0.9), s: rand(0.5, 2.2), p: rand(0, 6.28) });
      }
    }

    function drawSky(t, force) {
      if (!sctx) return;
      if (!force && t - lastSkyT < 70) return;
      lastSkyT = t;
      sctx.clearRect(0, 0, W, H);
      sctx.fillStyle = '#FFF6E0';
      const still = reduceMotion();
      for (const s of stars) {
        sctx.globalAlpha = s.a * (still ? 0.8 : 0.55 + 0.45 * Math.sin((t / 1000) * s.s + s.p));
        sctx.beginPath();
        sctx.arc(s.x, s.y, s.r, 0, 6.283);
        sctx.fill();
      }
      sctx.globalAlpha = 1;
    }

    function launch(o = {}) {
      if (!ctx) return;
      const sx = o.sx != null ? o.sx : rand(W * 0.12, W * 0.88);
      const sy = o.sy != null ? o.sy : H + 8;
      const tx = o.tx != null ? o.tx : sx + rand(-W * 0.08, W * 0.08);
      const ty = o.ty != null ? o.ty : rand(H * 0.1, H * (small() ? 0.42 : 0.38));
      rockets.push({ sx, sy, tx, ty, x: sx, y: sy, t: 0, dur: o.dur || rand(900, 1350), o });
      if (o.sound !== false) Sound.whoosh(o.vol != null ? o.vol : 0.8);
    }

    function burst(x, y, o = {}) {
      if (!ctx) return;
      const pal = o.palette || pick(PALETTES);
      const type = o.type || pick(['peony', 'peony', 'ring', 'willow', 'glitter', 'double']);
      const k = (o.size || 1) * (small() ? 0.82 : 1);
      const base = o.count || (type === 'ring' ? 56 : type === 'double' ? 72 : 90);
      const n = Math.round(base * (reduceMotion() ? 0.5 : 1) * (small() ? 0.8 : 1));
      const speed = (o.speed || (type === 'willow' ? 3.4 : 4.6)) * k;
      for (let i = 0; i < n; i++) {
        let ang;
        let sp;
        if (type === 'ring') {
          ang = (i / n) * 6.283;
          sp = speed * rand(0.93, 1);
        } else if (type === 'double') {
          ang = (i / n) * 6.283 * 2;
          sp = speed * (i % 2 ? 0.55 : 1) * rand(0.95, 1);
        } else {
          ang = rand(0, 6.283);
          sp = speed * rand(0.5, 1);
        }
        const colors = COLORS[pal[i % pal.length]];
        parts.push({
          x, y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          life: 0,
          max: (type === 'willow' ? rand(1800, 2600) : rand(1000, 1600)) * (o.long || 1),
          color: pick(colors),
          size: (type === 'glitter' ? rand(1, 1.8) : rand(1.4, 2.4)) * Math.max(0.85, k),
          drag: type === 'willow' ? 0.968 : 0.952,
          grav: type === 'willow' ? 0.028 : 0.045,
          tw: type === 'glitter' || Math.random() < 0.12,
        });
      }
      flashes.push({ x, y, r: 70 * k, life: 0, max: 260, color: COLORS[pal[0]][0] });
      if (o.sound !== false) Sound.pop(Math.min(1.3, k), o.vol != null ? o.vol : 1);
    }

    /** Small quiet sparkle, e.g. under a finger when scoring. */
    function spark(x, y, o = {}) {
      if (!ctx) return;
      const n = o.count || 14;
      const pal = o.palette || ['gold', 'marigold'];
      for (let i = 0; i < n; i++) {
        const ang = rand(0, 6.283);
        const sp = rand(1, 3.2) * (o.power || 1);
        parts.push({
          x, y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - (o.lift == null ? 0.8 : o.lift),
          life: 0,
          max: rand(380, 720),
          color: pick(COLORS[pal[i % pal.length]]),
          size: rand(1, 2.1),
          drag: 0.9,
          grav: 0.06,
          tw: false,
          top: o.top !== false,
        });
      }
    }

    function finale(n = 6, o = {}) {
      for (let i = 0; i < n; i++) {
        setTimeout(() => {
          launch({ sx: W * (0.1 + 0.8 * ((i + 0.5) / n)) + rand(-20, 20), vol: 0.75, ...o });
        }, i * rand(140, 260));
      }
    }

    function spawnEmber() {
      embers.push({
        x: rand(0, W), y: H + 6, vy: rand(0.25, 0.7), sway: rand(0.3, 1.1), ph: rand(0, 6.28),
        size: rand(0.8, 2), life: 0, max: rand(6000, 11000), color: pick(['#FFC94A', '#FF9F1C', '#FFE7A3']),
      });
    }

    function loop(t) {
      requestAnimationFrame(loop);
      if (document.hidden) {
        lastT = t;
        return;
      }
      const dt = Math.min(48, t - (lastT || t)) || 16.7;
      lastT = t;
      const f = dt / 16.667;
      drawSky(t, false);
      if (!ctx) return;

      const iv = LEVEL[level];
      if (iv && !reduceMotion()) {
        if (!nextAuto) nextAuto = t + rand(250, iv[0]);
        if (t >= nextAuto) {
          launch({ vol: level === 'high' ? 0.65 : 0.4, sound: level !== 'low' || Math.random() < 0.6 });
          if (level === 'high' && Math.random() < 0.35) setTimeout(() => launch({ vol: 0.45 }), rand(80, 260));
          nextAuto = t + rand(iv[0], iv[1]);
        }
      } else nextAuto = 0;

      const maxEmbers = reduceMotion() ? 0 : EMBERS[level] * (small() ? 0.7 : 1);
      if (embers.length < maxEmbers && Math.random() < 0.08 * f) spawnEmber();

      if (!rockets.length && !parts.length && !embers.length && !flashes.length) {
        if (dirty) {
          layers.forEach((c) => c.clearRect(0, 0, W, H));
          dirty = false;
        }
        return;
      }
      dirty = true;

      // fade the previous frame -> soft trails on a transparent canvas
      const fade = `rgba(0,0,0,${(1 - Math.pow(0.78, f)).toFixed(3)})`;
      for (const c of layers) {
        c.globalCompositeOperation = 'destination-out';
        c.fillStyle = fade;
        c.fillRect(0, 0, W, H);
        c.globalCompositeOperation = 'lighter';
      }

      for (let i = flashes.length - 1; i >= 0; i--) {
        const fl = flashes[i];
        fl.life += dt;
        if (fl.life >= fl.max) {
          flashes.splice(i, 1);
          continue;
        }
        const k = 1 - fl.life / fl.max;
        const g = ctx.createRadialGradient(fl.x, fl.y, 0, fl.x, fl.y, fl.r * (1.4 - k * 0.4));
        g.addColorStop(0, `rgba(255,240,200,${0.55 * k})`);
        g.addColorStop(1, 'rgba(255,200,120,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(fl.x, fl.y, fl.r * 1.4, 0, 6.283);
        ctx.fill();
      }

      for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        r.t += dt;
        const p = Math.min(1, r.t / r.dur);
        const e = 1 - Math.pow(1 - p, 3);
        r.x = r.sx + (r.tx - r.sx) * e;
        r.y = r.sy + (r.ty - r.sy) * e;
        parts.push({ x: r.x + rand(-1, 1), y: r.y, vx: rand(-0.3, 0.3), vy: rand(0.2, 1), life: 0, max: 420, color: '#FFD58A', size: 1.3, drag: 0.92, grav: 0.02, tw: true });
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#FFF4D6';
        ctx.beginPath();
        ctx.arc(r.x, r.y, 2.2, 0, 6.283);
        ctx.fill();
        if (p >= 1) {
          rockets.splice(i, 1);
          burst(r.tx, r.ty, r.o);
          if (typeof r.o.onBurst === 'function') r.o.onBurst(r.tx, r.ty);
        }
      }

      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life += dt;
        if (p.life >= p.max) {
          parts[i] = parts[parts.length - 1];
          parts.pop();
          continue;
        }
        const dr = Math.pow(p.drag, f);
        p.vx *= dr;
        p.vy = p.vy * dr + p.grav * f;
        p.x += p.vx * f;
        p.y += p.vy * f;
        const k = 1 - p.life / p.max;
        let a = Math.min(1, k * 1.6);
        if (p.tw) a *= 0.35 + 0.65 * Math.abs(Math.sin(p.life * 0.045 + i));
        const c = p.top && ctxTop ? ctxTop : ctx;
        c.globalAlpha = a;
        c.fillStyle = p.color;
        c.beginPath();
        c.arc(p.x, p.y, p.size * (0.55 + 0.45 * k), 0, 6.283);
        c.fill();
      }

      for (let i = embers.length - 1; i >= 0; i--) {
        const e = embers[i];
        e.life += dt;
        e.y -= e.vy * f;
        e.x += Math.sin(e.life / 900 + e.ph) * e.sway * 0.3 * f;
        if (e.life >= e.max || e.y < -10) {
          embers.splice(i, 1);
          continue;
        }
        const k = Math.min(1, e.life / 800) * (1 - e.life / e.max);
        ctx.globalAlpha = 0.18 * k;
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.size * 3, 0, 6.283);
        ctx.fill();
        ctx.globalAlpha = 0.85 * k;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.size, 0, 6.283);
        ctx.fill();
      }
      for (const c of layers) {
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
      }
    }

    return {
      init, launch, burst, spark, finale,
      setLevel(l) {
        if (LEVEL[l] === undefined) return;
        if (l !== level) nextAuto = 0;
        level = l;
      },
      get level() { return level; },
    };
  })();

  /* ================================================================ */
  /* Art — SVG builders                                                */
  /* ================================================================ */
  let uid = 0;
  const f2 = (n) => n.toFixed(2);

  const Art = {
    /** A clay diya. `lit` controls the flame; the flame flickers via CSS. */
    diya({ lit = true, cls = '' } = {}) {
      const id = 'dy' + ++uid;
      const delay = (Math.random() * 1.2).toFixed(2); // desyncs the flicker of neighbouring diyas
      return `<svg class="diya ${lit ? 'is-lit' : ''} ${cls}" viewBox="0 0 120 120" aria-hidden="true" focusable="false" style="--fd:${delay}s">
  <defs>
    <radialGradient id="${id}g"><stop offset="0" stop-color="#FFD86B" stop-opacity=".9"/><stop offset=".4" stop-color="#FF9F1C" stop-opacity=".32"/><stop offset="1" stop-color="#FF9F1C" stop-opacity="0"/></radialGradient>
    <linearGradient id="${id}f" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#FF5E1A"/><stop offset=".45" stop-color="#FFB23F"/><stop offset="1" stop-color="#FFF3C4"/></linearGradient>
    <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F07A2E"/><stop offset=".55" stop-color="#B8441A"/><stop offset="1" stop-color="#6E240B"/></linearGradient>
    <linearGradient id="${id}r" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#E9A93A"/><stop offset=".5" stop-color="#FFF0B8"/><stop offset="1" stop-color="#E9A93A"/></linearGradient>
  </defs>
  <circle class="diya-glow" cx="60" cy="50" r="50" fill="url(#${id}g)"/>
  <ellipse cx="60" cy="68" rx="44" ry="8.5" fill="#4A1B08"/>
  <ellipse cx="60" cy="68.5" rx="35" ry="5" fill="#8A3A12" opacity=".7"/>
  <path d="M60 67V60" stroke="#2E1408" stroke-width="2.6" stroke-linecap="round"/>
  <g class="diya-flame">
    <path d="M60 14C66 28 76 38 74 50 72.5 59 66 64 60 64 54 64 47.5 59 46 50 44 38 54 28 60 14Z" fill="url(#${id}f)"/>
    <path d="M60 34C63 41 67 46 66 52 65 57 62.5 60 60 60 57.5 60 55 57 54 52 53 46 57 41 60 34Z" fill="#FFF8E1"/>
  </g>
  <path d="M16 68C20 91 38 103 60 103 82 103 100 91 104 68 97 74 80 77 60 77 40 77 23 74 16 68Z" fill="url(#${id}b)"/>
  <path d="M16 68C23 74 40 77 60 77 80 77 97 74 104 68" fill="none" stroke="url(#${id}r)" stroke-width="2.6" stroke-linecap="round"/>
  <path d="M30 87Q60 97 90 87" fill="none" stroke="#FFD86B" stroke-width="1.6" stroke-dasharray="0.1 5" stroke-linecap="round"/>
  <g fill="#FFD86B"><circle cx="40" cy="84" r="2.2"/><circle cx="60" cy="88.5" r="2.6"/><circle cx="80" cy="84" r="2.2"/></g>
  <ellipse cx="60" cy="104" rx="15" ry="3.2" fill="#3A1406" opacity=".6"/>
</svg>`;
    },

    /** Layered rangoli mandala; rings draw themselves when `.draw` is added. */
    rangoli() {
      const petal = (r1, r2, w) => {
        const a = r1 + (r2 - r1) * 0.28;
        const b = r1 + (r2 - r1) * 0.72;
        return `M0 ${-r1}C${w} ${-a} ${w} ${-b} 0 ${-r2}C${-w} ${-b} ${-w} ${-a} 0 ${-r1}Z`;
      };
      const ring = (n, d, attrs, rot = 0) =>
        Array.from({ length: n }, (_, i) => `<path d="${d}" transform="rotate(${f2((360 / n) * i + rot)})" pathLength="1" ${attrs}/>`).join('');
      const dots = (n, r, size, fill, rot = 0) =>
        Array.from({ length: n }, (_, i) => {
          const a = (((360 / n) * i + rot) * Math.PI) / 180;
          return `<circle cx="${f2(Math.sin(a) * r)}" cy="${f2(-Math.cos(a) * r)}" r="${size}" fill="${fill}"/>`;
        }).join('');
      return `<svg class="rangoli" viewBox="-100 -100 200 200" aria-hidden="true" focusable="false">
  <g class="rg rg1" style="--fo:.08">${ring(12, petal(70, 96, 13), 'fill="#FFC94A" stroke="#FFC94A" stroke-width="1.2"')}</g>
  <g class="rg rg2">${dots(12, 98.5, 1.7, '#FF8A1F')}${dots(24, 67.5, 1.15, '#FFF5E1', 7.5)}</g>
  <g class="rg rg3" style="--fo:.2">${ring(16, petal(45, 65, 6.5), 'fill="#00AACC" stroke="#33C3E0" stroke-width="1"', 11.25)}</g>
  <g class="rg rg4"><circle r="42.5" fill="none" stroke="#FFC94A" stroke-width="1.6" stroke-dasharray="0.01 4.45" stroke-linecap="round"/></g>
  <g class="rg rg5" style="--fo:.9">${ring(8, petal(14, 40, 10), 'fill="#E5267D" stroke="#FFD86B" stroke-width="1"')}</g>
  <g class="rg rg6" style="--fo:1">${ring(8, petal(16, 32, 6), 'fill="#FF8A1F" stroke="#FFE7A3" stroke-width=".8"', 22.5)}</g>
  <g class="rg rg7" style="--fo:1"><circle r="11.5" fill="#FFC94A"/><circle r="7" fill="#E5267D"/><circle r="3" fill="#FFF5E1"/>${dots(8, 15, 1.3, '#FFF5E1', 22.5)}</g>
</svg>`;
    },

    /** Hanging marigold toran sized to the viewport width (longer strands at the edges). */
    garland(width) {
      const w = Math.max(320, Math.round(width));
      const spacing = w < 500 ? 30 : w < 900 ? 36 : 44;
      const n = Math.max(8, Math.floor(w / spacing));
      const gap = w / n;
      const ball = w < 500 ? 5.2 : 6.2;
      const step = ball * 1.8;
      const maxBalls = w < 500 ? 5 : 7;
      let strands = '';
      for (let i = 0; i < n; i++) {
        const x = gap * (i + 0.5);
        const u = Math.abs((i + 0.5) / n - 0.5) * 2;
        const count = Math.max(1, Math.round(1 + u * u * maxBalls));
        let balls = '';
        for (let j = 0; j < count; j++) {
          const cy = 12 + j * step;
          const orange = (i + j) % 2 === 0;
          balls += `<circle cx="${f2(x)}" cy="${f2(cy)}" r="${ball}" fill="url(#mg${orange ? 'O' : 'Y'})"/><circle cx="${f2(x)}" cy="${f2(cy)}" r="${f2(ball * 0.72)}" fill="none" stroke="rgba(120,40,0,.35)" stroke-width="1.1" stroke-dasharray="1 1.5"/>`;
        }
        const endY = 12 + (count - 1) * step + ball;
        balls += `<path d="M${f2(x - 2.6)} ${f2(endY)}h5.2l-2.6 6z" fill="#E5267D"/>`;
        strands += `<g class="strand" style="--dur:${rand(3.2, 5.4).toFixed(2)}s;--delay:-${rand(0, 4).toFixed(2)}s"><path d="M${f2(x)} 4V${f2(endY)}" stroke="#8A5A1A" stroke-width=".8"/>${balls}</g>`;
      }
      let leaves = '';
      let k = 0;
      for (let x = 6; x < w; x += 20, k++) {
        leaves += `<path d="M${x} 4q6 8 0 15q-6-7 0-15z" fill="url(#leaf)" transform="rotate(${k % 2 ? 24 : -24} ${x} 4)"/>`;
      }
      return `<svg viewBox="0 0 ${w} 140" width="${w}" height="140" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="mgO" cx="35%" cy="35%" r="70%"><stop offset="0" stop-color="#FFC266"/><stop offset=".55" stop-color="#FF8A1F"/><stop offset="1" stop-color="#B83A08"/></radialGradient>
    <radialGradient id="mgY" cx="35%" cy="35%" r="70%"><stop offset="0" stop-color="#FFF0A8"/><stop offset=".55" stop-color="#FFC94A"/><stop offset="1" stop-color="#CC7F05"/></radialGradient>
    <linearGradient id="leaf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4DB35B"/><stop offset="1" stop-color="#1C6B2D"/></linearGradient>
  </defs>
  <path d="M0 4H${w}" stroke="#8A5A1A" stroke-width="1.6"/>
  ${strands}
  ${leaves}
</svg>`;
    },

    /** Two-tone dotted halo inspired by the Mobilise mark. */
    halo(n = 36) {
      let s = '';
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const size = 2.2 + 2.8 * (0.5 + 0.5 * Math.cos(a - 0.6));
        s += `<circle class="hd" style="--i:${i}" cx="${f2(Math.sin(a) * 86)}" cy="${f2(-Math.cos(a) * 86)}" r="${f2(size)}" fill="${i < n / 2 ? '#FFC94A' : '#FF8A1F'}"/>`;
        const a2 = a + Math.PI / n;
        const size2 = 1 + 1.6 * (0.5 + 0.5 * Math.cos(a2 + 2.4));
        s += `<circle class="hd" style="--i:${i}" cx="${f2(Math.sin(a2) * 73)}" cy="${f2(-Math.cos(a2) * 73)}" r="${f2(size2)}" fill="${i < n / 2 ? '#FFE7A3' : '#00AACC'}"/>`;
      }
      return `<svg class="owner-halo" viewBox="-100 -100 200 200" aria-hidden="true" focusable="false">${s}</svg>`;
    },

    /** Full Mobilise wordmark (white + cyan for the night sky), split into animatable parts. */
    logo() {
      const L = window.MOBILISE_LOGO.logo;
      const letters = L.letters.map((d) => `<path class="lt" d="${d}" fill="#FFFFFF"/>`).join('');
      const dots = L.dots
        .map(([cx, cy, r, c]) => `<circle class="dot ${cx > 600 ? 'idot' : 'odot'}" cx="${cx}" cy="${cy}" r="${r}" fill="${c === 'c' ? '#00AACC' : '#FFFFFF'}"/>`)
        .join('');
      return `<svg class="brand-logo" viewBox="${L.viewBox}" role="img" aria-label="Mobilise">${letters}${dots}</svg>`;
    },

    /** The dotted Mobilise symbol in any two colours. */
    symbol(c1 = '#00AACC', c2 = '#FFFFFF', cls = '') {
      const S = window.MOBILISE_LOGO.symbol;
      return `<svg class="${cls}" viewBox="${S.viewBox}" aria-hidden="true" focusable="false">${S.dots
        .map(([cx, cy, r, c]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c === 'c' ? c1 : c2}"/>`)
        .join('')}</svg>`;
    },
  };

  window.DW = { FX, Sound, Art, ICONS, LS, esc, rand, reduceMotion };
})();
