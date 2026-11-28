// The panel that opens from the menu bar or tray icon: a sidebar of pages. Home (what's going on) and Memory,
// then a page per group of settings: Model, Appearance, Voice, Behavior and About.
// The sidecar owns every value: it sends the whole state when the panel opens and after each change, and the
// panel sends back the same actions the menu used ({type:'menu', id}). Opened in a plain browser it shows a
// labelled preview with sample data instead.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TAURI = window.__TAURI__?.core?.invoke;
  const invoke = TAURI ?? preview();
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const hide = () => invoke('panel_hide').catch(() => {});
  // An action from the menu's list. away: it happens on the desktop, so the panel steps aside first.
  const act = (id, away = false) => { if (away) hide(); send({ type: 'menu', id }); };

  let state = null, tab = 'home', deferred = false;
  // What's open in the panel itself: a key field (provider id, 'fish' or 'gemini'), the row action waiting for its
  // Confirm, each long list's page (pg) and how many rows fit on one (per, measured), Memory's tab and its search.
  const ui = { key: null, kind: {}, arm: null, add: { label: '', url: '', key: '', images: false }, addSent: null, pg: {}, per: {}, base: {}, rec: null, mtab: 'facts', q: '', bindShown: new Set(), sb: null };
  let armTimer = 0;
  const disarm = () => { clearTimeout(armTimer); if (ui.arm) { ui.arm = null; return true; } return false; };
  // Prompt Studio: the draft is owned by the sidecar (one file on disk); this is the panel's working copy.
  let studioCache = '', studioSaveTimer = 0, studioBusy = false, studioNeedFill = false;

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, f] of Object.entries(v)) n.addEventListener(ev, f);
      else if (k.startsWith('aria-') || k === 'role' || k.startsWith('data-')) n.setAttribute(k, String(v));
      else n[k] = v;
    }
    n.append(...kids.flat().filter((c) => c != null && c !== false));
    return n;
  };
  const btn = (label, onclick, { kind = 'ghost', k, disabled, wide, aria, title } = {}) =>
    el('button', { className: `px btn ${kind}${wide ? ' wide' : ''}`, type: 'button', textContent: label, disabled, title, 'data-k': k, 'aria-label': aria, on: { click: onclick } });
  const link = (label, onclick, { k, danger, aria, disabled } = {}) =>
    el('button', { className: `link${danger ? ' danger' : ''}`, type: 'button', textContent: label, 'data-k': k, 'aria-label': aria, disabled, on: { click: onclick } });
  // A row's action, played out: the row steps out, then the action goes. Re-rendering brings the list in line.
  // A block opening in place grows into its room and fades in; closing, the reverse. Marked with data-anim (its id).
  const shown = (n) => !n.hidden && n.getClientRects().length > 0;
  function grow(n, open) {
    if (REDUCED.matches || !shown(n)) return Promise.resolve();
    const h = n.offsetHeight, gap = parseFloat(getComputedStyle(n.parentElement).rowGap) || 0;
    n.classList.remove('appear', 'vanish'); void n.offsetWidth; n.classList.add(open ? 'appear' : 'vanish');
    const shut = { height: '0px', marginTop: `${-gap}px` }, full = { height: `${h}px`, marginTop: '0px' };
    n.style.overflow = 'hidden';
    return n.animate(open ? [shut, full] : [full, shut], { duration: open ? 200 : 160, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: open ? 'none' : 'forwards' })
      .finished.catch(() => {}).then(() => { n.style.overflow = ''; if (open) n.classList.remove('appear'); });
  }
  // Closes the open block `id` (animated), then runs then().
  const shutBlock = (id, then) => { const n = document.querySelector(`.pane [data-anim="${CSS.escape(id)}"]`); return n && shown(n) ? grow(n, false).then(then) : then(); };
  // The key field under a row: opens (closing another first), or closes if it's the one open.
  function toggleKey(id) {
    const prev = ui.key;
    if (prev === id) return closeKey();
    const open = () => { ui.key = id; render(`key-${id}`); };
    return prev ? shutBlock(`key-${prev}`, open) : open();
  }
  function closeKey() {
    const id = ui.key;
    if (!id) return;
    shutBlock(`key-${id}`, () => { if (ui.key === id) { ui.key = null; render(`addkey:${id}`); } });
  }
  const leave = (from, id) => { from.closest('.item')?.classList.add('leaving'); setTimeout(() => act(id), REDUCED.matches ? 0 : 190); };
  // Asks first in the same spot: the first press turns it into Confirm (for 4 s), the second does it.
  const armed = (label, yes, k, id, aria) => {
    const on = ui.arm === k;
    const b = el('button', { className: 'link danger arm', type: 'button', 'data-k': k, 'aria-pressed': String(on), 'aria-label': on ? `Confirm: ${aria}` : aria },
      el('span', { className: 'no', textContent: label, 'aria-hidden': 'true' }), el('span', { className: 'yes', textContent: yes, 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); b.setAttribute('aria-pressed', 'false'); return leave(b, id); }
      clearTimeout(armTimer); ui.arm = k; render(k);
      armTimer = setTimeout(() => { if (ui.arm === k) { ui.arm = null; render(); } }, 4000);
    });
    return b;
  };
  // A row's tick (done) or X (forget, drop) asks first, like Quit: pressed, it turns into Confirm in place while the
  // row's other button steps aside; pressed again it goes, left alone for 4 s it goes back.
  const PIX = {
    tick: [[0, 3], [1, 4], [2, 5], [3, 4], [4, 3], [5, 2], [6, 1]],
    x: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [6, 0], [5, 1], [4, 2], [2, 4], [1, 5], [0, 6]],
  };
  const pix = (name) => `<svg viewBox="0 0 14 14" width="14" height="14" shape-rendering="crispEdges" fill="currentColor">${PIX[name].map(([x, y]) => `<rect x="${x * 2}" y="${y * 2}" width="2" height="2"/>`).join('')}</svg>`;
  // Asking, it has no tooltip: the word on it says what it does.
  const armIcon = (b, on) => { b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? `Confirm: ${b.dataset.aria}` : b.dataset.aria); if (on) b.removeAttribute('data-tip'); else b.dataset.tip = b.dataset.name; };
  const calmIcons = () => { for (const o of document.querySelectorAll('.pane .ibtn[aria-pressed="true"]')) armIcon(o, false); };
  function iconArmed(icon, tip, k, id, aria) {
    const no = el('span', { className: 'no', 'aria-hidden': 'true' });
    no.innerHTML = pix(icon);
    const b = el('button', { className: `link ibtn${icon === 'x' ? ' danger' : ''}`, type: 'button', 'data-k': k, 'data-name': tip, 'data-aria': aria },
      no, el('span', { className: 'yes', textContent: 'Confirm', 'aria-hidden': 'true' }));
    armIcon(b, ui.arm === k);
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); return leave(b, id); }
      const text = document.querySelector('.pane .arm[aria-pressed="true"]');
      disarm(); calmIcons(); if (text) render(k);
      const me = document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`) ?? b;
      ui.arm = k; armIcon(me, true); hideTip();
      armTimer = setTimeout(() => { if (ui.arm !== k) return; ui.arm = null; const n = document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`); if (n) armIcon(n, false); }, 4000);
    });
    return b;
  }
  const group = (title, desc, n, ...kids) => el('div', { className: 'group' },
    el('div', { className: 'ghead' }, el('h2', {}, title, n != null ? el('span', { className: 'n', textContent: String(n) }) : null), desc ? el('p', { textContent: desc }) : null),
    ...kids);
  const toggle = (label, hint, on, onflip, k) => el('div', { className: 'setting' },
    el('span', { id: `lbl-${k}` }, label, hint ? el('small', { textContent: hint }) : null),
    el('button', { className: 'px switch', type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-labelledby': `lbl-${k}`, 'data-k': k, on: { click: onflip } }));
  // tips: { value: text } shown in a tooltip on hover or keyboard focus, and read out as the option's description.
  const picks = (label, list, value, pick, k, tips = null) => el('div', { className: 'picks', role: 'radiogroup', 'aria-label': label },
    list.map(([v, text]) => el('button', {
      className: 'px chord', type: 'button', role: 'radio', 'aria-checked': String(v === value), tabIndex: v === value ? 0 : -1, 'data-k': `${k}:${v}`,
      'data-tip': tips?.[v] ?? null, 'aria-describedby': tips?.[v] ? `tip-${k}-${v}` : null,
      on: { click: () => v !== value && pick(v) },
    }, el('span', { className: 'px cap', textContent: text }), tips?.[v] ? el('span', { className: 'sr-only', id: `tip-${k}-${v}`, textContent: tips[v] }) : null)));

  // ---- tooltip: one box, by whatever has a data-tip under the pointer or keyboard focus ----
  // It can be hovered (it sits right against its control), Esc closes it, and it never covers its control.
  let tipFor = null, tipTimer = 0;
  const tipBox = () => $('tip');
  function showTip(target, own = null) {
    clearTimeout(tipTimer);
    const t = tipBox(), text = own ?? target.dataset.tip;
    if (!text) return;
    if (tipFor !== target) { t.textContent = text; t.classList.remove('in'); void t.offsetWidth; t.classList.add('in'); }
    tipFor = target; t.hidden = false;
    const r = target.getBoundingClientRect(), gut = 12;
    // Fit the text, up to 300px (or the window): a one-word tip gets a small card.
    t.style.maxWidth = `${Math.min(300, innerWidth - gut * 2)}px`;
    const w = t.offsetWidth, h = t.offsetHeight, below = r.bottom + 6 + h <= innerHeight - 8;
    const x = Math.round(Math.min(Math.max(r.left, gut), innerWidth - gut - w)), y = Math.round(below ? r.bottom + 6 : r.top - 6 - h);
    t.style.left = `${x}px`; t.style.top = `${y}px`;
    // The frame can be what "fixed" is measured from (its open/close effects): correct by where it actually landed.
    const at = t.getBoundingClientRect();
    t.style.left = `${x + (x - Math.round(at.left))}px`; t.style.top = `${y + (y - Math.round(at.top))}px`;
  }
  function hideTip(soon = false) {
    clearTimeout(tipTimer);
    if (soon) { tipTimer = setTimeout(() => hideTip(), 120); return; }
    tipFor = null; const t = tipBox(); if (t) t.hidden = true;
  }
  // A description cut to one line ("…") shows in full: on hover, and when its row's control has keyboard focus.
  const clipped = (n) => (n && n.scrollWidth > n.clientWidth ? n.textContent : null);
  document.addEventListener('pointerover', (e) => {
    const d = e.target.closest?.('.setting > span small, .ghead p');
    if (d) { const full = clipped(d); if (full) d.dataset.tip = full; else delete d.dataset.tip; }
  }, true);
  document.addEventListener('pointerover', (e) => { const x = e.target.closest?.('[data-tip]'); if (x) showTip(x); else if (e.target.closest?.('#tip')) clearTimeout(tipTimer); });
  document.addEventListener('pointerout', (e) => { if (e.target.closest?.('[data-tip], #tip') && !e.relatedTarget?.closest?.('[data-tip], #tip')) hideTip(true); });
  document.addEventListener('focusin', (e) => {
    const x = e.target.closest?.('[data-tip]');
    if (x && x.matches(':focus-visible')) return showTip(x);
    const full = !x && e.target.matches?.(':focus-visible') ? clipped(e.target.closest?.('.setting')?.querySelector(':scope > span small')) : null;
    if (full) showTip(e.target, full); else hideTip();
  });
  document.addEventListener('focusout', () => hideTip(true));

  const ago = (at) => {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  // Why pick each voice model: a line under the choice, and more in its tooltip with the cost.
  const WHY = { 'drama-3': 'More emotion. Slower, and costs more.', 's2.1-pro': 'Natural pace. Less emotion, costs less.' };
  const WHY_LONG = {
    'drama-3': 'The most expressive: whispers, laughs and real excitement. It talks slower, with pauses between sentences.',
    's2.1-pro': 'A natural, quicker pace. Feelings only come through lightly.',
  };
  // A spoken reply is about 200 characters (1 to 3 short sentences), so 100 replies are about 20,000. The offer's
  // last day is shown in Pacific time, as Fish states it (it ends Dec 1, 00:00 PT).
  const price = (c) => {
    const per100 = (perM) => `$${(perM * 0.02).toFixed(2)}`;
    const promo = c.promo && Date.now() < Date.parse(c.promo.until)
      ? ` (${per100(c.promo.perM)} until ${new Date(Date.parse(c.promo.until) - 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'America/Los_Angeles' })})` : '';
    return `$${c.perM} per million characters: about ${per100(c.perM)} per 100 replies${promo}. Billed to your Fish Audio account.`;
  };
  // Gemini's two: a reply is about 12 seconds of speech, so 100 replies are about 20 minutes.
  const GEMINI_WHY = { 'gemini-3.8-flash-lite-tts': 'Quick. Costs less.', 'gemini-3.8-flash-tts': 'Studio quality. Costs more.' };
  const GEMINI_WHY_LONG = {
    'gemini-3.8-flash-lite-tts': 'The quick, cheaper one: good for everyday replies.',
    'gemini-3.8-flash-tts': "Google's best voice quality, with more feeling in it.",
  };
  const geminiPrice = (c) => `About $${(c.per10s * 120).toFixed(2)} per 100 replies, billed to your Google AI Studio account (it has a free tier).`;
  // ElevenLabs bills characters too; the counts their console shows you are the truth for your account.
  const ELEVEN_WHY = { eleven_flash_v2_5: 'The fast one. Lowest latency and cost.', eleven_multilingual_v2: 'One voice, every language.' };
  const where = () => (state?.os === 'mac' ? 'your Keychain' : state?.os === 'win' ? 'Windows, encrypted for your account' : state?.os === 'linux' ? 'your keyring' : 'this computer');

  // ---------------------------------------------------------------- header
  function head() {
    const s = state.status;
    $('led').className = `led${s.state === 'ready' ? ' on' : s.state === 'busy' ? ' busy' : ''}`;
    const now = $('now');
    now.replaceChildren(el('b', { textContent: s.text }), state.model ? ` · ${state.model.name}` : s.state === 'off' ? ' · Sign in on the Model page' : '');
    now.title = now.textContent;
    $('ver').textContent = `v${state.version}`;
    react();
    // The sidebar marks a page that needs you: no account to answer with.
    mark('model', s.state === 'off' ? 'not signed in' : null);
  }
  // Quit asks first: the first press turns it into Confirm for 4 s, the second quits.
  const quitB = $('head-quit');
  let quitTimer = 0;
  const unarmQuit = () => { clearTimeout(quitTimer); quitB.setAttribute('aria-pressed', 'false'); quitB.setAttribute('aria-label', 'Quit J.A.R.V.I.S'); };
  quitB.addEventListener('click', () => {
    if (quitB.getAttribute('aria-pressed') === 'true') { unarmQuit(); act('quit'); return; }
    quitB.setAttribute('aria-pressed', 'true'); quitB.setAttribute('aria-label', 'Confirm: quit J.A.R.V.I.S');
    quitTimer = setTimeout(unarmQuit, 4000);
  });
  function mark(page, why) {
    const b = $(`nav-${page}`);
    b.classList.toggle('flag', !!why);
    let sr = b.querySelector('.sr-only');
    if (why && !sr) b.append(sr = el('span', { className: 'sr-only' }));
    if (sr) { if (why) sr.textContent = ` (${why})`; else sr.remove(); }
  }

  // ---------------------------------------------------------------- live J.A.R.V.I.S
  // The same LED renderer as on the desktop and in the setup guide, drawn small: the header one reacts to what's
  // going on. One loop draws it, only while the panel is up and the canvas is on screen.
  const LED = [[6, 12, 28], [12, 36, 74], [22, 88, 148], [56, 184, 255], [206, 246, 255]];
  const live = new Set();
  let pointer = null; // the cursor in page px, for their eyes
  addEventListener('pointermove', (e) => { pointer = [e.clientX, e.clientY]; }, { passive: true });
  document.addEventListener('mouseleave', () => { pointer = null; });
  const ACT_SECS = { hype: 2.8, upset: 3.4, wave: 3.1, remind: 3.1, motivate: 3.1 };
  const POSES = {
    think: (t) => ({ arms: 1, tl: [-0.08, 0.5 + Math.sin(t * 2) * 0.03], tr: [0.98, 0.34], mouth: Math.sin(t * 0.9) > 0.6 ? 'o' : 'flat', brow: 'raised' }),
    concerned: () => ({ arms: 0.7, tl: [-0.45, 0.95], tr: [0.45, 0.95], mouth: 'frown', brow: 'raised' }),
  };
  // J.A.R.V.I.S on a canvas of w×h CSS px: the one on screen at half scale (the app's unit, every dot half size), so
  // each size shows its own art at its real size.
  const ZOOM = 0.5, UNIT = 340;
  function liveJarvis(canvas, w, h, { y = 0.56, form = 'default' } = {}) {
    if (!window.Roamie?.ditherKit) return null;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    const z = ZOOM, unit = UNIT;
    w /= z; h /= z;
    const env = {
      w, h, dpr, t: 0, unit, transparent: true, spawn: { x: w / 2, y: h * y },
      safe: { left: 0, right: 0, top: 0, bottom: 0 }, mouse: { x: w / 2, y: h * y, inside: false, active: false }, sleepy: 0, reduced: REDUCED.matches,
    };
    let K = null, clock = 0, actUntil = 0;
    const me = {
      pose: null, form,
      kit: Roamie.ditherKit({
        id: 'panel', label: 'Panel', matrix: true, pixel: 1.3, glow: 0.55, speed: 80, pal: LED,
        // busy: no acts of its own; pose: whatever's going on, except while it's acting something out.
        plugin: (kit) => { K = kit; return { busy: () => true, pose: () => (clock < actUntil ? null : POSES[me.pose]?.(clock) ?? null) }; },
      }).create(env),
      act(name) { if (!K || REDUCED.matches) return; K.startAct(name); actUntil = clock + (ACT_SECS[name] ?? 3); },
      setForm(f) { if (f === me.form) return; me.form = f; me.kit.setForm(f); },
      appear(v = 'materialize') { me.kit.appear(REDUCED.matches ? 'crt' : v, w / 2, h * y); },
      step(dt) {
        clock += dt; env.t += dt; env.reduced = REDUCED.matches;
        // Eyes on the cursor, wherever it is in the panel; looking ahead when it's away.
        const r = canvas.getBoundingClientRect();
        if (pointer) Object.assign(env.mouse, { x: (pointer[0] - r.left) / z, y: (pointer[1] - r.top) / z, inside: true, active: true });
        else Object.assign(env.mouse, { x: w * 1.6, y: h * y, inside: true, active: true });
        me.kit.update(dt, env);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
        ctx.save(); me.kit.draw(ctx, env); ctx.restore();
      },
    };
    me.kit.setLook('jarvis'); me.kit.setForm(form); me.kit.resize(env);
    me.kit.mover.anchor = { x: w / 2, y: h * y, r: 1.5 };
    me.kit.vanish(null, true);
    live.add({ me, canvas });
    return me;
  }
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(1 / 30, (now - (lastFrame || now)) / 1000); lastFrame = now;
    if (document.hidden || $('frame').classList.contains('shut')) return;
    for (const { me, canvas } of live) if (canvas.isConnected && canvas.offsetParent) me.step(dt);
  }
  requestAnimationFrame(loop);

  // The header's J.A.R.V.I.S, reacting to what's going on. A short line beside it when something changes.
  const avatar = liveJarvis($('avatar'), 100, 74, { y: 0.55 });
  let quipTimer = 0, seen = { opened: 0 };
  function quip(text, secs = 2.6) {
    const q = $('saying'), n = $('by');
    clearTimeout(quipTimer);
    q.textContent = text; q.classList.add('on'); n.classList.add('quiet');
    quipTimer = setTimeout(() => { q.classList.remove('on'); n.classList.remove('quiet'); }, secs * 1000);
  }
  function react() {
    if (!avatar) return;
    avatar.pose = state.busy ? 'think' : state.status.state === 'off' ? 'concerned' : null;
    avatar.setForm(state.size);
  }

  // ---------------------------------------------------------------- Home
  function home() {
    const mac = state.os === 'mac';
    return [
      el('div', { className: 'group' },
        el('h2', { className: 'sr-only', textContent: 'Actions' }),
        el('div', { className: 'actions' },
          // askKeys: the type-to-ask shortcut (F7 on a PC, a pair tapped on a Mac), so it can be learnt from the button.
          btn('Ask', () => act('ask', true), { kind: 'primary', k: 'ask', disabled: state.busy,
            aria: state.askKeys ? `Ask ${state.name}, or press ${state.askKeys} anywhere` : `Ask ${state.name}`, title: state.askKeys ? `Or press ${state.askKeys} anywhere` : null }),
          btn('Show list', () => act('list', true), { k: 'list' }),
          state.snap ?? mac ? btn('Ask about an area', () => act('snap', true), { k: 'snap' }) : null,
          state.busy ? btn('Stop', () => act('stop'), { k: 'stop' }) : btn('New chat', () => act('new'), { k: 'new', disabled: !state.canNew, aria: 'Start a new conversation' }),
          mac ? null : btn(`Show ${state.name}`, () => act('show', true), { k: 'show' }))),
      recentList(),
    ].flat();
  }
  function recentList() {
    const { box, nav } = paged('recent', state.recent, (r) => el('li', { className: `item ${r.kind}` },
      el('span', { className: 'mark', 'aria-hidden': 'true' }),
      el('span', { className: 'text', textContent: r.kind === 'ask' ? `“${r.text}”` : r.text, title: r.text }),
      el('span', { className: 'meta', textContent: ago(r.at) })), { label: 'Recent' });
    return [
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' }, el('h2', { textContent: 'Recent' })), box),
      foot(state.usage ? el('p', { className: 'usage', textContent: `Today: ${state.usage.requests} request${state.usage.requests === 1 ? '' : 's'} · ${tokens(state.usage.tokens)} tokens` }) : null, nav),
    ];
  }

  // ---------------------------------------------------------------- pages of a long list
  // As many rows as fit (measured after drawing, see fit()), the rest a page away with the arrows in the footer.
  const EMPTY = 'Nothing yet…';
  // pin: the index of a row that must stay in view (an open key field), whatever page that puts it on.
  function paged(key, items, row, { label, empty = EMPTY, id, pin = -1 } = {}) {
    const per = ui.per[key] ?? 8, pages = Math.max(1, Math.ceil(items.length / per));
    if (pin >= 0) ui.pg[key] = Math.floor(pin / per);
    const pg = ui.pg[key] = Math.min(Math.max(0, ui.pg[key] ?? 0), pages - 1);
    const shown = items.slice(pg * per, pg * per + per);
    const box = el('div', { className: 'pagebox', 'data-pager': key, id },
      shown.length ? el('ul', { className: 'list', 'aria-label': label }, shown.map(row)) : el('p', { className: 'empty', textContent: empty }));
    return { box, nav: pages > 1 ? pager(key, pg, pages, label) : null };
  }
  function pager(key, pg, pages, label) {
    const go = (d) => {
      ui.pg[key] = pg + d; disarm();
      // Keep focus on an arrow that still works at the end of the list.
      const edge = pg + d === 0 || pg + d === pages - 1;
      refresh(`${key}:${edge ? (d < 0 ? 'next' : 'prev') : d < 0 ? 'prev' : 'next'}`);
    };
    return el('div', { className: 'pager', role: 'group', 'aria-label': `${label}: page ${pg + 1} of ${pages}` },
      btn('‹', () => go(-1), { kind: 'ghost mini', k: `${key}:prev`, disabled: pg === 0, aria: 'Previous page' }),
      el('span', { className: 'pnum', textContent: `${pg + 1} / ${pages}`, 'aria-hidden': 'true' }),
      btn('›', () => go(1), { kind: 'ghost mini', k: `${key}:next`, disabled: pg === pages - 1, aria: 'Next page' }));
  }
  // The page's footer: something about the whole list on the left, the arrows on the right; none when both are empty.
  const foot = (left, nav, id) => (left || nav ? el('div', { className: 'pfoot', id }, el('div', { className: 'pfoot-l' }, left), nav) : null);
  // How many rows fit in each list's box now; true when that changed (so it's drawn again). A plain row sets the
  // size; a taller one (an open key field, a note under the row) takes its extra room off the page.
  function fit() {
    let changed = false;
    for (const box of document.querySelectorAll(`#pane-${tab} .pagebox`)) {
      const rows = [...box.querySelectorAll('.list > li')];
      if (!rows.length || !box.clientHeight) continue;
      const open = (r) => r.classList.contains('open');
      const shut = rows.filter((r) => !open(r));
      const unit = Math.min(...(shut.length ? shut : rows).map((r) => r.offsetHeight));
      const over = (list) => list.reduce((n, r) => n + Math.max(0, r.offsetHeight - unit), 0);
      // Regression: a taller row on one page (Ollama's note) made that page smaller, which moved every page and showed
      // rows twice. For the same box, the size without open rows only ever shrinks, so the pages hold still.
      const k = box.dataset.pager, h = box.clientHeight, seen = ui.base[k];
      let base = Math.floor((h - over(shut)) / unit);
      if (seen?.h === h && seen.unit === unit) base = Math.min(base, seen.n);
      ui.base[k] = { h, unit, n: base };
      const per = Math.max(3, base - Math.ceil(over(rows.filter(open)) / unit));
      if (per !== ui.per[box.dataset.pager]) { ui.per[box.dataset.pager] = per; changed = true; }
    }
    return changed;
  }

  // ---------------------------------------------------------------- Memory
  // Two tabs, What I remember and Commitments, each a page at a time; Get to know me at the end of the tab row.
  function memory() {
    const on = ui.mtab;
    const tabBtn = (id, label) => el('button', {
      className: 'tab', type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(on === id), 'aria-controls': 'mem-panel', tabIndex: on === id ? 0 : -1, 'data-k': `tab-${id}`,
      on: { click: () => { if (ui.mtab !== id) { ui.mtab = id; disarm(); render(`tab-${id}`); } } },
    }, label);
    return [
      el('div', { className: 'mhead' },
        el('div', { className: 'tabs', role: 'tablist', 'aria-label': 'Memory' }, tabBtn('facts', 'What I remember'), tabBtn('prefs', 'How I work'), tabBtn('recent', 'Recent work'), tabBtn('commits', 'Commitments')),
        link('Get to know me', () => act('intro', true), { k: 'intro', disabled: state.intro })),
      ...(on === 'commits' ? commitList() : on === 'prefs' ? prefList() : on === 'recent' ? recentList() : factList()),
    ];
  }
  function prefList() {
    const p = state.preferences, { box, nav } = paged('prefs', p, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', textContent: x.text, title: x.text }),
      el('span', { className: 'row-btns icons' }, iconArmed('x', 'Forget', `forgetpref:${x.id}`, `forgetpref:${x.id}`, `Forget: ${x.text}`))),
      { label: 'How I work', empty: 'I don’t know how you like me to work yet — it builds up as we talk.', id: 'prefs-box' });
    return [el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-prefs' }, box),
      foot(p.length ? armed('Forget everything', `Forget all ${p.length}`, 'forget-prefs-all', 'forgetprefs:yes', `Forget all ${p.length} preferences`) : null, nav, 'prefs-foot')];
  }
  function recentList() {
    const s = state.summaries ?? [], { box, nav } = paged('recent', s, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', title: x.digest }, `${new Date(x.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — ${x.digest}`),
      el('span', { className: 'row-btns icons' }, iconArmed('x', 'Forget', `forgetdigest:${x.id}`, `forgetdigest:${x.id}`, 'Forget this conversation'))),
      { label: 'Recent work', empty: 'No conversations summarized yet — they get one when they end.', id: 'recent-box' });
    return [el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-recent' }, box), foot(null, nav, 'recent-foot')];
  }
  function factList() {
    const f = state.facts, q = ui.q.trim().toLowerCase();
    const hits = q ? f.filter((x) => x.text.toLowerCase().includes(q)) : f;
    const { box, nav } = paged('facts', hits, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', textContent: x.text, title: x.text }),
      el('span', { className: 'row-btns icons' }, iconArmed('x', 'Forget', `forget:${x.id}`, `forget:${x.id}`, `Forget: ${x.text}`))), { label: 'What I remember', empty: q ? `No match for "${ui.q.trim()}".` : EMPTY, id: 'facts-box' });
    // Search once there's more than a page: it looks through all of them, and the pages follow the matches.
    const search = f.length > (ui.per.facts ?? 8) || q ? el('div', { className: 'find' }, el('span', { className: 'px field' },
      el('input', { type: 'search', id: 'find-facts', value: ui.q, placeholder: `Search ${f.length} memories`, 'aria-label': 'Search what I remember', autocomplete: 'off', spellcheck: false,
        on: { input: (e) => { ui.q = e.target.value; ui.pg.facts = 0; refreshFacts(); }, keydown: (e) => { if (e.key === 'Escape' && ui.q) { e.preventDefault(); e.stopPropagation(); e.target.value = ui.q = ''; refreshFacts(); } } } }))) : null;
    return [
      el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-facts' }, search, box),
      foot(f.length ? armed('Forget everything', `Forget all ${f.length}`, 'forget-all', 'forgetall:yes', `Forget all ${f.length} things I remember`) : null, nav, 'facts-foot'),
    ];
  }
  // Searching redraws just the list and its footer, so the search field keeps its focus and caret.
  function refreshFacts() {
    const [panel, ft] = factList(), box = $('facts-box');
    if (!box) return render();
    box.replaceWith(panel.querySelector('#facts-box'));
    const old = $('facts-foot');
    if (old && ft) old.replaceWith(ft); else if (old) old.remove(); else if (ft) $('mem-panel').after(ft);
    if (fit()) refreshFacts();
  }
  function commitList() {
    const { box, nav } = paged('commits', state.commitments, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', title: x.text }, x.text, x.when ? el('small', { className: x.overdue ? 'late' : '', textContent: x.overdue ? `Overdue · ${x.when}` : x.when }) : null),
      el('span', { className: 'row-btns icons' },
        iconArmed('tick', 'Done', `done:${x.id}`, `done:${x.id}`, `Done: ${x.text}`),
        iconArmed('x', 'Drop', `drop:${x.id}`, `drop:${x.id}`, `Drop: ${x.text}`))), { label: 'Commitments' });
    const n = state.commitments.length;
    return [el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-commits' }, box), foot(n ? el('p', { className: 'usage', textContent: `${n} open` }) : null, nav)];
  }
  // A page arrow: the search field (if it has focus) is kept by redrawing only the list.
  const refresh = (focusKey) => (tab === 'memory' && ui.mtab === 'facts' && document.activeElement?.id === 'find-facts' ? refreshFacts() : render(focusKey));

  // ---------------------------------------------------------------- Settings
  // A masked key field that opens in place. id: a provider, or a voice service ('fish', 'gemini'). kinds: the kinds of key it takes
  // (Kimi and Xiaomi: a plan key or a pay-per-token key), picked above the field; onsave gets the kind's id.
  function keyForm(id, label, onsave, kinds = null) {
    const kind = kinds?.find((x) => x.id === ui.kind[id]) ?? kinds?.[0];
    const name = kind?.label ?? label;
    const input = el('input', { type: 'password', id: `key-${id}`, autocomplete: 'off', spellcheck: false, placeholder: `${name} key`, 'aria-label': `${name} API key`, maxLength: 1000 });
    const save = () => { const v = input.value.trim(); if (!v) return input.focus(); onsave(v, kind?.id); input.value = ''; closeKey(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); closeKey(); } });
    const row = el('div', { className: 'keyform', hidden: ui.key !== id, 'data-anim': `key-${id}` }, el('span', { className: 'px field' }, input), btn('Save', save, { k: `save:${id}` }));
    if (!kinds) return row;
    row.hidden = false; delete row.dataset.anim;
    return el('div', { className: 'keykinds', hidden: ui.key !== id, 'data-anim': `key-${id}` },
      picks(`${label} key type`, kinds.map((x) => [x.id, x.label]), kind.id, (v) => { ui.kind[id] = v; render(`kind-${id}:${v}`); }, `kind-${id}`,
        Object.fromEntries(kinds.map((x) => [x.id, x.billing]))),
      row);
  }

  const signIn = (p) => link('Sign in', () => act(`login:${p.id}`), { k: `login:${p.id}`, aria: `Sign in to ${p.label}`, disabled: !!state.loggingIn });
  const connect = (s) => link('Connect', () => act(`local:connect:${s.id}`), { k: `local:connect:${s.id}`, aria: `Connect ${s.label}` });
  const addKey = (p) => link(ui.key === p.id ? 'Cancel' : 'Add key', () => toggleKey(p.id), { k: `addkey:${p.id}`, aria: `Add ${p.label} API key` });

  // A connected account's key: replace it (saving under the same kind overwrites it), or add one next to a sign-in.
  const changeKey = (p) => link(ui.key === p.id ? 'Cancel' : p.keySaved ? 'Change key' : 'Add key', () => toggleKey(p.id),
    { k: `addkey:${p.id}`, aria: `${p.keySaved ? 'Change the' : 'Add a'} ${p.label} API key` });

  // Settings, one page per concern.
  const SIZE_TIPS = { default: 'My full size.', small: 'Half my size, so I take less of your screen.', cursor: 'I become a little arrow pointer, like your cursor.' };
  // ---------------------------------------------------------------- Second brain
  const SB_LOCS = [
    ['root', 'Root', 'Its rules (AGENTS.md); relative file paths start here'],
    ['raw', 'Raw evidence', 'Unedited proof: I read it, never change it', '_raw'],
    ['context', 'Context (wiki)', 'Summarised memory, words only', '_context'],
    ['research', 'Research', 'Write-ups built from the context', '_research'],
    ['projects', 'Projects', 'Each one self-contained', 'projects'],
    ['agents', 'Agents folder', 'Its skills/ folder is listed beside your skills', '.agents'],
  ];
  const SB_STATUS = { found: 'Found', missing: 'Missing', 'will create': 'Will create' };
  const sepOf = (p) => (/^[a-z]:\\/i.test(p) || (p.includes('\\') && !p.includes('/')) ? '\\' : '/');
  const joinPath = (dir, name) => (dir && name ? `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${name}` : '');
  function sbInit() {
    const b = state.secondBrain ?? {}, saved = b.saved ?? {}, using = b.using ?? {};
    const form = Object.fromEntries(SB_LOCS.map(([k]) => [k, saved[k] || using[k] || '']));
    ui.sb = { savedKey: JSON.stringify(b.saved ?? null), mode: 'existing', form, over: new Set(SB_LOCS.map(([k]) => k).filter((k) => k !== 'root' && saved[k])), parent: b.home ? joinPath(b.home, 'Desktop') : '', name: b.name || 'Second Brain', status: null, found: {}, seq: 0, fill: false };
    if (form.root) sbCheck();
  }
  function sbCheck(fill = false) {
    const sb = ui.sb;
    sb.seq += 1; if (fill) sb.fill = true;
    send({ type: 'secondbrain', op: 'check', mode: sb.mode, form: sb.form, seq: sb.seq });
  }
  function sbDefaults() {
    const sb = ui.sb, root = joinPath(sb.parent, sb.name.trim());
    sb.form.root = root;
    for (const [k, , , name] of SB_LOCS) if (k !== 'root' && !sb.over.has(k)) sb.form[k] = root ? joinPath(root, name) : '';
  }
  function sbMode(m) {
    const sb = ui.sb;
    if (sb.mode === m) return;
    sb.mode = m; sb.over.clear(); sb.status = null;
    if (m === 'create') sbDefaults(); else { const b = state.secondBrain ?? {}; for (const [k] of SB_LOCS) sb.form[k] = b.saved?.[k] || b.using?.[k] || ''; }
    render(`sbmode:${m}`);
    if (sb.form.root) sbCheck(m === 'existing');
  }
  const pickFor = (title, start) => invoke('pick_folder', { title, start: start || state.secondBrain?.using?.root || null }).catch(() => null);
  async function sbChoose(k) {
    const sb = ui.sb, label = SB_LOCS.find(([x]) => x === k)[1];
    const dir = await pickFor(k === 'root' ? 'Choose your second brain folder' : `Choose the ${label.toLowerCase()} folder`, sb.form[k] || sb.form.root);
    if (!dir) return;
    sb.form[k] = dir;
    if (k === 'root') { for (const [x] of SB_LOCS) if (x !== 'root' && !sb.over.has(x)) sb.form[x] = ''; } else sb.over.add(k);
    render(`sbpick:${k}`); sbCheck(k === 'root');
  }
  async function sbParent() {
    const dir = await pickFor('Choose where to make your second brain', ui.sb.parent);
    if (!dir) return;
    ui.sb.parent = dir; sbDefaults(); render('sbparent'); sbCheck();
  }
  function sbAuto(k) {
    const sb = ui.sb;
    sb.over.delete(k);
    if (sb.mode === 'create') sbDefaults(); else sb.form[k] = sb.found?.[k] || '';
    render(`sbpick:${k}`); sbCheck();
  }
  let sbTimer = 0;
  function onBrain(m) {
    const sb = ui.sb;
    if (!sb) return;
    if (m.op === 'created') { ui.sb = null; return; }
    if (m.op !== 'check' || m.seq !== sb.seq) return;
    sb.status = m.status; sb.found = m.found ?? {};
    if (sb.fill && sb.mode === 'existing') {
      sb.fill = false;
      for (const [k] of SB_LOCS) if (k !== 'root' && !sb.over.has(k)) sb.form[k] = sb.found[k] || '';
      return sbCheck();
    }
    if (tab === 'secondbrain') render();
  }
  function sbRow(k, label, hint) {
    const sb = ui.sb, st = sb.status?.[k], p = sb.form[k];
    const create = sb.mode === 'create', over = sb.over.has(k);
    const line = !p ? (k === 'root' ? (create ? 'Choose a parent folder and a name' : 'Choose a folder') : create ? 'Not made' : 'None found in the root. I look again at each new chat.')
      : st ? (st.status === 'bad' ? st.why : `${SB_STATUS[st.status] ?? ''}${over ? ' · chosen by hand' : ''}`) : 'Checking…';
    const bad = st && p && (st.status === 'bad' || st.status === 'missing');
    return el('div', { className: 'setting' },
      el('span', { id: `lbl-sb-${k}` }, label, el('small', { title: p || hint, textContent: p || hint }),
        el('small', { className: `wrap${bad ? ' late' : st?.status === 'found' || st?.status === 'will create' ? ' ok' : ''}`, textContent: line }),
        st?.warn && p ? el('small', { className: 'wrap late', textContent: st.warn }) : null),
      el('span', { className: 'links' },
        over ? link(create ? 'Default' : 'Auto', () => sbAuto(k), { k: `sbauto:${k}`, aria: `${label}: back to ${create ? 'the default name' : 'what is found in the root'}` }) : null,
        create && k === 'root' ? null : link('Choose folder…', () => sbChoose(k), { k: `sbpick:${k}`, aria: `Choose the ${label} folder` })));
  }
  function secondBrainPage() {
    if (!ui.sb || ui.sb.savedKey !== JSON.stringify(state.secondBrain?.saved ?? null)) sbInit();
    const sb = ui.sb, b = state.secondBrain ?? {}, create = sb.mode === 'create';
    const nameField = el('span', { className: 'px field' }, el('input', {
      id: 'sb-name', value: sb.name, placeholder: 'Second brain', 'aria-label': 'Name of the new second brain folder', type: 'text', autocomplete: 'off', spellcheck: false, maxLength: 80,
      on: { input: (e) => { sb.name = e.target.value.replace(/[\\/:]/g, ''); sbDefaults(); clearTimeout(sbTimer); sbTimer = setTimeout(() => sbCheck(), 250); } } }));
    const save = () => send({ type: 'secondbrain', op: create ? 'create' : 'save', form: sb.form });
    return [
      group('Second brain', 'A folder of your notes I work from: its rules, files and skills.', null,
        el('div', { className: 'setting' },
          el('span', {}, 'In use', el('small', { title: using || '', textContent: using || (b.missing ? `Can't find ${b.saved?.root}` : 'None yet') }),
            b.found?.length ? el('small', { className: 'wrap', textContent: `Found: ${b.found.join(', ')}` }) : null),
          b.saved ? link('Clear', () => act('secondbrainclear'), { k: 'secondbrainclear', aria: 'Stop using the second brain folder' }) : null),
        picks('How to start', [['existing', 'Use an existing folder'], ['create', 'Create a new one']], sb.mode, sbMode, 'sbmode',
          { existing: 'Choose its folder; I find the rest by name.', create: 'Pick where and a name; I make the folders and starter files.' })),
      create ? group('New one', 'Made with AGENTS.md and the index files. Nothing there already is written over.', null,
        el('div', { className: 'setting' },
          el('span', {}, 'Parent folder', el('small', { title: sb.parent, textContent: sb.parent || 'Where to make it' })),
          link('Choose folder…', sbParent, { k: 'sbparent', aria: 'Choose the folder to make the second brain in' })),
        el('div', { className: 'keyform' }, nameField)) : null,
      group('Locations', 'Outside the root is fine while it is in your home folder.', null, SB_LOCS.map(([k, label, hint]) => sbRow(k, label, hint))),
      foot(el('span', { className: 'links' },
        btn(create ? 'Create' : 'Save', save, { k: 'sbsave', kind: 'primary', disabled: !sb.form.root || SB_LOCS.some(([k]) => sb.status?.[k]?.status === 'bad') })), null),
    ];
  }
  function skillsPage() { return [group('Skills', 'Learned how-tos the chat follows.', null, el('p', { className: 'empty', textContent: 'Skills are saved in the sidecar; manage them from the chat.' })]; }
  function mcpPage() { return [group('MCP', 'Connected servers and their tools.', null, el('p', { className: 'empty', textContent: 'MCP servers are managed from the chat.' })]; }
  function subagentsPage() { return [group('Subagents', 'Specialists the chat hands background work to.', null, el('p', { className: 'empty', textContent: 'Subagents run with smaller models; configure from the chat.' })]; }
  function modelPage() {
    const on = state.providers.filter((p) => p.on);
    const model = state.model ? `${state.model.provider}:${state.model.id}` : '';
    const select = on.length ? el('span', { className: 'px field select' },
      el('select', { 'aria-label': 'Model', 'data-k': 'model', on: { change: (e) => act(`model:${e.target.value}`) } },
        model ? null : el('option', { value: '', textContent: 'Pick a model', disabled: true, selected: true }),
        on.map((p) => el('optgroup', { label: p.label }, p.models.map((m) => el('option', { value: `${p.id}:${m.id}`, textContent: m.name, selected: `${p.id}:${m.id}` === model })))))) : null;
    // The accounts, then each local server (Ollama, LM Studio, the ones added) and the Add a server row.
    const servers = state.localServers ?? [];
    if (ui.addSent != null && servers.length > ui.addSent) { ui.addSent = null; ui.add = { label: '', url: '', key: '', images: false }; if (ui.key === ADD) ui.key = null; }
    const accounts = [...state.providers.filter((p) => p.id !== 'local' && (p.on || p.method)), ...servers.map((x) => ({ ...x, server: true })), { id: ADD, add: true }];
    const { box, nav } = paged('accounts', accounts, (p) => (p.add ? addServerRow() : p.server ? serverRow(p) : el('li', { className: `acct${ui.key === p.id ? ' open' : ''}` },
      el('div', { className: 'setting' },
        // Connected: a lit dot by the name, its word in a tooltip (and for screen readers).
        el('span', { className: 'acct-name' }, p.label, p.on ? el('span', { className: 'led on', role: 'img', 'aria-label': p.method === 'local' ? 'Connected' : 'Signed in', 'data-tip': p.method === 'local' ? 'Connected' : 'Signed in' }) : null),
        p.on ? el('span', { className: 'row-btns' },
          p.key ? changeKey(p) : null,
          ui.key === p.id ? null : armed(p.signedIn && !p.keySaved ? 'Sign out' : 'Remove', 'Confirm', `signout:${p.id}`, `signout:${p.id}`, `Remove ${p.label} from J.A.R.V.I.S`))
          : state.loggingIn === p.id ? el('span', { className: 'waiting', textContent: 'Signing in…' })
          : p.method === 'oauth' ? (p.key ? el('span', { className: 'links' }, signIn(p), addKey(p)) : signIn(p))
          : addKey(p)),
      p.method === 'key' || p.key ? keyForm(p.id, p.label, (key, kind) => send({ type: 'panel_key', provider: p.id, kind, key }), p.kinds) : null)),
    { label: 'Accounts', pin: accounts.findIndex((p) => p.id === ui.key) });
    return [
      group('Model', 'Which AI answers you.', null,
        select ?? el('p', { className: 'empty', textContent: 'Sign in to an account below first.' }),
        state.model?.levels?.length ? el('div', { className: 'setting' },
          el('span', {}, 'Effort', el('small', { textContent: 'How hard the model thinks before answering.' })),
          el('span', { className: 'px field select' },
            el('select', { 'aria-label': 'Effort', 'data-k': 'effort_default', on: { change: (e) => act(`effort_default:${e.target.value}`) } },
              ['' , 'off', ...state.model.levels].map((l) => el('option', { value: l, textContent: l === '' ? 'Automatic' : l, selected: (state.efforts?.default ?? '') === l }))))) : null),
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' }, el('h2', { textContent: 'Accounts' }), el('p', { textContent: 'Sign in to use their models.' })), box),
      foot(null, nav),
    ];
  }
  // A local server: connected (a lit dot) or not, its address if it was added, and why its models aren't in the
  // Model menu (not running, or none can see images). Ollama and LM Studio disconnect; added ones are removed.
  function serverRow(x) {
    const remove = armed(x.custom ? 'Remove' : 'Disconnect', 'Confirm', `local:remove:${x.id}`, `local:remove:${x.id}`, `${x.custom ? 'Remove' : 'Disconnect'} ${x.label}`);
    return el('li', { className: 'acct' },
      el('div', { className: 'setting' },
        // An added server's address is in its name's tooltip, so every row stays one line.
        el('span', { className: 'acct-name' }, el('span', { className: 'acct-label', 'data-tip': x.baseUrl ?? null, tabIndex: x.baseUrl ? 0 : null, 'aria-describedby': x.baseUrl ? `addr-${x.id}` : null }, x.label, x.baseUrl ? el('span', { className: 'sr-only', id: `addr-${x.id}`, textContent: x.baseUrl }) : null),
          x.on ? el('span', { className: 'led on', role: 'img', 'aria-label': 'Connected', 'data-tip': 'Connected' }) : null),
        el('span', { className: 'row-btns' }, x.on ? remove : x.custom ? el('span', { className: 'links' }, connect(x), remove) : connect(x))),
      x.note ? el('p', { className: 'empty note', textContent: x.note }) : null);
  }
  // Any other OpenAI-compatible server (llama.cpp, vLLM, oMLX…): a name, its address, a key if it needs one, and
  // whether its models can see images (most servers don't say). Saved once it answers; the sidecar says if it didn't.
  const ADD = 'local-add';
  function addServerRow() {
    const a = ui.add, open = ui.key === ADD;
    const field = (id, prop, label, o = {}) => el('span', { className: 'px field' }, el('input', {
      id, value: a[prop], 'aria-label': label, placeholder: o.placeholder ?? label, type: o.type ?? 'text', autocomplete: 'off', spellcheck: false, maxLength: o.max ?? 200,
      on: { input: (e) => { a[prop] = e.target.value; }, keydown: (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); closeKey(); } } } }));
    const save = () => {
      const label = a.label.trim(), url = a.url.trim();
      if (!label) return $(`${ADD}-name`)?.focus() ?? $(`key-${ADD}`)?.focus();
      if (!url) return $(`${ADD}-url`)?.focus();
      ui.addSent = (state.localServers ?? []).length;
      send({ type: 'panel_local_add', label, baseUrl: url, key: a.key.trim(), images: a.images });
    };
    return el('li', { className: `acct${open ? ' open' : ''}` },
      el('div', { className: 'setting' },
        el('span', { className: 'acct-label', 'data-tip': 'llama.cpp, vLLM, oMLX or any OpenAI-compatible server.' }, 'Another server'),
        el('span', { className: 'row-btns' }, link(open ? 'Cancel' : 'Add server', () => toggleKey(ADD), { k: `addkey:${ADD}`, aria: open ? 'Cancel adding a server' : 'Add a server' }))),
      open ? el('div', { className: 'addserver', 'data-anim': `key-${ADD}` },
        el('div', { className: 'keyform' }, field(`key-${ADD}`, 'label', 'Server name', { placeholder: 'Name', max: 40 }), field(`${ADD}-url`, 'url', 'Server address', { placeholder: 'http://127.0.0.1:8080', max: 500 })),
        el('div', { className: 'keyform' }, field(`${ADD}-key`, 'key', 'API key (optional)', { type: 'password', max: 1000 }), btn('Save', save, { k: `save:${ADD}` })),
        toggle('Its models can see images', 'Most servers don\'t say, so tell me.', a.images, () => { a.images = !a.images; render(`img:${ADD}`); }, `img:${ADD}`)) : null);
  }
  function appearancePage() {
    return [
      group('Size', 'How big I am on your screen.', null, picks('Size', state.sizes, state.size, (x) => act(`size:${x}`), 'size', SIZE_TIPS)),
    ];
  }
  // VoiceStudio on this computer: whether it's ready (or exactly why not), its engine, the voice, and Check again.
  function studioRows() {
    const vs = state.studio ?? { checking: true };
    const status = vs.checking ? 'Checking VoiceStudio…' : vs.ok ? `Connected${vs.engine ? ` · ${vs.engine}` : ''}` : vs.message || "VoiceStudio isn't available.";
    const voices = vs.voices ?? [];
    return [
      el('div', { className: 'setting' },
        el('span', {}, 'VoiceStudio', el('small', { className: vs.ok || vs.checking ? '' : 'bad', textContent: status, role: vs.ok || vs.checking ? null : 'alert' })),
        el('span', { className: 'row-btns' }, link('Check again', () => act('voicestudio_check'), { k: 'voicestudio_check', aria: 'Check VoiceStudio again' }))),
      vs.ok ? el('div', { className: 'reveal', 'data-anim': 'studio-voice' },
        el('p', { className: 'sub', textContent: `Voice for ${state.name}` }),
        el('span', { className: 'px field select' },
          el('select', { 'aria-label': 'VoiceStudio voice', 'data-k': 'studiovoice', on: { change: (e) => act(`studiovoice:${e.target.value}`) } },
            el('option', { value: 'default', textContent: 'Engine default', selected: !vs.voice || !voices.some((x) => x.id === vs.voice) }),
            voices.map((x) => el('option', { value: x.id, textContent: x.name, selected: x.id === vs.voice })))),
        voices.length ? null : el('p', { className: 'why', textContent: 'Save a voice in VoiceStudio (clone or design one) to pick it here.' }),
      ) : null,
    ];
  }
  const TTS_NAMES = { fish: 'Fish Audio', gemini: 'Gemini', openrouter: 'OpenRouter', voicestudio: 'VoiceStudio', elevenlabs: 'ElevenLabs' };
  function speakingPage() {
    // The service that speaks, each with its own key: Fish Audio's voice is the look's and it has models to pick
    // from; Gemini has a list of voices and two models; VoiceStudio runs on this computer and needs no key.
    const tts = TTS_NAMES[state.tts] ? state.tts : 'fish', T = TTS_NAMES[tts], local = tts === 'voicestudio', hasKey = local || !!state[`${tts}Key`];
    // Gemini (and OpenRouter, which speaks with Gemini's voices) can use the key the AI already has (the Model page).
    const shared = hasKey && !!state[`${tts}Shared`];
    const textOnly = state.voice?.mode === 'text';
    return [
      group('Spoken replies', 'Hear me as well as read me.', null,
        textOnly ? el('p', { className: 'why', textContent: 'Voice mode is Text only, so I answer in writing. Switch to Hands-free or Push to talk on the Listening page to hear me.' })
          : picks('Replies', [['text', 'Text only'], ['voice', 'Voice and text']], state.replies, (x) => {
            if (x === 'voice' && !hasKey) { ui.key = tts; render(`key-${tts}`); note(`Add a ${T} key to hear me talk.`); return; }
            act(`replies:${x}`);
          }, 'replies', { text: 'I answer in writing only.', voice: `I say my answers out loud too, in the voice below${hasKey ? '' : `. Needs a ${T} key`}.` }),
        el('p', { className: 'sub', textContent: 'Voice provider' }),
        picks('Voice provider', Object.entries(TTS_NAMES), tts, (x) => {
          if (x !== 'voicestudio' && !state[`${x}Key`]) { ui.key = x; note(`Add a ${TTS_NAMES[x]} key to hear me talk.`); } // its key field opens with it
          act(`tts:${x}`);
        }, 'tts', { fish: "J.A.R.V.I.S's voice, acted out with feeling. Billed to your Fish Audio account.", gemini: "Google's voices: pick one of 30. Billed to your Google AI Studio account.", openrouter: "Google's Gemini voices through your OpenRouter account. Billed to your OpenRouter credits.", voicestudio: 'The free VoiceStudio app on this computer, in the engine and voices you set up there. Nothing leaves your computer.', elevenlabs: "J.A.R.V.I.S's ElevenLabs voice: a library voice, or your own created voice. Billed to your ElevenLabs account." }),
        local ? el('div', { className: 'reveal', 'data-anim': 'studio' }, studioRows()) : null,
        tts === 'gemini' && hasKey && state.geminiVoices?.length ? el('div', { className: 'reveal', 'data-anim': 'gemini-voice' },
          el('p', { className: 'sub', textContent: `Voice for ${state.name}` }),
          el('span', { className: 'px field select' },
            el('select', { 'aria-label': `${TTS_NAMES[tts]} voice`, 'data-k': `${tts}voice`, on: { change: (e) => act(`${tts}voice:${e.target.value}`) } },
              state[`${tts}Voices`].map((g) => el('option', { value: g.id, textContent: `${g.id} · ${g.style}`, selected: g.id === state[`${tts}Voice`] })))),
        ) : null,
        tts === 'gemini' && hasKey && state.geminiModels?.length ? el('div', { className: 'reveal', 'data-anim': 'gemini-model' },
          el('p', { className: 'sub', textContent: 'Voice model' }),
          picks('Voice model', state.geminiModels.map((c) => [c.id, c.name]), state.geminiModel, (x) => act(`geminimodel:${x}`), 'geminimodel',
            Object.fromEntries(state.geminiModels.map((c) => [c.id, `${GEMINI_WHY_LONG[c.id] ?? ''} ${geminiPrice(c)}`.trim()]))),
          el('p', { className: 'why', textContent: GEMINI_WHY[state.geminiModel] ?? '' }),
        ) : null,
        tts === 'fish' && state.replies === 'voice' && state.fishModels?.length ? el('div', { className: 'reveal', 'data-anim': 'fish-model' },
          el('p', { className: 'sub', textContent: 'Voice model' }),
          picks('Voice model', state.fishModels.map((c) => [c.id, c.name]), state.fishModel, (x) => act(`fishmodel:${x}`), 'fishmodel',
            Object.fromEntries(state.fishModels.map((c) => [c.id, `${WHY_LONG[c.id] ?? ''} ${price(c)}`.trim()]))),
          el('p', { className: `why${state.fishFree ? ' late' : ''}`, textContent: state.fishFree ? "No credit left, so it's on Fish's free tier" : WHY[state.fishModel] ?? '' }),
        ) : null,
        tts === 'elevenlabs' && hasKey && state.elevenVoices?.length ? el('div', { className: 'reveal', 'data-anim': 'eleven-voice' },
          el('p', { className: 'sub', textContent: `Voice for ${state.name}` }),
          el('span', { className: 'px field select' },
            el('select', { 'aria-label': 'ElevenLabs voice', 'data-k': 'elevenvoice', on: { change: (e) => act(`elevenvoice:${e.target.value}`) } },
              [...(state.elevenVoiceCustom ? [{ id: state.elevenVoice, name: 'My own voice' }] : []), ...state.elevenVoices]
                .map((v) => el('option', { value: v.id, textContent: v.name, selected: v.id === state.elevenVoice })))),
        ) : null,
        tts === 'elevenlabs' && hasKey ? el('div', { className: 'reveal', 'data-anim': 'eleven-custom' },
          el('p', { className: 'sub', textContent: 'Your own voice id' }),
          el('span', { className: 'px field' },
            el('input', { type: 'text', 'aria-label': 'ElevenLabs voice id', placeholder: 'Voice id from elevenlabs.io', spellcheck: 'false', autocomplete: 'off', maxLength: 128, on: {
              keydown: (e) => { if (e.key === 'Enter') { const v = e.target.value.trim(); act(`elevenvoice:${v}`); e.target.value = ''; } },
              // Applying on blur too, so pasting and tabbing away (or clicking Play) never leaves it unapplied.
              blur: (e) => { const v = e.target.value.trim(); if (v) act(`elevenvoice:${v}`); e.target.value = ''; },
            } })),
          el('p', { className: 'why', textContent: 'Open your voice on elevenlabs.io and copy its Voice ID. Paste it here and press Enter (or click away); clear it and press Enter to use the demo voice again.' })) : null,
        tts === 'elevenlabs' && hasKey && state.elevenModels?.length ? el('div', { className: 'reveal', 'data-anim': 'eleven-model' },
          el('p', { className: 'sub', textContent: 'Voice model' }),
          picks('Voice model', state.elevenModels.map((c) => [c, c]), state.elevenModel, (x) => act(`elevenmodel:${x}`), 'elevenmodel',
            Object.fromEntries(state.elevenModels.map((c) => [c, ELEVEN_WHY[c] ?? '']))),
        ) : null,
        local ? null : el('div', { className: 'setting' },
          el('span', {}, `${T} key`, el('small', { textContent: shared ? 'Shared with the Model page' : hasKey ? `Saved in ${where()}` : 'Needed for spoken replies' })),
          el('span', { className: 'row-btns' },
            link(ui.key === tts ? 'Cancel' : shared ? 'Use another' : hasKey ? 'Change' : 'Add', () => toggleKey(tts), { k: `addkey:${tts}`, aria: hasKey ? `Change the ${T} key` : `Add a ${T} key` }),
            hasKey && !shared && ui.key !== tts ? armed('Remove', 'Confirm', `${tts}key-remove`, `${tts}key_remove`, `Remove the ${T} key`) : null)),
        local ? null : keyForm(tts, T, (key) => send({ type: `panel_${tts}key`, key }))),
    ];
  }
  // Which mic I listen on (from #59, by overspend1): automatic (the system's default, or on a Mac the built-in mic while
  // that's a Bluetooth headset, which would drop to call-quality sound), or one picked here, kept while it's unplugged.
  function micPicker(v) {
    if (!v.mics?.length) return null;
    const gone = v.mic && !v.mics.some((m) => m.id === v.mic);
    return el('div', { className: 'reveal', 'data-anim': 'mic' },
      el('p', { className: 'sub', textContent: 'Microphone' }),
      el('span', { className: 'px field select' },
        el('select', { 'aria-label': 'Microphone', 'data-k': 'mic', on: { change: (e) => act(`mic:${e.target.value}`) } },
          el('option', { value: '', textContent: v.micAuto ? `Automatic (${v.micAuto})` : 'Automatic', selected: !v.mic }),
          v.mics.map((m) => el('option', { value: m.id, textContent: m.name, selected: m.id === v.mic })),
          gone ? el('option', { value: v.mic, textContent: 'Picked mic (unplugged, using automatic)', selected: true }) : null)));
  }
  // Wayland: the commands to bind to keys in the desktop's settings (no app may hold its own shortcuts there).
  // A command shows only after copying it failed, so it can be copied by hand.
  const BIND_ROWS = [['talk', 'Talk to me'], ['summon', 'Show or hide me'], ['ask', 'Ask me'], ['list', 'Your list'], ['panel', 'This panel']];
  // Talking to me. On Windows and Linux: the voice mode first (hands-free, push to talk or text only), then what
  // hands-free means. On macOS the mode and VAD picks aren't wired (the helper doesn't take them), so the page is
  // the pre-0.2.0 layout and nothing shown is inert.
  function listeningPage() {
    const v = state.voice;
    if (!v) return [group('Listening', 'Voice input isn’t available on this computer.', null)];
    const mac = !!v.mac;
    const canWake = mac || state.os === 'win';
    const mode = ['ptt', 'handsfree', 'text'].includes(v.mode) ? v.mode : 'handsfree';
    const on = mac ? v.on : mode !== 'text';
    const needs = (hint) => (on ? hint : (mac ? 'Needs Voice control on' : 'Needs voice on'));
    const pause = String(v.vad?.pause ?? 1.5);
    const sens = v.vad?.sensitivity ?? 'normal';
    const downloadRow = v.download
      ? el('div', { className: 'setting' }, el('span', {}, 'Voice', el('small', { textContent: v.download.status === 'downloading' ? `Downloading the voice model… ${v.download.pct}%` : v.download.status === 'error' ? 'The download failed' : `Needs a ${v.download.size} download` })),
        v.download.status === 'downloading' ? null : link(v.download.status === 'error' ? 'Retry the download' : `Download (${v.download.size})`, () => act('voicedl'), { k: 'voicedl' })) : null;
    return [
      mac ? null : group('How do you want to talk?', 'Pick one. Change it whenever.', null,
        picks('Voice mode', [['handsfree', 'Hands-free'], ['ptt', 'Push to talk'], ['text', 'Text only']], mode, (x) => act(`voicemode:${x}`), 'voicemode',
          { handsfree: 'Tap your talk keys and speak. I send on a pause, or tap again to send early.', ptt: v.keys ? `Hold ${v.keys} and talk. Let go and I answer.` : 'Hold your talk keys and talk. Let go and I answer.', text: 'No microphone. I read and answer in writing.' })),
      !mac && mode === 'text' ? group('Text only', 'Voice input and spoken replies are off. Everything else still works.', null) : [
        group('Talking to me', 'Speak instead of typing.', null,
          mac ? toggle('Voice control', v.download
              ? (v.download.status === 'downloading' ? `Downloading the voice model… ${v.download.pct}%` : v.download.status === 'error' ? 'The download failed' : `Needs a ${v.download.size} download`)
              : v.keys ? `Hold ${v.keys} to talk` : 'Press your talk shortcut to talk', v.on, () => act('voice'), 'voice')
            : downloadRow,
          mac ? downloadRow : null,
          micPicker(v),
          mac ? toggle('Mute Mac while talking', 'Other sounds go quiet while you talk', v.mute, () => act('mutetalk'), 'mutetalk') : null),
        mode === 'handsfree' ? group('Hands-free', 'When the mic opens without a key.', null,
          toggle('Auto-listen', needs('Mic opens when I ask you something.'), v.autoListen, () => act('autolisten'), 'autolisten'),
          toggle('Listen after reminders', needs('Mic opens after a reminder, so you can say “snooze 10 minutes”.'), v.snoozeListen, () => act('snoozelisten'), 'snoozelisten'),
          mac ? null : picks('Pause to send', [['0.75', 'Short'], ['1.5', 'Normal'], ['3', 'Long']], pause, (x) => act(`vadpause:${x}`), 'vadpause',
            { '0.75': 'Wait three quarters of a second of quiet.', '1.5': 'A natural pause, like a breath between sentences.', '3': 'Long silence before I send (slow talkers).' }),
          mac ? null : picks('Mic sensitivity', [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']], sens, (x) => act(`vadsensitivity:${x}`), 'vadsensitivity',
            { low: 'Needs a clear voice, barely notices the room.', normal: 'Works out the room first, then hears you.', high: 'Hears a quiet voice; noise may open the mic.' }),
          canWake ? toggle('Wake word', v.wakeProblem ? 'Wake word isn’t listening; check the microphone' : needs(`Say “Hey ${v.wakeName || 'Jarvis'}” to talk. Mic stays on.`), v.wakeWord, () => act('wakeword'), 'wakeword') : null,
          canWake ? el('div', { className: 'setting' }, el('span', {}, 'Wake word name', el('small', { textContent: `Hey ${v.wakeName || 'Jarvis'}` })),
            link('Change', () => act('wakename'), { k: 'wakename', aria: 'Change the wake word name' })) : null) : null,
      ],
    ];
  }
  // The screen: Always-Aware, private mode and the exclusions list for what the eyes may see.
  function screenPage() {
    const a = state.aware ?? { on: false, mode: 'front', private: false, exclusions: [] };
    const exclusions = Array.isArray(a.exclusions) ? a.exclusions : [];
    const mode = a.mode === 'screen' ? 'screen' : 'front';
    const exclRow = (e) => el('div', { className: 'setting excl' },
      el('span', {}, e, el('small', { textContent: 'Excluded — never looked at' })),
      armed('Remove', 'Confirm', `excl:${e}`, `awareexclrm:${e}`, `Remove “${e}” from screen exclusions`));
    return [
      group('Always-Aware', 'I know what you’re looking at while you work: the app, the page, the error. Your request carries it to me, nowhere else.', null,
        toggle('Always-Aware', a.on ? (a.private ? 'Private mode is on' : mode === 'screen' ? 'The whole screen is in view' : 'The front window is in view') : 'I can’t see which app you’re in', a.on, () => act('aware'), 'aware'),
        a.on ? picks('What I see', [['front', 'Front window'], ['screen', 'Whole screen']], mode, (x) => act(`awaremode:${x}`), 'awaremode',
          { front: 'The window you’re in right now (most private).', screen: 'Everything on your main display — notifications and other open apps too.' }) : null,
        a.on ? toggle('Private mode', a.private ? 'Seeing nothing. Switch off to see again.' : 'Switch on and I see nothing until you switch it back.', a.private, () => act('awareprivate'), 'awareprivate') : null),
      group('Screen exclusions', 'Windows I never look at — an app, or part of a title. Password fields are always blacked out; these go further: no picture, no words.', null,
        exclusions.length ? exclusions.map(exclRow) : el('p', { className: 'sub', textContent: 'Nothing is excluded; password fields are still blacked out. Add apps you never want seen.' }),
        el('div', { className: 'setting excl-add' },
          el('span', {}, 'Add an exclusion', el('small', { textContent: 'An app name or part of a title, e.g. “my bank”' })),
          el('span', { className: 'row-btns' },
            el('span', { className: 'px field' }, el('input', { id: 'awareexcl-add', type: 'text', placeholder: 'my bank', autocomplete: 'off', spellcheck: false, 'aria-label': 'Add an exclusion',
              on: { keydown: (e) => { if (e.key === 'Enter') { const v = e.currentTarget.value.trim(); if (v) { act(`awareexcladd:${v}`); e.currentTarget.value = ''; } } } } })),
            link('Add', () => { const i = $('awareexcl-add'); const v = (i?.value ?? '').trim(); if (v) { act(`awareexcladd:${v}`); i.value = ''; } }, { k: 'awareexcladd', aria: 'Add the exclusion' })))),
      el('p', { className: 'why', textContent: 'No picture is kept anywhere: on a request one is taken, used and thrown away; password fields are blacked out in it. The dot shows this mode — it’s the mode, not a live guarantee. On the lock screen I never see or capture anything, whatever this says.' }),
    ];
  }
  // The keys that work from anywhere. On Wayland no app may hold its own, so it lists the commands to bind instead.
  const SHORTCUT_LABELS = { summon: 'Show or hide me', snap: 'Ask about an area', list: 'Your list' };
  function shortcutsPage() {
    const b = state.bind, sc = state.shortcuts, w = state.writeKeys;
    const single = (id) => !!id && id !== 'off' && !id.includes('+');
    if (b) {
      return [group('Shortcuts', 'Add these as custom shortcuts in your keyboard settings, with any keys you like.', null,
        BIND_ROWS.filter(([k]) => b[k]).map(([k, label]) => el('div', { className: 'setting' },
          el('span', {}, label, ui.bindShown.has(k) ? el('small', { className: 'cmd', textContent: b[k] }) : null),
          link('Copy', () => send({ type: 'copy_bind', which: k }), { k: `bind-${k}`, aria: `Copy the command for ${label.toLowerCase()}` }))))];
    }
    if (!sc) return [group('Shortcuts', 'This computer doesn’t allow shortcuts that work from anywhere.', null)];
    return [
      sc.talk ? group('Talk', 'Hold two keys to talk. Tap them to talk hands-free.', null,
        picks('Talk keys', sc.talk.pairs, sc.talk.value, (x) => act(`talk:${x}`), 'talk',
          Object.fromEntries(sc.talk.pairs.map(([id, keys]) => [id, `Hold ${keys} to talk. If they’re your typing keys, the two swap.`])))) : null,
      w ? group('Type to me', single(w.value) ? 'Press one key to open a text box by the cursor, anywhere.' : 'Tap two keys together to open a text box by the cursor.', null,
        picks('Type-to-me key', [...w.pairs, ['off', 'Off']], w.value, (x) => act(`write:${x}`), 'write',
          Object.fromEntries([...w.pairs.map(([id, keys]) => [id, single(id) ? `Press ${keys} anywhere to type to me.` : `Tap ${keys} together, anywhere, to type to me.`]),
            ['off', 'No shortcut opens the text box, so the key stays free for other apps. The Ask button on Home still opens it.']]))) : null,
      group('Other keys', 'Press Change, then the new keys. Esc cancels.', null,
        sc.keys.map(({ id, words }) => {
          const rec = ui.rec === id, label = SHORTCUT_LABELS[id] ?? id;
          return el('div', { className: `setting${rec ? ' recording' : ''}` },
            el('span', {}, label, el('small', { textContent: rec ? 'Press the new keys…' : words, 'aria-live': rec ? 'polite' : null })),
            link(rec ? 'Cancel' : 'Change', () => { ui.rec = rec ? null : id; render(`rec-${id}`); }, { k: `rec-${id}`, aria: rec ? `Stop changing the keys for ${label.toLowerCase()}` : `Change the keys for ${label.toLowerCase()}` }));
        })),
    ];
  }
  // Things I do on my own through the day.
  function routinesPage() {
    const f = state.focus;
    return [
      group('Routines', 'Things I do on my own through the day.', null,
        state.brief ? toggle('Morning briefing', 'The first time you talk to me each day, I start with what’s due.', state.brief.on, () => act('morningbrief'), 'morningbrief') : null,
        state.brief?.on && state.brief.canTodoist ? toggle('Include Todoist', 'I read your Todoist window (opening it if needed). Stay signed in.', state.brief.todoist, () => act('brieftodoist'), 'brieftodoist') : null,
        f ? el('div', { className: 'setting' },
          el('span', {}, f.until ? 'Focus block running' : 'Focus distractions',
            el('small', { textContent: f.until ? `Until ${new Date(f.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${f.task ? ` · ${f.task}` : ''}` : `Say “focus for 30 minutes”. I watch for: ${f.list.slice(0, 4).join(', ')}${f.list.length > 4 ? '…' : ''}` })),
          f.until ? link('Stop', () => act('focusstop'), { k: 'focusstop', aria: 'Stop the focus block' }) : link('Edit', () => act('distractions'), { k: 'distractions', aria: 'Edit the distraction list' })) : null),
    ];
  }
  function studioPage() {
    return [
      group('Studio', 'Say it. It lands on the canvas as text — never as a command.', null,
        toggle('Dictate', 'Your words become text, not commands', !!state.studioListening, () => act('studiolisten'), 'studiolisten'),
        el('textarea', { className: 'studio-canvas', id: 'studio-canvas', 'aria-label': 'Prompt Studio canvas', spellcheck: 'false', value: studioCache, on: {
          input: (e) => { studioCache = e.target.value; clearTimeout(studioSaveTimer); studioSaveTimer = setTimeout(() => send({ type: 'panel_studio_set', text: studioCache }), 250); },
          keydown: (e) => { if (e.key === 'Tab') e.stopPropagation(); },
        } })),
        el('div', { className: 'studio-actions' },
          link('Polish', () => refineStudio('Polish it: make it precise and convincing.'), { k: 'studio-polish', aria: 'Rewrite for precision and persuasion' }),
          link('Shorten', () => refineStudio('Shorten it. Keep the meaning, drop the padding.'), { k: 'studio-shorten', aria: 'Rewrite shorter' }),
          link('Formalise', () => refineStudio('Formalise the tone; keep the content.'), { k: 'studio-formalise', aria: 'Rewrite in a formal tone' }),
          link('Export', () => { note('Saving…'); send({ type: 'panel_studio_export', text: studioCache }); }, { k: 'studio-export', aria: 'Save a copy to the Desktop' }),
          link('Copy', () => { navigator.clipboard.writeText(studioCache).then(() => note('Copied.'), () => note("Couldn't copy it. Select and copy manually.", true)); }, { k: 'studio-copy', aria: 'Copy the canvas' })),
      el('p', { className: 'why', textContent: 'Your draft lives at ~/.gg/studio-draft.md — it never leaves this computer.' }),
    ];
  }
  function refineStudio(instruction) {
    const ta = $('studio-canvas'), text = (ta?.value ?? studioCache).trim();
    if (!text) return note('Nothing to work with yet — write or dictate something first.', true);
    if (studioBusy) return;
    studioBusy = true;
    note('Working on it…');
    send({ type: 'panel_studio_refine', instruction, text });
  }
  function studioReplaceSelection(text) {
    const ta = $('studio-canvas');
    if (!ta) { studioCache = text; return; }
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) { ta.value = text; studioCache = text; ta.focus(); return; }
    ta.setRangeText(text, s, e, 'end'); studioCache = ta.value; ta.focus();
  }
  // What I may do, and when I start.
  function generalPage() {
    return [
      group('General', 'What I may do, and when I start.', null,
        state.gameMode != null ? toggle('Game mode', 'In a fullscreen game, I move to a panel at the edge of the screen.', state.gameMode, () => act('gamemode'), 'gamemode') : null,
        toggle('Allow file edits and commands', 'Change files and run commands', state.actions, () => act('actions'), 'actions'),
        toggle('Brief mode', 'Shorter, one- or two-sentence replies', state.brief, () => act('brief'), 'brief'),
        toggle('Local awareness', 'Sharing your locale and time zone for local weather, news and events', state.localAwareness, () => act('localawareness'), 'localawareness'),
        state.login ? toggle('Open at login', null, state.login.on, () => act('login'), 'login') : null,
        state.sync ? el('div', { className: 'setting' },
          el('span', {}, 'Sync memory', el('small', { title: state.sync.dir, textContent: !state.sync.dir ? 'Share reminders and memory with your other computer' : state.sync.error ? `Not syncing: ${state.sync.error}` : `Via ${state.sync.dir.split(/[\\/]/).filter(Boolean).pop()}${state.sync.at ? ` · ${new Date(state.sync.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}` })),
          state.sync.dir ? [state.sync.paused ? link('Sync anyway', () => act('syncallow'), { k: 'syncallow', danger: true, aria: 'Sync anyway, removing those items on every computer' }) : null,
            link('Stop', () => act('syncstop'), { k: 'syncstop', aria: 'Stop syncing memory' })] : link('Set up', () => act('syncsetup'), { k: 'syncsetup', aria: 'Set up memory sync' })) : null),
    ];
  }
  // The manual and the housekeeping, no maker cards and no in-app updater.
  function aboutPage() {
    return [
      group('Help', null, null,
        el('div', { className: 'links' },
          link('Setup guide', () => act('setup', true), { k: 'setup' }),
          link('Show logs', () => act('logs'), { k: 'logs' }),
          link('Save diagnostics', () => act('diagnostics'), { k: 'diagnostics', aria: 'Save a diagnostics file to send when something goes wrong' }),
          // Only once there is one: the latest error anyone saw, in full, for pasting into a report.
          state.problem ? link('Copy last error', copyProblem, { k: 'copy-problem' }) : null)),
    ];
  }

  // ---------------------------------------------------------------- render
  const PANES = { home, memory, model: modelPage, appearance: appearancePage, speaking: speakingPage, listening: listeningPage, screen: screenPage, shortcuts: shortcutsPage, routines: routinesPage, studio: studioPage, general: generalPage, about: aboutPage, secondbrain: secondBrainPage, skills: skillsPage, mcp: mcpPage, subagents: subagentsPage };
  // focusKey: what to focus after (a data-k, or an element id); otherwise whatever had focus keeps it.
  function render(focusKey, animate = false) {
    if (!state) return;
    const active = document.activeElement;
    // Never rebuild under someone typing a key: catch up when they leave the field.
    if (!focusKey && !animate && active?.tagName === 'INPUT' && active.closest('.pane')) { deferred = true; return; }
    deferred = false;
    const keep = focusKey ?? active?.dataset?.k ?? (active?.id?.startsWith('key-') ? active.id : null);
    hideTip();
    const scroll = $('pane-' + tab).closest('.body').scrollTop;
    head();
    const pane = $(`pane-${tab}`);
    const same = render.tab === tab; render.tab = tab;
    const before = new Set([...pane.querySelectorAll('[data-anim]')].filter(shown).map((n) => n.dataset.anim));
    const draw = () => { pane.replaceChildren(...PANES[tab]().flat().filter(Boolean)); pane.classList.toggle('paged', !!pane.querySelector('.pagebox')); };
    draw();
    // Lists show as many rows as fit: drawn once to measure, again if a different number fits.
    if (fit()) draw();
    pane.closest('.body').scrollTop = scroll;
    if (same && !animate) for (const n of pane.querySelectorAll('[data-anim]')) if (shown(n) && !before.has(n.dataset.anim)) grow(n, true);
    // Rows fill in one after another (a page's worth; the rest come with the last), only when it opens or
    // the tab changes, never on the updates that arrive while it's open.
    pane.classList.toggle('enter', animate);
    if (animate) {
      let i = 0;
      for (const n of pane.children) { n.style.setProperty('--i', Math.min(i++, 10)); for (const li of n.querySelectorAll('.list > li')) li.style.setProperty('--i', Math.min(i++, 10)); }
      clearTimeout(render.t); render.t = setTimeout(() => pane.classList.remove('enter'), 600);
    }
    if (keep) (document.querySelector(`.pane [data-k="${CSS.escape(keep)}"]`) ?? document.getElementById(keep))?.focus();
  }
  document.addEventListener('focusout', (e) => { if (deferred && e.target.tagName === 'INPUT') setTimeout(() => deferred && render(), 0); });
  // The window changes size with the screen it opens on: as many rows as fit there.
  let resizeTimer = 0;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state && render(), 120); });

  // copy: the app has the full error behind this line; Copy details puts it on the clipboard (and the note stays
  // up longer, to leave time to press it).
  const copyProblem = () => send({ type: 'copy_problem', from: 'panel' });
  let noteTimer = 0;
  function note(text, bad = false, copy = false) {
    const n = $('note');
    n.replaceChildren(el('span', { textContent: text, title: text }), ...(copy ? [link('Copy details', copyProblem, { k: 'note-copy' })] : []));
    n.removeAttribute('title'); n.className = `note${bad ? ' bad' : ''}`; n.hidden = false;
    clearTimeout(noteTimer); noteTimer = setTimeout(() => { n.hidden = true; }, copy ? 20000 : bad ? 9000 : 5000);
  }

  // ---------------------------------------------------------------- sidebar and keys
  const TABS = Object.keys(PANES);
  const navi = (t) => $(`nav-${t}`);
  function show(name, focus = false) {
    if (!PANES[name]) name = name === 'settings' ? 'model' : 'home';
    const changed = name !== tab;
    if (!changed && !focus) return;
    tab = name;
    disarm(); ui.key = null; ui.rec = null;
    for (const t of TABS) {
      if (t === name) navi(t).setAttribute('aria-current', 'page'); else navi(t).removeAttribute('aria-current');
      $(`pane-${t}`).hidden = t !== name;
    }
    $('pane-' + name).closest('.body').scrollTop = 0;
    if (name === 'studio') send({ type: 'panel_studio_get' });
    render(null, changed);
    const t = navi(name);
    if (changed) { t.classList.remove('ping'); void t.offsetWidth; t.classList.add('ping'); }
    if (focus) t.focus();
  }
  document.querySelector('.side').addEventListener('animationend', (e) => e.target.classList.remove('ping'));
  for (const t of TABS) navi(t).addEventListener('click', () => show(t));
  // The search field: filter the sidebar as you type, Enter opens the first match, Esc clears it (and only it).
  const jump = $('jump');
  const jumpItems = [...document.querySelectorAll('.navi')];
  const filterJump = () => {
    const words = jump.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const b of jumpItems) {
      const hay = `${b.textContent} ${b.dataset.search ?? ''}`.toLowerCase();
      b.closest('li').hidden = words.some((w) => !hay.includes(w));
    }
  };
  jump.addEventListener('input', filterJump);
  jump.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = jumpItems.find((b) => !b.closest('li').hidden);
      if (first) { show(first.dataset.page, true); jump.value = ''; filterJump(); }
    } else if (e.key === 'Escape') { e.stopPropagation(); jump.value = ''; filterJump(); jump.blur(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); jump.focus(); jump.select(); }
  });
  // Up and down walk the sidebar (Home and End jump to its ends); Tab goes on into the page.
  document.querySelector('.side').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(e.target.dataset?.page);
    if (i < 0) return;
    const n = TABS.length;
    const j = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j >= 0) { e.preventDefault(); show(TABS[j], true); }
  });
  // Changing a shortcut on the Shortcuts page: the next key with Control, Option (Alt) or Command (Win) is the new one.
  const KEY_CODE = /^(Key[A-Z]|Digit\d|F\d{1,2}|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;
  document.addEventListener('keydown', (e) => {
    const which = ui.rec;
    if (!which) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === 'Escape') { ui.rec = null; render(`rec-${which}`); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key) || !KEY_CODE.test(e.code)) return;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean);
    if (!mods.some((x) => x !== 'Shift')) { note(state.os === 'mac' ? 'Hold Control, Option or Command too.' : 'Hold Ctrl or Alt too.', true); return; }
    ui.rec = null;
    act(`shortcut:${which}:${[...mods, e.code].join('+')}`);
    render(`rec-${which}`);
  }, true);
  // Radio groups: arrows move the choice, like the setup guide's.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && tipFor) { e.preventDefault(); hideTip(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented) { const was = ui.arm; if (ui.key) closeKey(); else if (disarm()) render(was ?? undefined); else hide(); return; }
    const tl = e.target.closest?.('[role="tablist"]');
    if (tl && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const all = [...tl.querySelectorAll('[role="tab"]')], i = all.indexOf(e.target);
      all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]?.click();
      return;
    }
    const g = e.target.closest?.('[role="radiogroup"]');
    if (!g || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const all = [...g.querySelectorAll('[role="radio"]')], i = all.indexOf(e.target);
    const next = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
    next?.click();
    // Focus follows the choice (the group may be redrawn when the new state arrives).
    const k = next?.dataset.k;
    if (k) { next.focus(); setTimeout(() => document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus(), 200); }
  });
  // The recent list's "2m ago" stays true while it's open.
  setInterval(() => { if (tab === 'home' && !document.hidden) render(); }, 30000);

  // Switching on and off. main.rs calls these as it shows the window and before it hides it. One listener, and it
  // only acts on the animation that's playing now: a close cut short (the window hides on the last frame, which
  // pauses it) must never finish later and blank the panel it just reopened.
  const body = $('frame');
  body.addEventListener('animationend', (e) => {
    if (e.target !== body) return;
    if (e.animationName === 'crt-on' && body.classList.contains('opening')) body.classList.remove('opening');
    else if (e.animationName === 'crt-off' && body.classList.contains('shutting')) { body.classList.remove('shutting'); body.classList.add('shut'); }
  });
  window.__panelOpen = (fromBottom = false) => {
    body.classList.remove('shut', 'shutting', 'opening');
    // J.A.R.V.I.S switches on with the panel, and waves if it's been a while.
    if (avatar) { avatar.kit.vanish(null, true); setTimeout(() => { avatar.appear(); if (Date.now() - seen.opened > 10 * 60e3) setTimeout(() => avatar.act('wave'), 500); seen.opened = Date.now(); }, REDUCED.matches ? 0 : 120); }
    body.classList.toggle('from-bottom', !!fromBottom);
    if (REDUCED.matches) return render(null, false);
    void body.offsetWidth;
    body.classList.add('opening');
    render(null, true);
  };
  window.__panelShut = () => {
    disarm(); ui.key = null; unarmQuit();
    body.classList.remove('opening');
    if (REDUCED.matches) { body.classList.add('shut'); return; }
    body.classList.add('shutting');
  };
  // A click anywhere else puts an armed Confirm back.
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('#head-quit')) unarmQuit();
    if (ui.arm && !e.target.closest?.('.arm[aria-pressed="true"], .ibtn[aria-pressed="true"]')) {
      const text = document.querySelector('.pane .arm[aria-pressed="true"]');
      disarm(); calmIcons(); if (text) render(); // a tick or X goes back in place, so it can ease back
    }
  }, true);

  window.__panel = (m) => {
    if (m.kind === 'state') {
      const first = !state; state = m.state;
      if (ui.arm && !document.querySelector(`[data-k="${CSS.escape(ui.arm)}"]`)) ui.arm = null;
      render(null, first);
      if (m.state.tab) show(m.state.tab, true); // opened for a reason (asked with nothing signed in: the Model page)
    }
    else if (m.kind === 'note') note(m.text, m.bad, m.copy);
    else if (m.kind === 'copied' && m.which === 'problem') note(m.ok ? 'Copied the error details. Paste them into your report.' : "Couldn't copy the error details. Try Save diagnostics.", !m.ok);
    else if (m.kind === 'copied') {
      if (!m.ok && state?.bind?.[m.which]) { ui.bindShown.add(m.which); render(`bind-${m.which}`); }
      note(m.ok ? 'Copied. Paste it into a new custom shortcut.' : "Couldn't copy it. Select the command and copy it instead.", !m.ok);
    }
    else if (m.kind === 'studio') { studioCache = m.text ?? ''; const ta = $('studio-canvas'); if (ta) ta.value = studioCache; }
    else if (m.kind === 'brain') onBrain(m);
    else if (m.kind === 'studio_append' && m.text) {
      const add = m.text.trim(), sep = studioCache && !/\s$/.test(studioCache) ? ' ' : '';
      studioCache += sep + add + ' ';
      const ta = $('studio-canvas'); if (ta) { ta.value = studioCache; ta.selectionStart = ta.selectionEnd = studioCache.length; }
      send({ type: 'panel_studio_set', text: studioCache });
    }
    else if (m.kind === 'studio_refined') { studioBusy = false; studioReplaceSelection(m.text ?? ''); note('Done.'); send({ type: 'panel_studio_set', text: studioCache }); }
    else if (m.kind === 'studio_export') { if (m.ok) note(`Saved as ${m.path.split(/[\\/]/).pop()} on your Desktop.`); else note("Couldn't save it to the Desktop.", true); }
  };
  send({ type: 'panel_open' });
  // The first show: the window was made hidden, so the switch-on is played here (main.rs's call may land
  // before this script has run).
  window.__panelOpen();

  // ---------------------------------------------------------------- browser preview
  function preview() {
    document.title = 'J.A.R.V.I.S panel (preview with sample data)';
    const at = Date.now(), q = new URLSearchParams(location.search);
    const s = {
      version: '0.7.0', os: /Win/.test(navigator.platform) ? 'win' : 'mac',
      status: { state: 'ready', text: 'Ready' }, busy: false, canNew: true,
      model: { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', providerLabel: 'Anthropic' },
      providers: [
        { id: 'anthropic', label: 'Anthropic', on: true, method: 'oauth', key: true, signedIn: true, models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] },
        { id: 'openai', label: 'OpenAI', on: false, method: 'oauth', key: true, models: [] },
        { id: 'gemini', label: 'Gemini', on: true, method: 'key', key: true, keySaved: true, models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] },
        { id: 'groq', label: 'Groq', on: false, method: 'key', key: true, keySaved: false, models: [] },
        { id: 'moonshot', label: 'Kimi (Moonshot)', on: false, method: 'key', models: [], kinds: [
          { id: 'kimi-code', label: 'Kimi Code', billing: 'Uses your Kimi Code plan. Create the key in the Kimi Code Console.' },
          { id: 'moonshot', label: 'Moonshot', billing: 'Pay-per-token from platform.moonshot.ai.' }] },
        { id: 'local', label: 'Local models', on: q.has('local'), method: 'local', models: q.has('local') ? [{ id: 'local/ollama/qwen3-vl:8b', name: 'qwen3-vl:8b (Ollama)' }] : [] },
        ...['xAI', 'GLM (Z.ai)', 'MiniMax', 'Xiaomi', 'DeepSeek', 'Sakana', 'OpenRouter', 'Hugging Face'].map((label) => ({ id: label.toLowerCase().replace(/\W/g, ''), label, on: false, method: 'key', models: [] })),
      ],
      // ?local: Ollama connected, LM Studio not running, and an added server whose models can't see images.
      localServers: [
        { id: 'ollama', label: 'Ollama', custom: false, baseUrl: null, on: q.has('local'), note: '' },
        { id: 'lmstudio', label: 'LM Studio', custom: false, baseUrl: null, on: q.has('local'), note: q.has('local') ? "LM Studio isn't running." : '' },
        ...(q.has('local') ? [{ id: 'gpu-box', label: 'GPU box', custom: true, baseUrl: 'http://192.168.1.40:8000/v1', on: true, note: 'None marked as seeing images. Re-add to change.' }] : []),
      ],
      loggingIn: null,
      recent: [
        { at: at - 20e3, kind: 'did', text: 'Saved to memory' },
        { at: at - 25e3, kind: 'did', text: 'Searched the web' },
        { at: at - 30e3, kind: 'ask', text: "what's a good name for the new release?" },
        { at: at - 9 * 60e3, kind: 'bad', text: "Couldn't finish: read budget.xlsx" },
        { at: at - 9.2 * 60e3, kind: 'did', text: 'Looked at your screen' },
        { at: at - 9.4 * 60e3, kind: 'ask', text: 'what does this error mean' },
      ],
      usage: { requests: 14, tokens: 31240 },
      facts: [{ id: 'f1', text: 'Prefers short answers in the morning' }, { id: 'f2', text: 'Working on the J.A.R.V.I.S launch, due end of month' }, { id: 'f3', text: 'Has a cat called Miso' }],
      preferences: [{ id: 'p1', text: 'Starts with the answer, then the detail' }, { id: 'p2', text: 'Runs tests before calling anything done' }, { id: 'p3', text: 'Prefers PowerShell over bash' }],
      summaries: [{ id: 's1', digest: 'Debugging their Rust build', at: at - 864e5 * 1 }, { id: 's2', digest: 'Planning the J.A.R.V.I.S launch', at: at - 864e5 * 3 }, { id: 's3', digest: 'Setting up memory sync between their PCs', at: at - 864e5 * 6 }],
      commitments: [{ id: 'c1', text: 'Send the launch email', when: 'Fri 7 Nov, 10:00', overdue: false }, { id: 'c2', text: 'Book the dentist', when: 'Mon 3 Nov, 09:00', overdue: true }],
      name: 'J.A.R.V.I.S', look: 'jarvis', looks: [['jarvis', 'J.A.R.V.I.S']],
      size: 'default', sizes: [['default', 'Default'], ['small', 'Small'], ['cursor', 'Cursor']],
      replies: 'voice', fishKey: true, fishModel: 'drama-3', fishFree: false,
      // ?tts=gemini / ?tts=elevenlabs: that one as the voice, its key saved.
      tts: ['gemini', 'elevenlabs'].includes(q.get('tts')) ? q.get('tts') : 'fish', geminiKey: q.get('tts') === 'gemini', geminiVoice: 'Kore',
      geminiVoices: [['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm']].map(([id, style]) => ({ id, style })),
      // &shared: speaking with the AI's Gemini key, none saved for the voice.
      geminiShared: new URLSearchParams(location.search).has('shared'), geminiModel: 'gemini-3.8-flash-lite-tts',
      geminiModels: [{ id: 'gemini-3.8-flash-lite-tts', name: 'Flash Lite', per10s: 0.0015 }, { id: 'gemini-3.8-flash-tts', name: 'Flash', per10s: 0.00225 }],
      fishModels: [{ id: 'drama-3', name: 'Drama 3', perM: 50, promo: { perM: 10, until: '2026-12-01T08:00:00Z' } }, { id: 's2.1-pro', name: 'S2.1 Pro', perM: 15 }],
      elevenlabsKey: q.get('tts') === 'elevenlabs',
      elevenVoice: 'JBFqnCBsd6RMkjVDRZzb', elevenVoiceCustom: false,
      elevenVoices: [['JBFqnCBsd6RMkjVDRZzb', 'George · warm British narration'], ['EXAVITQu4vr4xnSDxMaL', 'Sarah · soft American'], ['onwK4e9ZLuTAKqWW03F9', 'Daniel · authoritative British']].map(([id, name]) => ({ id, name })),
      elevenModel: 'eleven_flash_v2_5', elevenModels: ['eleven_flash_v2_5', 'eleven_multilingual_v2'],
      voice: { on: true, keys: 'Ctrl+Alt', ready: true, mac: false, mute: true, mics: [{ id: 'BuiltIn', name: 'MacBook Pro Microphone' }, { id: 'airpods', name: 'AirPods Pro' }], mic: '', micAuto: 'MacBook Pro Microphone', wakeWord: false, wakeName: 'Jarvis', wakeProblem: false, download: null, mode: 'handsfree', vad: { pause: 1.5, sensitivity: 'normal' } }, askKeys: '⌥⌘', aware: { on: true, mode: 'front', private: false, exclusions: ['1password', 'logonui', 'InPrivate', 'my bank'] }, brief: { on: true, todoist: false, canTodoist: true }, focus: { until: null, task: '', list: ['YouTube', 'Reddit', 'X', 'Steam', 'Netflix'], custom: false }, sync: { dir: '', at: null, error: null, paused: false }, shortcuts: { talk: { value: 'control+option', pairs: [['control+option', 'Control+Option'], ['option+command', 'Option+Command'], ['control+command', 'Control+Command'], ['control+shift', 'Control+Shift'], ['option+shift', 'Option+Shift']] }, keys: [{ id: 'summon', words: 'Control+Option+S' }, { id: 'snap', words: 'Control+Option+A' }, { id: 'list', words: 'Control+Option+L' }] }, writeKeys: { value: 'option+command', pairs: [['option+command', 'Option+Command'], ['control+command', 'Control+Command'], ['control+shift', 'Control+Shift'], ['option+shift', 'Option+Shift']] },
      sound: false, actions: false, brief: false, localAwareness: true, studioListening: false, login: { on: true },
      intro: false,
    };
    if (q.has('busy')) Object.assign(s, { busy: true, status: { state: 'busy', text: 'Reading notes.md' } });
    if (q.has('empty')) Object.assign(s, { recent: [], facts: [], commitments: [], preferences: [], summaries: [], usage: null });
    if (q.has('many')) {
      const things = ['Prefers short answers', 'Drinks oat flat whites', 'Works late on Thursdays', 'Has a cat called Miso', 'Training for a 10k in March', 'Learning Japanese', 'Uses Figma for design', 'Ships on Fridays', 'Allergic to peanuts', 'Sister is called Ana'];
      s.facts = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, text: `${things[i % things.length]}${i >= things.length ? ` (${Math.floor(i / things.length) + 1})` : ''}` }));
      s.commitments = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, text: `Follow up on item ${i + 1}`, when: 'Fri 7 Nov, 10:00', overdue: i < 2 }));
      s.recent = Array.from({ length: 30 }, (_, i) => ({ ...s.recent[i % s.recent.length], at: at - i * 70e3 }));
    }
    // ?problem: an error was shown earlier (About gets Copy last error). ?note=bad: a failed save, with Copy details.
    if (q.has('problem') || q.get('note') === 'bad') s.problem = { code: 'E30', at };
    if (q.get('note') === 'bad') setTimeout(() => window.__panel({ kind: 'note', text: "That key didn't save (E30). Try again.", bad: true, copy: true }), 400);
    // ?studio: VoiceStudio is the voice provider (?studio=off: it isn't running; ?studio=engine: its engine isn't ready; ?studio=empty: no saved voices).
    const STUDIO = {
      on: { ok: true, engine: 'OmniVoice', voices: [{ id: 'a642d572', name: 'Ben' }, { id: 'fa08aff1', name: 'British · Female · Young Adult · High' }], voice: 'fa08aff1' },
      empty: { ok: true, engine: 'KittenTTS', voices: [], voice: null },
      off: { ok: false, reason: 'offline', message: 'Run VoiceStudio first.' },
      engine: { ok: false, reason: 'engine', message: "VoiceStudio's voice engine isn't ready (CosyVoice): not installed. Pick or install an engine in VoiceStudio, then press Check again." },
    };
    if (q.has('studio')) Object.assign(s, { tts: 'voicestudio', studio: STUDIO[q.get('studio')] ?? STUDIO.on });
    if (q.get('tab')) setTimeout(() => { if (q.get('mtab')) ui.mtab = q.get('mtab'); show(q.get('tab')); }, 0);
    setTimeout(() => window.__panel({ kind: 'state', state: s }), 0);
    return async (cmd, args) => {
      if (cmd !== 'sidecar_send') return null;
      console.log('[preview] would send', JSON.stringify(args.msg));
      if (args.msg?.type === 'copy_problem') setTimeout(() => window.__panel({ kind: 'copied', which: 'problem', ok: q.get('copy') !== 'fail' }), 150);
      const id = args.msg?.id ?? '';
      if (id.startsWith('size:')) { s.size = id.slice(5); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('tts:')) { s.tts = id.slice(4); s.studio = s.tts === 'voicestudio' ? STUDIO[q.get('studio')] ?? STUDIO.on : null; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('studiovoice:') && s.studio) { s.studio.voice = id.slice(12) === 'default' ? null : id.slice(12); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      return null;
    };
  }
})();
