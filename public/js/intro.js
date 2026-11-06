/* intro.js — the opening sequence:
 *   0. Gate      : an unlit diya — "tap to light" (also unlocks sound on phones)
 *   1. Diwali    : शुभ दीपावली, rangoli draws itself, a row of diyas lights up, fireworks
 *   2. Mobilise  : a rocket rises from the diya and bursts into the dotted "o" of the logo
 *   3. Owner     : greeting from Ashish Sharma inside a golden dotted halo
 */
(function () {
  'use strict';
  const { FX, Sound, Art, esc, reduceMotion } = window.DW;
  const NOTES = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66]; // Sa Re Ga Pa Dha Sa' Re'
  const RING_CENTER = [422, 131]; // centre of the dotted "o" in the logo's viewBox

  function initials(name) {
    return String(name || 'M')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }

  function template(settings) {
    const o = settings.owner || {};
    const row = Array.from({ length: 7 }, () => Art.diya({ lit: false })).join('');
    return `
<button class="icon-btn intro-sound" type="button" data-sound-toggle></button>
<button class="intro-skip" type="button">Skip intro <span aria-hidden="true">›</span></button>

<section class="scene scene-diwali state-gate is-active" aria-label="Shubh Deepawali">
  <div class="scene-inner">
    <div class="sd-title">
      <p class="sd-hi" lang="hi">शुभ दीपावली</p>
      <p class="sd-en">Happy Deepawali</p>
    </div>
    <div class="sd-stage">
      ${Art.rangoli()}
      <button class="sd-diya" type="button" aria-label="Light the diya to begin">${Art.diya({ lit: false, cls: 'hero-diya' })}</button>
    </div>
    <div class="sd-msg">
      <p class="sd-gate"><span class="hi" lang="hi">दीया जलाइए</span><span class="en">Tap the diya to begin</span></p>
      <p class="sd-sub">May the festival of lights fill every home with joy, prosperity &amp; new beginnings.</p>
    </div>
    <div class="sd-row" aria-hidden="true">${row}</div>
  </div>
</section>

<section class="scene scene-brand" aria-label="Mobilise presents ${esc(settings.eventTitle)}">
  <div class="scene-inner">
    ${Art.logo()}
    <p class="brand-tag">Go Digital by Default</p>
    <div class="brand-presents"><span>presents</span><strong class="gold-text">${esc(settings.eventTitle || 'Diwali Utsav 2026')}</strong></div>
  </div>
</section>

<section class="scene scene-owner" aria-label="Diwali wishes from ${esc(o.name)}">
  <div class="scene-inner">
    <div class="owner-portrait rv" style="--d:0">
      ${Art.halo()}
      <div class="owner-photo">${
        o.photo ? `<img src="${esc(o.photo)}" alt="${esc(o.name)}">` : `<span class="owner-mono gold-text">${esc(initials(o.name))}</span>`
      }</div>
    </div>
    <p class="owner-kicker rv" style="--d:260">Diwali wishes from</p>
    <h2 class="owner-name rv" style="--d:420">${esc(o.name)}</h2>
    ${o.title ? `<p class="owner-title rv" style="--d:560">${esc(o.title)} · Mobilise</p>` : ''}
    ${o.message ? `<blockquote class="owner-msg rv" style="--d:820">${esc(o.message)}</blockquote>` : ''}
    <button class="btn btn-gold btn-lg owner-cta" type="button">Let the celebrations begin <span aria-hidden="true">✨</span></button>
  </div>
</section>`;
  }

  /** Screen position of a point given in an SVG's viewBox units. */
  function svgPoint(svg, x, y) {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return { x: r.left + ((x - vb.x) / vb.width) * r.width, y: r.top + ((y - vb.y) / vb.height) * r.height };
  }

  function flamePoint(btn) {
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.3 };
  }

  function run({ settings, onDone }) {
    const root = document.getElementById('intro');
    const timers = [];
    let finished = false;
    const at = (ms, fn) => timers.push(setTimeout(() => { if (!finished) fn(); }, ms));
    const calm = reduceMotion();

    root.innerHTML = template(settings);
    root.hidden = false;
    root.classList.remove('is-out');
    document.body.classList.add('intro-active');
    root.querySelectorAll('[data-sound-toggle]').forEach(Sound.syncButton);
    FX.setLevel('calm');

    const sd = root.querySelector('.scene-diwali');
    const sb = root.querySelector('.scene-brand');
    const so = root.querySelector('.scene-owner');
    const diyaBtn = sd.querySelector('.sd-diya');
    const heroDiya = diyaBtn.querySelector('.diya');
    const logo = sb.querySelector('.brand-logo');

    setTimeout(() => diyaBtn.focus({ preventScroll: true }), 300);
    let keyboardUser = false; // only move focus around for people using a keyboard

    function onKey(e) {
      if (e.key === 'Escape') finish();
      else if (e.key === 'Tab' || e.key === 'Enter' || e.key === ' ') keyboardUser = true;
    }
    document.addEventListener('keydown', onKey);
    root.querySelector('.intro-skip').addEventListener('click', finish);
    so.querySelector('.owner-cta').addEventListener('click', finish);
    sd.addEventListener('click', ignite, { once: true });

    /* ---------- 0 → 1 : light the diya ---------- */
    function ignite() {
      Sound.unlock();
      Sound.chime(659.25, 0.24);
      heroDiya.classList.add('is-lit');
      sd.classList.remove('state-gate');
      sd.classList.add('state-lit');
      const fp = flamePoint(diyaBtn);
      FX.spark(fp.x, fp.y, { count: 28, power: 1.5, lift: 1.4 });

      at(250, () => sd.querySelector('.rangoli').classList.add('draw'));
      sd.querySelectorAll('.sd-row .diya').forEach((d, i) =>
        at(1000 + i * 170, () => {
          d.classList.add('is-lit');
          Sound.chime(NOTES[i % NOTES.length], 0.08);
        })
      );
      if (!calm) {
        at(1300, () => FX.launch({ sx: innerWidth * 0.18, tx: innerWidth * 0.2, ty: innerHeight * 0.16, palette: ['gold', 'marigold'], type: 'peony' }));
        at(1650, () => FX.launch({ sx: innerWidth * 0.82, tx: innerWidth * 0.8, ty: innerHeight * 0.2, palette: ['rani', 'gold'], type: 'ring' }));
        at(2300, () => FX.setLevel('high'));
      } else {
        at(1300, () => FX.setLevel('low'));
      }
      at(5600, toBrand);
    }

    /* ---------- 1 → 2 : rocket into the Mobilise logo ---------- */
    function toBrand() {
      const fp = flamePoint(diyaBtn);
      sb.classList.add('is-active');
      sd.classList.add('is-leaving');
      sd.classList.remove('is-active');
      FX.setLevel('calm');
      if (calm) {
        at(500, assembleLogo);
        return;
      }
      const target = svgPoint(logo, RING_CENTER[0], RING_CENTER[1]);
      FX.launch({
        sx: fp.x, sy: fp.y, tx: target.x, ty: target.y, dur: 900,
        type: 'ring', palette: ['cyan', 'white'], size: 1.25, vol: 1,
        onBurst: () => assembleLogo(),
      });
    }

    function assembleLogo() {
      if (finished) return;
      const [ox, oy] = RING_CENTER;
      const anim = (el, frames, opts) => (el.animate ? el.animate(frames, { fill: 'both', ...opts }) : (el.style.opacity = 1));

      logo.querySelectorAll('.odot').forEach((el) => {
        const cx = +el.getAttribute('cx');
        const cy = +el.getAttribute('cy');
        const dx = ox - cx;
        const dy = oy - cy;
        if (calm) return anim(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: Math.random() * 300 });
        const delay = 30 + (Math.hypot(dx, dy) / 130) * 220 + Math.random() * 120;
        anim(
          el,
          [
            { transform: `translate(${dx}px, ${dy}px) scale(.2)`, opacity: 0 },
            { transform: `translate(${-dx * 0.16}px, ${-dy * 0.16}px) scale(1.25)`, opacity: 1, offset: 0.7 },
            { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
          ],
          { duration: 1050, delay, easing: 'cubic-bezier(.2,.8,.25,1)' }
        );
      });

      logo.querySelectorAll('.lt').forEach((el, i) => {
        const from = i === 0 ? 'translate(-140px, 0px)' : 'translate(0px, 130px)';
        anim(
          el,
          calm ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: from, opacity: 0 }, { transform: 'translate(0px, 0px)', opacity: 1 }],
          { duration: 720, delay: 650 + i * 90, easing: 'cubic-bezier(.2,.9,.3,1.12)' }
        );
      });

      logo.querySelectorAll('.idot').forEach((el, i) => {
        const delay = 1500 + i * 170;
        anim(
          el,
          calm
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                { transform: 'translate(0px, -160px) scale(0)', opacity: 0 },
                { transform: 'translate(0px, 0px) scale(1.35)', opacity: 1, offset: 0.75 },
                { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
              ],
          { duration: 650, delay, easing: 'ease-out' }
        );
        at(delay + 480, () => {
          const p = svgPoint(logo, +el.getAttribute('cx'), +el.getAttribute('cy'));
          FX.spark(p.x, p.y, { count: 16, palette: ['cyan', 'white'], power: 1.1 });
          Sound.chime(1318.5 + i * 220, 0.07);
        });
      });

      at(1900, () => sb.classList.add('show-tag'));
      at(2500, () => {
        sb.classList.add('show-presents');
        Sound.chime(783.99, 0.12);
        if (!calm) FX.setLevel('medium');
      });
      at(5600, toOwner);
    }

    /* ---------- 2 → 3 : Ashish Sharma ---------- */
    function toOwner() {
      sb.classList.add('is-leaving');
      sb.classList.remove('is-active');
      so.classList.add('is-active');
      FX.setLevel(calm ? 'calm' : 'low');
      at(120, () => so.classList.add('show'));
      at(500, () => Sound.chime(523.25, 0.14));
      at(800, () => Sound.chime(659.25, 0.1));
      at(1100, () => Sound.chime(783.99, 0.1));
      if (!calm) {
        at(900, () => FX.launch({ sx: innerWidth * 0.12, tx: innerWidth * 0.14, ty: innerHeight * 0.22, palette: ['gold', 'white'], vol: 0.5 }));
        at(1250, () => FX.launch({ sx: innerWidth * 0.88, tx: innerWidth * 0.86, ty: innerHeight * 0.18, palette: ['cyan', 'gold'], vol: 0.5 }));
      }
      at(2600, () => {
        so.classList.add('show-cta');
        if (keyboardUser) so.querySelector('.owner-cta').focus({ preventScroll: true });
      });
    }

    function finish() {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      document.removeEventListener('keydown', onKey);
      Sound.unlock();
      root.classList.add('is-out');
      document.body.classList.remove('intro-active');
      FX.setLevel('low');
      setTimeout(() => {
        root.hidden = true;
        root.innerHTML = '';
      }, 750);
      if (typeof onDone === 'function') onDone();
    }
  }

  window.DW.Intro = { run };
})();
