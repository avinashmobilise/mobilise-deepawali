/* combo.js — small searchable picker (select2-style), shared by the voting app and the organiser console.
 *
 *   const c = DW.Combo.create(container, {
 *     items: [{ id, label, sub, disabled, hint }],   // label = name, sub = email
 *     value: id | null,
 *     placeholder: 'Search name or email…',
 *     onChange: (id, item) => {},
 *   });
 *   c.value; c.value = id; c.setItems(items); c.focus(); c.open(); c.close(); c.destroy();
 */
(function () {
  'use strict';
  const esc =
    (window.DW && window.DW.esc) ||
    ((s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  let current = null; // the picker that is open right now
  const closeOnOutside = (e) => {
    if (current && !current.root.contains(e.target)) current.close();
  };
  document.addEventListener('mousedown', closeOnOutside);
  document.addEventListener('touchstart', closeOnOutside, { passive: true });

  function create(container, opts = {}) {
    let items = Array.isArray(opts.items) ? opts.items : [];
    let value = opts.value == null ? null : opts.value;
    const placeholder = opts.placeholder || 'Search name or email…';

    const root = document.createElement('div');
    root.className = 'combo';
    root.innerHTML =
      `<button type="button" class="combo-btn" aria-haspopup="listbox" aria-expanded="false"></button>` +
      `<div class="combo-pop" hidden><input class="combo-search" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">` +
      `<ul class="combo-list" role="listbox"></ul></div>`;
    container.appendChild(root);
    const btn = root.querySelector('.combo-btn');
    const pop = root.querySelector('.combo-pop');
    const search = root.querySelector('.combo-search');
    const list = root.querySelector('.combo-list');
    let shown = [];
    let active = -1;

    const same = (a, b) => a != null && b != null && String(a) === String(b);
    const find = (id) => items.find((it) => same(it.id, id));
    const optHtml = (it) =>
      `<span class="combo-label">${esc(it.label)}</span>${it.sub ? `<span class="combo-sub">${esc(it.sub)}</span>` : ''}`;

    function paintButton() {
      const it = value != null ? find(value) : null;
      btn.innerHTML = it ? optHtml(it) : `<span class="combo-ph">${esc(placeholder)}</span>`;
      btn.classList.toggle('is-empty', !it);
    }
    function firstEnabled(from, step) {
      for (let i = from; i >= 0 && i < shown.length; i += step) if (!shown[i].disabled) return i;
      return -1;
    }
    function renderList() {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      shown = items
        .filter((it) => {
          const hay = `${it.label} ${it.sub || ''}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        })
        .slice(0, 300);
      if (active < 0 || active >= shown.length || (shown[active] && shown[active].disabled)) active = firstEnabled(0, 1);
      list.innerHTML = shown.length
        ? shown
            .map(
              (it, i) =>
                `<li role="option" data-i="${i}" aria-selected="${same(it.id, value)}" aria-disabled="${!!it.disabled}" class="combo-opt${
                  it.disabled ? ' is-disabled' : ''
                }${i === active ? ' is-active' : ''}${same(it.id, value) ? ' is-selected' : ''}">${optHtml(it)}${
                  it.hint ? `<span class="combo-hint">${esc(it.hint)}</span>` : ''
                }</li>`
            )
            .join('')
        : '<li class="combo-empty">No match in the employee list</li>';
      const a = list.querySelector('.is-active');
      if (a) a.scrollIntoView({ block: 'nearest' });
    }
    function open() {
      if (current && current !== api) current.close();
      current = api;
      pop.hidden = false;
      root.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      search.value = '';
      active = -1;
      renderList();
      setTimeout(() => search.focus({ preventScroll: true }), 0);
    }
    function close() {
      pop.hidden = true;
      root.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      if (current === api) current = null;
    }
    function choose(i) {
      const it = shown[i];
      if (!it || it.disabled) return;
      value = it.id;
      paintButton();
      close();
      btn.focus({ preventScroll: true });
      if (typeof opts.onChange === 'function') opts.onChange(it.id, it);
    }

    btn.addEventListener('click', () => (pop.hidden ? open() : close()));
    search.addEventListener('input', () => {
      active = -1;
      renderList();
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = firstEnabled(active + step, step);
        if (next !== -1) active = next;
        renderList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (active !== -1) choose(active);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
        btn.focus({ preventScroll: true });
      } else if (e.key === 'Tab') close();
    });
    list.addEventListener('click', (e) => {
      const li = e.target.closest('.combo-opt');
      if (li) choose(Number(li.dataset.i));
    });

    const api = {
      root,
      get value() {
        return value;
      },
      set value(v) {
        value = v == null || v === '' ? null : v;
        paintButton();
      },
      setItems(next) {
        items = Array.isArray(next) ? next : [];
        paintButton();
        if (!pop.hidden) renderList();
      },
      focus() {
        btn.focus({ preventScroll: true });
      },
      open,
      close,
      destroy() {
        close();
        root.remove();
      },
    };
    paintButton();
    return api;
  }

  window.DW = window.DW || {};
  window.DW.Combo = { create };
})();
