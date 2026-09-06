// L4 — UI. A surface we own outright. Knows nothing about YouTube.
// No innerHTML / outerHTML / insertAdjacentHTML anywhere (Trusted Types). Nodes only.
//
// ── Direction ───────────────────────────────────────────────────────────────
// THESIS    A command palette, not a picker. 256 playlists means you type, you
//           don't scroll — so the search field is the largest thing on the sheet
//           and the dialog's own name is just a label above it. Refuses the
//           stacked-chrome dialog (title / meta / status / input / list) it replaces.
// WORLD     Achromatic. One ground, one foreground, three opacity steps, one
//           hairline weight. Inset rounded rows, no boxes around controls, no
//           borders doing work a space could do. Colour exists in exactly two
//           places: jade when a save lands, red when one fails.
// STATE     `member` is tri-state and mostly unknown — YouTube no longer tells us
//           what a video is already in. So both `undefined` and `false` render
//           bare: an unmarked row claims nothing, it is simply a target. Only
//           `member === true` earns a mark. State lives in a fixed-width column
//           flush right, so the left edge stays a single clean text column and
//           the ~255 default rows carry no chrome at all. Jade is reserved for
//           saves made in this session, and those keep a resting field rather
//           than a fading toast — they are the only membership we can vouch for.
// VIEWPORT  Label + video id, the search field, hairline, the list, hairline, a
//           status line with ↑↓ ⏎ hints. Query text and result text share one
//           left edge at 16px. Top-anchored, so the field never moves; the sheet
//           grows down to a ceiling and shrinks as the query narrows.
// MOTION    One entrance (@starting-style, 160ms) and one payoff (the check draws
//           itself in 340ms). Everything else is a 120ms colour change.
// ────────────────────────────────────────────────────────────────────────────

const PLS_MAX_ROWS = 200;
const PLS_LOAD_PATIENCE = 8000;
const PLS_SVGNS = 'http://www.w3.org/2000/svg';
const PLS_CHECK = 'M3.4 7.4 5.9 10 10.6 4.3';
const PLS_CROSS = 'M4 4 10 10M10 4 4 10';

// Wrap emoji runs so they stop out-shouting the text they sit beside.
let PLS_EMOJI = null;
try { PLS_EMOJI = new RegExp('\\p{RGI_Emoji}', 'gv'); } catch { /* older engine: skip */ }

const PLS_CSS = `
:host { all: initial; }
:host {
  color-scheme: light dark;
  --bg:#16171a; --fg:#ebecee;
  --fg-2:rgba(235,236,238,.62); --fg-3:rgba(235,236,238,.54);
  --line:rgba(255,255,255,.1); --line-lit:rgba(255,255,255,.22);
  --edge:rgba(255,255,255,.09);
  --row-h: 35px;
  --hov:rgba(255,255,255,.05); --act:rgba(255,255,255,.09);
  --cursor:rgba(235,236,238,.18);
  --ring:rgba(235,236,238,.5); --sel:rgba(235,236,238,.2);
  --thumb:rgba(255,255,255,.16);
  --ok:#3ad39a; --bad:#f2726a;
  --lift:0 1px 2px rgba(0,0,0,.5), 0 24px 64px -18px rgba(0,0,0,.8);
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif,
         "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji";
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: light) { :host {
  --bg:#fff; --fg:#16181c;
  --fg-2:rgba(22,24,28,.68); --fg-3:rgba(22,24,28,.6);
  --line:rgba(0,0,0,.1); --line-lit:rgba(0,0,0,.26);
  --edge:rgba(0,0,0,.07);
  --hov:rgba(0,0,0,.04); --act:rgba(0,0,0,.065);
  --cursor:rgba(22,24,28,.2);
  --ring:rgba(22,24,28,.5); --sel:rgba(22,24,28,.14);
  --thumb:rgba(0,0,0,.18);
  /* deep enough to clear 4.5:1 against its own tinted row field, not just white */
  --ok:#0a6f4f; --bad:#c2382f;
  --lift:0 1px 2px rgba(16,18,22,.1), 0 20px 52px -18px rgba(16,18,22,.3);
} }

[hidden] { display: none !important; }

/* Deliberately NOT 'all: initial' here — that would nuke the UA dialog rules
   (top-layer placement, display:none when closed). The :host reset above is
   what keeps YouTube's inherited styles out.
   Top-anchored rather than centred: the field must hold one screen position for
   the whole interaction, so narrowing the query only moves the bottom edge. */
dialog {
  box-sizing: border-box; margin: 10vh auto auto; padding: 0;
  width: 464px; max-width: calc(100vw - 32px);
  /* bottom:auto is load-bearing — the UA's inset:0 would otherwise stretch an
     auto height to the full viewport and the sheet could never size to content. */
  bottom: auto; height: auto; max-height: min(76vh, 640px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg); color: var(--fg);
  font: 400 14px/1.45 var(--sans);
  border: 1px solid var(--edge); border-radius: 14px;
  box-shadow: var(--lift);
  transition: opacity .16s ease, transform .16s cubic-bezier(.2,.8,.2,1);
}
dialog:not([open]) { display: none; }
@starting-style { dialog[open] { opacity: 0; transform: translateY(6px) scale(.99); } }
dialog::backdrop {
  background: rgba(6,7,9,.62);
  backdrop-filter: blur(3px) saturate(.85);
  transition: opacity .16s ease;
}
@starting-style { dialog[open]::backdrop { opacity: 0; } }
@media (prefers-color-scheme: light) { dialog::backdrop { background: rgba(18,20,26,.28); } }
dialog ::selection { background: var(--sel); }

/* ── header ───────────────────────────────────────────────────────────────── */
.head { flex: none; padding: 14px 16px 12px; }
.brow { display: flex; align-items: center; gap: 7px; height: 22px; }
.title { font-size: 12px; font-weight: 500; letter-spacing: .005em; color: var(--fg-2); }
.vid {
  min-width: 0; font: 400 11px/1 var(--mono); letter-spacing: -.01em; color: var(--fg-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.vid::before { content: "·"; margin-right: 7px; opacity: .5; }
.x {
  all: initial; margin-left: auto; margin-right: -5px; flex: none;
  display: grid; place-items: center; width: 26px; height: 26px;
  border-radius: 7px; cursor: pointer; color: var(--fg-3);
  transition: color .12s ease, background-color .12s ease;
}
.x:hover { color: var(--fg); background: var(--hov); }
.x:focus-visible { outline: 2px solid var(--ring); outline-offset: -1px; }

.find { display: flex; align-items: baseline; gap: 12px; padding-top: 7px; }
input {
  all: initial; flex: 1 1 auto; min-width: 0;
  font: 400 17px/1.35 var(--sans); letter-spacing: -.006em;
  color: var(--fg); caret-color: var(--fg);
}
input::placeholder { color: var(--fg-3); }
.count {
  flex: none; font: 400 11.5px/1 var(--sans); font-variant-numeric: tabular-nums;
  letter-spacing: .01em; color: var(--fg-3);
}

/* ── list ─────────────────────────────────────────────────────────────────── */
.list {
  position: relative; flex: 1 1 auto; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain; padding: 6px;
  border-top: 1px solid var(--line); transition: border-color .18s ease;
  scrollbar-width: thin; scrollbar-color: var(--thumb) transparent;
}
.head:has(input:focus) + .list { border-top-color: var(--line-lit); }

.row {
  all: initial; box-sizing: border-box; position: relative;
  display: grid; grid-template-columns: minmax(0,1fr) auto;
  align-items: center; column-gap: 10px;
  width: 100%; min-height: var(--row-h); padding: 8px 10px; border-radius: 8px;
  font: 400 14px/1.35 var(--sans); color: var(--fg); cursor: pointer;
  --field: transparent; background: var(--field);
  transition: background-color .12s ease, color .12s ease;
}
/* One field per row, resolved in cascade order: resting, then hover. The
   :where() keeps the keyboard-mode guard from outranking the states below it.
   A saved or in-flight row is not actionable (pick() returns early), so it gets
   no hover affordance and no pointer — its field is a fact, not a target. */
.row.done { --field: color-mix(in srgb, var(--ok) 11%, transparent); }
.row.done, .row.busy { cursor: default; }
:where(.list:not(.kb)) .row:not(.done):hover { --field: var(--hov); }
/* The cursor is a ring — always the same ring, so it reads on top of a row that
   already carries a state field instead of fighting it for saturation. */
.row.on { box-shadow: inset 0 0 0 1px var(--cursor); }
.row.on:not(.done) { --field: var(--act); }
.row.on .t, .row.done .t { font-weight: 500; }
.row:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }

.t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.emo { font-size: .9em; line-height: 1; letter-spacing: .02em; }
.row.mem .t { color: var(--fg-2); }
.row.mem:hover .t, .row.mem.on .t { color: var(--fg); }

/* State column: label then mark, cluster flush right. The mark box is a fixed
   14px whether or not it holds anything, so marks stack in a true column. */
.state { display: flex; align-items: center; gap: 8px; color: var(--fg-3); }
.gut { display: grid; place-items: center; width: 14px; height: 14px; flex: none; }
.mark { display: block; width: 14px; height: 14px; fill: none; stroke: currentColor;
        stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.tag { flex: none; font: 500 11.5px/1 var(--sans); letter-spacing: .01em; }
.row.busy .gut { animation: pulse 1.15s ease-in-out infinite; }
.row.done .state { color: var(--ok); }
.row.done .tag { font-weight: 600; }
.row.fail .state { color: var(--bad); }
.row.flash .mark { stroke-dasharray: 12; stroke-dashoffset: 12;
                   animation: draw .34s cubic-bezier(.3,.9,.3,1) forwards; }
.row.flash { animation: land .45s ease-out; }

.note { padding: 52px 20px; text-align: center; color: var(--fg-3); font-size: 13px; line-height: 1.6; }
.note .q { color: var(--fg); font-weight: 500; }
.more { padding: 14px 10px 8px; text-align: center; color: var(--fg-3); font-size: 11.5px; }

/* Same height as a real row, so the list resolves into place instead of popping. */
.sk { display: flex; align-items: center; height: var(--row-h); padding: 0 10px; }
.sk i { display: block; height: 9px; border-radius: 4px;
        background: currentColor; animation: shimmer 1.9s ease-in-out infinite; }
.sk:nth-child(7n+1) i { width: 61%; animation-delay: 0s }
.sk:nth-child(7n+2) i { width: 44%; animation-delay: .1s }
.sk:nth-child(7n+3) i { width: 72%; animation-delay: .2s }
.sk:nth-child(7n+4) i { width: 38%; animation-delay: .3s }
.sk:nth-child(7n+5) i { width: 56%; animation-delay: .4s }
.sk:nth-child(7n+6) i { width: 67%; animation-delay: .5s }
.sk:nth-child(7n+7) i { width: 47%; animation-delay: .6s }

/* ── footer ───────────────────────────────────────────────────────────────── */
.foot {
  flex: none; display: flex; align-items: center; gap: 14px;
  padding: 9px 16px 10px; border-top: 1px solid var(--line);
  font: 400 11.5px/1.5 var(--sans); color: var(--fg-3);
}
.status { flex: 1 1 auto; min-width: 0; overflow: hidden;
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.keys { flex: none; display: flex; gap: 10px; letter-spacing: .015em; }

@keyframes draw   { to { stroke-dashoffset: 0 } }
@keyframes pulse  { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
@keyframes shimmer{ 0%,100% { opacity: .045 } 50% { opacity: .09 } }
/* No 'to' — it settles into whatever field the row now rests at. */
@keyframes land   { from { background-color: color-mix(in srgb, var(--ok) 34%, transparent) } }
/* Every state still reads without motion: each one carries a word as well as a
   mark, so nothing here is the sole carrier of meaning. */
@media (prefers-reduced-motion: reduce) {
  dialog, dialog::backdrop, .row, .x, .list { transition-duration: 1ms; }
  .row.flash, .row.busy .gut, .sk i { animation: none; }
  /* killing the draw must not leave the stroke dashed out of existence */
  .row.flash .mark { animation: none; stroke-dasharray: none; }
}
`;

function plsEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function plsIcon(d) {
  const svg = document.createElementNS(PLS_SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('class', 'mark');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(PLS_SVGNS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

// Text nodes + spans only — never a string sink.
function plsWriteTitle(node, text) {
  if (!PLS_EMOJI) { node.textContent = text; return; }
  let last = 0;
  for (const m of text.matchAll(PLS_EMOJI)) {
    if (m.index > last) node.append(text.slice(last, m.index));
    node.append(plsEl('span', 'emo', m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) node.append(text.slice(last));
  if (!node.firstChild) node.textContent = text;
}

// onPick(playlist) -> Promise. onClose() fires exactly once.
function plsCreateSheet({ videoId, onPick, onClose }) {
  const uid = 'pls' + Math.random().toString(36).slice(2, 8);
  const host = document.createElement('pls-save-sheet');
  const shadow = host.attachShadow({ mode: 'closed' });
  const css = new CSSStyleSheet();
  css.replaceSync(PLS_CSS);
  shadow.adoptedStyleSheets = [css];

  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-labelledby', uid + '-t');

  const title = plsEl('div', 'title', 'Save to playlist');
  title.id = uid + '-t';
  const closeBtn = plsEl('button', 'x');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.append(plsIcon(PLS_CROSS));
  const brow = plsEl('div', 'brow');
  brow.append(title, plsEl('div', 'vid', videoId), closeBtn);

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Search playlists';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Search playlists');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', uid + '-l');
  const count = plsEl('div', 'count');
  const find = plsEl('div', 'find');
  find.append(input, count);

  const head = plsEl('div', 'head');
  head.append(brow, find);

  const list = plsEl('div', 'list');
  list.id = uid + '-l';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Your playlists');

  const status = plsEl('div', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const keys = plsEl('div', 'keys');
  keys.append(plsEl('span', null, '↑↓ move'), plsEl('span', null, '⏎ save'));
  keys.hidden = true;
  const foot = plsEl('div', 'foot');
  foot.append(status, keys);

  dlg.append(head, list, foot);
  shadow.append(dlg);
  document.documentElement.append(host);

  let data = [];                 // {id, title, member}
  const state = new Map();       // id -> 'adding' | 'added' | 'error'
  let dead = false;
  let loaded = false;
  let patience = false;          // load took long enough to stop promising rows
  let shown = [];                // playlists currently rendered
  let nodes = [];                // row elements, parallel to `shown`
  let active = 0;
  let lastQ = null;

  const patienceTimer = setTimeout(() => { patience = true; render(); }, PLS_LOAD_PATIENCE);

  function destroy() {
    if (dead) return;
    dead = true;
    clearTimeout(patienceTimer);
    host.remove();
    onClose?.();
  }

  function rowNode(p, i) {
    const st = state.get(p.id);
    // Tri-state: only an explicit `true` is a claim. `false` and `undefined`
    // both render bare — we will not draw an affordance for an answer we do
    // not have, and an unmarked row is simply a target.
    const known = p.member === true;
    const b = plsEl('button', 'row');
    b.type = 'button';
    b.id = uid + '-r' + i;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', 'false');

    const t = plsEl('span', 't');
    plsWriteTitle(t, p.title);
    const gut = plsEl('span', 'gut');
    const cell = plsEl('span', 'state');
    b.append(t, cell);

    if (st === 'adding') {
      b.classList.add('busy');
      gut.append(plsIcon(PLS_CHECK));
      cell.append(plsEl('span', 'tag', 'Saving'));
    } else if (st === 'added') {
      b.classList.add('done');
      gut.append(plsIcon(PLS_CHECK));
      cell.append(plsEl('span', 'tag', 'Saved'));
    } else if (st === 'error') {
      b.classList.add('fail');
      gut.append(plsIcon(PLS_CROSS));
      cell.append(plsEl('span', 'tag', 'Failed'));
    } else if (known) {
      b.classList.add('mem');
      gut.append(plsIcon(PLS_CHECK));
      cell.append(plsEl('span', 'tag', 'Already in'));
    }
    cell.append(gut);

    b.title = st === 'error'
      ? p.title + ' — couldn’t be saved. Click to try again.'
      : p.title;
    b.addEventListener('click', () => { active = i; paint(false); pick(p); });
    return b;
  }

  function note(cls, ...kids) {
    const n = plsEl('div', cls);
    n.setAttribute('role', 'presentation');
    n.append(...kids);
    return n;
  }

  function skeletons() {
    return Array.from({ length: 13 }, () => note('sk', document.createElement('i')));
  }

  function render() {
    if (dead) return;
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    const fresh = q !== lastQ;
    const keepScroll = fresh ? 0 : list.scrollTop;
    lastQ = q;

    const matches = q ? data.filter((p) => p.title.toLowerCase().includes(q)) : data;
    shown = matches.slice(0, PLS_MAX_ROWS);
    nodes = shown.map(rowNode);

    const kids = [...nodes];
    if (!loaded && !patience) kids.push(...skeletons());
    else if (!loaded) kids.push(note('note', 'No playlists loaded.'));
    else if (!data.length) kids.push(note('note', 'You don’t have any playlists yet.'));
    else if (!matches.length) {
      kids.push(note('note', 'No playlist matches ', plsEl('span', 'q', '“' + raw + '”')));
    } else if (matches.length > shown.length) {
      kids.push(note('more', matches.length - shown.length + ' more — keep typing to narrow'));
    }
    list.replaceChildren(...kids);

    count.textContent = q && loaded ? `${matches.length} of ${data.length}` : '';
    keys.hidden = !shown.length;
    active = fresh ? 0 : Math.min(active, Math.max(0, shown.length - 1));
    list.scrollTop = keepScroll;
    paint(false);
  }

  function paint(scroll) {
    nodes.forEach((n, i) => {
      const on = i === active;
      n.classList.toggle('on', on);
      n.setAttribute('aria-selected', String(on));
    });
    const cur = nodes[active];
    input.setAttribute('aria-activedescendant', cur ? cur.id : '');
    if (!scroll || !cur) return;
    const top = cur.offsetTop;
    const bottom = top + cur.offsetHeight;
    if (top - 6 < list.scrollTop) list.scrollTop = top - 6;
    else if (bottom + 6 > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom + 6 - list.clientHeight;
    }
  }

  function move(delta) {
    if (!shown.length) return;
    active = Math.max(0, Math.min(shown.length - 1, active + delta));
    list.classList.add('kb');
    paint(true);
  }

  async function pick(p) {
    const cur = state.get(p.id);
    if (cur === 'adding' || cur === 'added') return;
    state.set(p.id, 'adding');
    render();
    try {
      await onPick(p);
      if (dead) return;
      state.set(p.id, 'added');
      render();
      const i = shown.findIndex((x) => x.id === p.id);
      if (i > -1) nodes[i].classList.add('flash');
    } catch (e) {
      console.warn('[pls] add failed', p.id, e);
      if (dead) return;
      state.set(p.id, 'error');
      render();
      status.textContent = `Couldn’t save to “${p.title}” — select it again to retry.`;
    }
  }

  input.addEventListener('input', render);
  list.addEventListener('pointermove', () => list.classList.remove('kb'), { passive: true });
  closeBtn.addEventListener('click', () => dlg.close());
  dlg.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'PageDown') move(8);
    else if (e.key === 'PageUp') move(-8);
    else if (e.key === 'Home') move(-shown.length);
    else if (e.key === 'End') move(shown.length);
    else if (e.key === 'Enter') { if (shown[active]) pick(shown[active]); }
    else return;
    e.preventDefault();
  });
  // Outside-click dismissal: a modal dialog reports backdrop clicks as its own,
  // so compare against its box rather than trusting the target alone.
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right ||
        e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
  dlg.addEventListener('close', destroy);

  render();
  dlg.showModal();
  input.focus();

  return {
    setStatus: (t) => { if (!dead) status.textContent = t; },
    setData: (rows) => {
      data = rows;
      loaded = true;
      clearTimeout(patienceTimer);
      input.placeholder = rows.length ? `Search ${rows.length} playlists` : 'Search playlists';
      render();
    },
    destroy,
    get dead() { return dead; },
  };
}
