// Page-side instrumentation, injected with page.addInitScript (nothing here is bundled into the app).
// Exposes window.__perf. The WS tap wraps window.WebSocket; the indicator tap watches `.mw-chat__conn[data-state]`.
export const INSTRUMENT = `(() => {
  const P = (window.__perf = { ws: [], conn: [], cls: [], lt: [], loaf: [], ev: [], csp: 0, errors: [] });
  const now = () => performance.now();
  const Orig = window.WebSocket;
  function Tap(url, protocols) {
    const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
    const rec = { url: String(url), kind: String(url).includes('/inbox/') ? 'inbox' : 'chat', t0: now(), open: null, close: null, code: null };
    P.ws.push(rec);
    ws.addEventListener('open', () => { rec.open = now(); });
    ws.addEventListener('close', (e) => { rec.close = now(); rec.code = e.code; });
    return ws;
  }
  Tap.prototype = Orig.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Tap[k] = Orig[k];
  window.WebSocket = Tap;

  let lastState = null;
  const readConn = () => {
    const el = document.querySelector('.mw-chat__conn');
    const st = el ? el.getAttribute('data-state') : null;
    if (st !== lastState) { lastState = st; P.conn.push({ t: now(), state: st }); }
  };
  const hit = (n) => n.nodeType === 1 && (n.classList.contains('mw-chat__conn') || (n.firstElementChild && n.querySelector('.mw-chat__conn')));
  const mo = new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === 'attributes') { if (r.target.classList && r.target.classList.contains('mw-chat__conn')) readConn(); }
      else { for (const n of r.addedNodes) if (hit(n)) { readConn(); break; } for (const n of r.removedNodes) if (hit(n)) { readConn(); break; } }
    }
  });
  const startMo = () => mo.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  startMo();

  const po = (type, cb, extra) => { try { new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true, ...extra }); } catch (e) { P.errors.push(type + ':' + e); } };
  po('layout-shift', (e) => { if (!e.hadRecentInput) P.cls.push({ t: e.startTime, v: e.value }); });
  po('longtask', (e) => P.lt.push({ t: e.startTime, d: e.duration }));
  po('long-animation-frame', (e) => P.loaf.push({ t: e.startTime, d: e.duration, b: e.blockingDuration }));
  po('event', (e) => { if (e.interactionId > 0) P.ev.push({ name: e.name, t: e.startTime, d: e.duration, id: e.interactionId }); }, { durationThreshold: 16 });
  document.addEventListener('securitypolicyviolation', () => { P.csp++; });

  P.now = now;
  P.get = (name) => P[name];
  P.rowCount = (n) => document.querySelectorAll('.mw-chatrow').length >= n;
  P.inboxOpen = () => P.ws.some((w) => w.kind === 'inbox' && w.open);
  P.logHas = (s) => { const l = document.querySelector('.mw-chat__log'); return !!l && l.textContent.includes(s); };
  P.stateIs = (s) => { const e = document.querySelector('.mw-chat__conn'); return !!e && e.getAttribute('data-state') === s; };
  P.tabReturn = () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); };
  P.watchEmpty = () => { P.emptySeen = false; P.stopE = false; (function t() { if (document.querySelector('.mw-emptychats')) P.emptySeen = true; if (!P.stopE) requestAnimationFrame(t); })(); };
  P.stopEmpty = () => { P.stopE = true; return P.emptySeen; };
  // number of i in 0..4 for which log contains prefix+i
  P.countIn = (prefix) => [0, 1, 2, 3, 4].filter((i) => P.logHas(prefix + i)).length;
  P.back = () => { const b = document.querySelector('.mw-chat__back'); if (!b) return false; b.click(); return true; };
  P.hasAria = (prefix) => { const l = document.querySelector('.mw-chat__log'); return !!l && !!l.querySelector('[aria-label^="' + prefix + '"]'); };
  P.composer = () => document.querySelector('.mw-composer__input');
  P.tagComposer = () => { const c = P.composer(); if (!c) return false; c.__perfTag = 1; return true; };
  P.focusComposer = (draft) => { const c = P.composer(); c.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(c, draft); c.dispatchEvent(new Event('input', { bubbles: true })); return document.activeElement === c; };
  P.composerState = () => { const c = P.composer(); return { present: !!c, focused: !!c && document.activeElement === c, sameNode: !!c && c.__perfTag === 1, value: c ? c.value : null }; };
  P.occurrences = (s) => { const l = document.querySelector('.mw-chat__log'); return l ? l.textContent.split(s).length - 1 : 0; };
  P.row = (title) => [...document.querySelectorAll('.mw-chatrow')].find((b) => { const n = b.querySelector('.mw-chatrow__name'); return n && n.textContent.includes(title); });
  // Click a sidebar row (programmatic click: the React onClick runs exactly as for a real one) and resolve with the
  // ms until a frame in which the chat log contains the chat's marker; -1 on timeout.
  P.switchTo = (title, marker, timeout = 8000) => new Promise((resolve) => {
    const row = P.row(title);
    if (!row) { resolve(-2); return; }
    const t0 = now();
    performance.mark('switch');
    row.click();
    const tick = () => {
      const log = document.querySelector('.mw-chat__log');
      if (log && log.textContent.includes(marker)) { resolve(now() - t0); return; }
      if (now() - t0 > timeout) { resolve(-1); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  P.waitState = (state, timeout = 5000) => new Promise((resolve) => {
    const t0 = now();
    const tick = () => {
      const el = document.querySelector('.mw-chat__conn');
      if (el && el.getAttribute('data-state') === state) { resolve(now() - t0); return; }
      if (now() - t0 > timeout) { resolve(-1); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
})();`;
