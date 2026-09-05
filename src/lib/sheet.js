// L4 — UI. A surface we own outright. Knows nothing about YouTube.
// Zero HTML-string sinks anywhere — YouTube enforces require-trusted-types-for
// 'script'. Every node is built with createElement / createElementNS /
// textContent / append. Nodes only, no exceptions.
//
// ── Direction ───────────────────────────────────────────────────────────────
// THESIS    A command palette, not a picker. 256 playlists means you type, you
//           don't scroll — so the field IS the sheet's title and there is no
//           other title. Nothing sits above the query: no label row, no eyebrow,
//           no stacked chrome. The placeholder names the job ("Save to playlist")
//           until the library lands, then names the tool ("Search 256 playlists")
//           and gets out of the way.
// WORLD     Achromatic. One ground, one foreground, three opacity steps, one
//           hairline weight, one 14px icon family at one stroke. Colour exists in
//           exactly two places: jade when a save lands, red when one fails.
//           Depth is a 1px inset sheen and a three-stop shadow — no glass, no
//           glow, no gradient. Restraint is the whole aesthetic.
// SEARCH    The matched run of every title is marked. In a palette this is the
//           difference between a filter and a search: you see *why* a row
//           survived. Marking is achromatic (a foreground wash), built from
//           text nodes and spans, held back until the query is two characters
//           (one matches everything, so the marks become confetti), and skipped
//           whenever the index maths is not provably safe — case-folding that
//           changes length, or a boundary that would split a surrogate pair.
// STATE     `member` is tri-state and mostly unknown — YouTube stops telling us
//           past ~200 playlists. So `undefined` and `false` render identically
//           and bare: an unmarked row claims nothing, it is simply a target.
//           Only `member === true` earns a mark, and it earns a *quiet* one —
//           a muted check and an unweighted "Already in", title dimmed, no
//           hover and no pointer, because it is not a target: this build has no
//           remove path and YouTube would accept a duplicate. Session events —
//           Saving, Saved, Retry — get the same slot in bold and in colour.
//           Permanent facts whisper; events speak. Every state carries a word as
//           well as a mark, so colour is never the sole carrier.
// VIEWPORT  Field + count + close · hairline · list · hairline · status bar.
//           Query text, result text, and the status bar share one left edge at
//           20px. The count right of the field is empty until you type, then
//           reports the yield — at rest the field owns the whole header. What
//           you are saving is named at the far left of the status bar, elided
//           and capped at half the bar so it can never crowd out the status;
//           it arrives a beat after the sheet, because the sheet must open on
//           intent and wait for nothing. The raw video id is developer data and
//           is not shown at all — it lives on the host element for the console
//           and the e2e specs. Top-anchored, so the field never moves; the sheet
//           grows down to a ceiling and shrinks as the query narrows.
// MOTION    One entrance (@starting-style, 220ms), one payoff (the check draws
//           itself in 360ms while the row's field flashes jade and settles), one
//           honest spinner while a save is in flight. Everything else is a 130ms
//           colour change. Exponential ease-out throughout — no overshoot, no
//           bounce. And no weight changes on hover or cursor: reflowing a
//           clipped title under the arrow keys is a defect, not a flourish.
// ────────────────────────────────────────────────────────────────────────────

const PLS_MAX_ROWS = 200;
const PLS_LOAD_PATIENCE = 8000;
const PLS_SVGNS = 'http://www.w3.org/2000/svg';
const PLS_PAD = 8; // .list padding, and the scroll margin the cursor keeps
const PLS_MIN_HL = 2; // shortest query worth marking inside a title
const PLS_CHECK = 'M3.6 7.35 5.95 9.75 10.5 4.35';
const PLS_CROSS = 'M4.3 4.3 9.7 9.7M9.7 4.3 4.3 9.7';

// Wrap emoji runs so they stop out-shouting the text they sit beside.
let PLS_EMOJI = null;
try { PLS_EMOJI = new RegExp('\\p{RGI_Emoji}', 'gv'); } catch { /* older engine: skip */ }

const PLS_CSS = `
:host { all: initial; }
:host {
  color-scheme: light dark;

  /* Ground and ink. Three steps only; --fg-3 is pinned to the lowest alpha that
     still clears 4.5:1 on the row field it actually sits on, not on the ground. */
  --bg:#131417; --fg:#eceef1;
  --fg-2:rgba(236,238,241,.72);
  --fg-3:rgba(236,238,241,.55);

  --line:rgba(255,255,255,.075);
  --edge:rgba(255,255,255,.10);
  --sheen:rgba(255,255,255,.09);

  --hov:rgba(255,255,255,.048);
  --act:rgba(255,255,255,.088);
  --hit:rgba(255,255,255,.13);
  --skel:rgba(255,255,255,.075);
  --thumb:rgba(255,255,255,.15);
  --ring:rgba(236,238,241,.6);
  --sel:rgba(236,238,241,.24);

  --ok:#4cdea1; --bad:#ff7d72;
  --lift:
    0 1px 1px rgba(0,0,0,.30),
    0 10px 24px -10px rgba(0,0,0,.55),
    0 36px 80px -28px rgba(0,0,0,.72);

  /* State fields, resolved where they are used so they follow whichever
     --ok/--bad is live. The tint depths are per-theme: a dark ground swallows a
     wash and a light one does not, and the deeper field a row wears under the
     cursor is the case that decides whether its coloured label still clears
     4.5:1. (No backticks in here — this whole block is a template literal.) */
  --f-ok:color-mix(in srgb, var(--ok) 13%, transparent);
  --f-ok-on:color-mix(in srgb, var(--ok) 22%, transparent);
  --f-bad:color-mix(in srgb, var(--bad) 10%, transparent);
  --f-bad-on:color-mix(in srgb, var(--bad) 18%, transparent);

  --row-h:36px;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif,
         "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji";
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: light) { :host {
  --bg:#fff; --fg:#14161a;
  --fg-2:rgba(20,22,26,.72);
  --fg-3:rgba(20,22,26,.60);

  --line:rgba(0,0,0,.08);
  --edge:rgba(0,0,0,.09);
  --sheen:transparent;      /* a white sheet has no lit top edge to fake */

  --hov:rgba(0,0,0,.04);
  --act:rgba(0,0,0,.07);
  --hit:rgba(0,0,0,.10);
  --skel:rgba(0,0,0,.07);
  --thumb:rgba(0,0,0,.2);
  --ring:rgba(20,22,26,.55);
  --sel:rgba(20,22,26,.15);

  /* Deep enough to clear 4.5:1 against their own tinted row fields — including
     the deeper field a row wears under the cursor — not against white. */
  --ok:#096546; --bad:#a82c22;
  --f-ok:color-mix(in srgb, var(--ok) 9%, transparent);
  --f-ok-on:color-mix(in srgb, var(--ok) 16%, transparent);
  --f-bad:color-mix(in srgb, var(--bad) 8%, transparent);
  --f-bad-on:color-mix(in srgb, var(--bad) 14%, transparent);
  --lift:
    0 1px 1px rgba(14,16,22,.06),
    0 8px 20px -8px rgba(14,16,22,.14),
    0 30px 64px -24px rgba(14,16,22,.26);
} }

[hidden] { display: none !important; }

/* Deliberately NOT 'all: initial' here — that would nuke the UA dialog rules
   (top-layer placement, display:none when closed). The :host reset above is
   what keeps YouTube's inherited styles out.
   Top-anchored rather than centred: the field must hold one screen position for
   the whole interaction, so narrowing the query only moves the bottom edge. */
dialog {
  box-sizing: border-box; margin: 9vh auto auto; padding: 0;
  width: 520px; max-width: calc(100vw - 32px);
  /* bottom:auto is load-bearing — the UA's inset:0 would otherwise stretch an
     auto height to the full viewport and the sheet could never size to content. */
  bottom: auto; height: auto; max-height: min(78vh, 620px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg); color: var(--fg);
  font: 400 14px/1.45 var(--sans);
  -webkit-font-smoothing: antialiased;
  border: 1px solid var(--edge); border-radius: 16px;
  /* Outer three-stop ramp for depth, plus a 1px lit top edge for material. */
  box-shadow: var(--lift), inset 0 1px 0 var(--sheen);
  transition: opacity .18s ease, transform .22s cubic-bezier(.16,1,.3,1);
}
dialog:not([open]) { display: none; }
@starting-style { dialog[open] { opacity: 0; transform: translateY(10px) scale(.985); } }
/* ::backdrop did not inherit custom properties from its originator until late
   Chrome, so these two rules stay literal on purpose. */
dialog::backdrop {
  background: rgba(6,7,10,.58);
  backdrop-filter: blur(6px) saturate(.9);
  transition: opacity .18s ease;
}
@starting-style { dialog[open]::backdrop { opacity: 0; } }
@media (prefers-color-scheme: light) { dialog::backdrop {
  background: rgba(16,18,24,.28); backdrop-filter: blur(4px) saturate(.95);
} }
dialog ::selection { background: var(--sel); }

/* ── header: the field is the title, so nothing sits above it ─────────────── */
.head {
  flex: none; display: flex; align-items: center; gap: 12px;
  padding: 15px 20px 14px; border-bottom: 1px solid var(--line);
}
input {
  all: initial; flex: 1 1 auto; min-width: 0;
  font: 400 17px/1.4 var(--sans); letter-spacing: -.012em;
  color: var(--fg); caret-color: var(--fg);
}
input::placeholder { color: var(--fg-3); letter-spacing: -.008em; }

/* Empty until you type. At rest the field gets the whole header to itself. */
.readout {
  flex: none; white-space: nowrap;
  font: 400 11.5px/1 var(--sans); font-variant-numeric: tabular-nums;
  letter-spacing: .012em; color: var(--fg-3);
}
.readout:empty { display: none; }

.x {
  all: initial; flex: none; margin-right: -6px;
  display: grid; place-items: center; width: 26px; height: 26px;
  border-radius: 8px; cursor: pointer; color: var(--fg-3);
  transition: color .13s ease, background-color .13s ease;
}
.x:hover { color: var(--fg); background-color: var(--hov); }
.x:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }

/* ── list ─────────────────────────────────────────────────────────────────── */
.list {
  position: relative; flex: 1 1 auto; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain;
  /* Stable gutter: without it the rows jump 8px sideways the moment a query
     narrows the list below one screenful. Typing must not move the results. */
  scrollbar-gutter: stable;
  padding: 8px;
  scrollbar-width: thin; scrollbar-color: var(--thumb) transparent;
}
/* A centred empty state should be centred in the sheet, not in the sheet minus
   a scrollbar it will never need. */
.list:has(.note) { scrollbar-gutter: auto; }

.row {
  all: initial; box-sizing: border-box;
  display: grid; grid-template-columns: minmax(0,1fr) auto;
  align-items: center; column-gap: 12px;
  width: 100%; min-height: var(--row-h); padding: 8px 12px; border-radius: 8px;
  font: 400 14px/1.35 var(--sans); letter-spacing: -.004em;
  color: var(--fg); cursor: pointer; background-color: transparent;
  transition: background-color .13s ease, color .13s ease;
}
/* Saved, in-flight, and already-a-member rows are not actionable (pick() returns
   early), so they get no hover affordance and no pointer — their field is a
   fact, not a target. "Already in" is terminal here, not a toggle: this build
   has no round-trip-tested remove path, and YouTube would happily accept a
   duplicate. A failed row keeps both affordances: clicking it retries. */
.row.done { background-color: var(--f-ok); }
.row.fail { background-color: var(--f-bad); }
.row.done, .row.busy, .row.mem { cursor: default; }
:where(.list:not(.kb)) .row:not(.on,.done,.busy,.mem):hover { background-color: var(--hov); }
/* The cursor is simply the brightest field on screen, layered per state so it
   never argues with the state colour underneath it. */
.row.on { background-color: var(--act); }
.row.on.done { background-color: var(--f-ok-on); }
.row.on.fail { background-color: var(--f-bad-on); }
.row:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }

.t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Spread instead of padding: the mark must not widen the line, or the ellipsis
   would move as you type. */
.hit { border-radius: 3px; background-color: var(--hit); box-shadow: 0 0 0 1px var(--hit); }
.emo { font-size: .86em; opacity: .8; letter-spacing: .02em; }
/* Dimmed because it is not a target — the cursor may still land on it, and
   there it brightens enough to be read comfortably. */
.row.mem .t { color: var(--fg-2); }
.row.mem.on .t { color: var(--fg); }
.row.done .t { color: var(--fg); }

/* State column: optional word, then mark, flush right. The mark box is a fixed
   14px whether or not it holds anything, so marks stack in a true column. */
.state { display: flex; align-items: center; gap: 8px; color: var(--fg-3); }
.row.on .state { color: var(--fg-2); }
.gut { display: grid; place-items: center; width: 14px; height: 14px; flex: none; }
.mark { display: block; width: 14px; height: 14px; fill: none; stroke: currentColor;
        stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.tag { flex: none; white-space: nowrap;
       font: 500 11.5px/1 var(--sans); letter-spacing: .01em; }
/* Permanent facts whisper, events speak — the difference is weight and colour,
   not presence. A bare check would be ambiguous against the jade "Saved" check,
   and this row is not clickable, so it owes the reader an explanation. */
.row.mem .tag { font-weight: 400; }
.row.mem .gut { opacity: .78; }
.row.busy .state { color: var(--fg-2); }
.row.done .state { color: var(--ok); }
.row.done .tag, .row.fail .tag { font-weight: 600; }
.row.fail .state { color: var(--bad); }
/* Two thirds of the ring, so it still reads as a spinner in the frame where it
   is not moving — including under reduced motion, where it never moves at all. */
.spin { animation: spin .8s linear infinite; }
.spin circle { stroke-dasharray: 20 12; }
/* The one payoff, and only one: the check draws itself while the row's field
   flashes jade and settles. No scale pop on top — a second motion on the same
   14px glyph is gilding, and overshoot easing is a costume. */
.row.flash .mark { stroke-dasharray: 12; stroke-dashoffset: 12;
                   animation: draw .36s cubic-bezier(.16,1,.3,1) forwards; }
.row.flash { animation: land .5s cubic-bezier(.16,1,.3,1); }

.note { padding: 44px 28px; text-align: center; text-wrap: balance;
        color: var(--fg-3); font-size: 13px; line-height: 1.6; }
.note .h { display: block; margin-bottom: 3px;
           font-size: 14px; font-weight: 500; color: var(--fg-2); }
.note .s { display: block; }
.note .q { color: var(--fg); font-weight: 500; overflow-wrap: anywhere; }
.more { padding: 13px 12px 7px; color: var(--fg-3);
        font-size: 11.5px; font-variant-numeric: tabular-nums; }

/* Same height as a real row, so the list resolves into place instead of popping.
   The resting opacity is declared, not implied by the keyframes — otherwise
   reduced-motion would leave solid bars behind. */
.sk { display: flex; align-items: center; height: var(--row-h); padding: 0 12px; }
.sk span { display: block; height: 9px; border-radius: 5px;
           background-color: var(--skel); opacity: .6;
           animation: shimmer 1.8s ease-in-out infinite; }
.sk:nth-child(7n+1) span { width: 61%; animation-delay: 0s }
.sk:nth-child(7n+2) span { width: 44%; animation-delay: .11s }
.sk:nth-child(7n+3) span { width: 72%; animation-delay: .22s }
.sk:nth-child(7n+4) span { width: 38%; animation-delay: .33s }
.sk:nth-child(7n+5) span { width: 56%; animation-delay: .44s }
.sk:nth-child(7n+6) span { width: 67%; animation-delay: .55s }
.sk:nth-child(7n+7) span { width: 47%; animation-delay: .66s }

/* ── footer ───────────────────────────────────────────────────────────────── */
.foot {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 10px 20px 11px; border-top: 1px solid var(--line);
  font: 400 11.5px/1.5 var(--sans); color: var(--fg-3);
}
/* What you are saving, named. It shares the status bar with the status line and
   yields to it: the title is context you glance at once, the status is what
   changes. Elides rather than wraps so the footer keeps a fixed height, and it
   is capped at half the bar so a long title cannot crowd out the status.
   (This used to print the raw 11-character video ID — accurate, useless, and
   the sort of thing that reads as a leaked debug field to anyone but us.) */
.vid { flex: 0 1 auto; min-width: 0; max-width: 50%; overflow: hidden;
       text-overflow: ellipsis; white-space: nowrap; color: var(--fg-2); }
.status { flex: 1 1 auto; min-width: 0; overflow: hidden;
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.status:not(:empty)::before { content: "·"; margin: 0 7px 0 0; opacity: .55; }
.keys { flex: none; display: flex; align-items: baseline; gap: 12px; }
.nav { display: contents; }
.k { display: inline-flex; align-items: baseline; gap: 5px; white-space: nowrap; }
.kg { color: var(--fg-2); font-weight: 500; letter-spacing: .02em; }

@keyframes draw    { to { stroke-dashoffset: 0 } }
@keyframes spin    { to { transform: rotate(1turn) } }
@keyframes shimmer { 0%,100% { opacity: .55 } 50% { opacity: 1 } }
/* No 'to' — it settles into whatever field the row now rests at. */
@keyframes land    { from { background-color: color-mix(in srgb, var(--ok) 30%, transparent) } }

@media (max-width: 460px) {
  dialog { margin-top: 6vh; border-radius: 14px; }
  .head { padding: 13px 16px 12px; }
  .foot { padding: 9px 16px 10px; }
  .list { padding: 6px; }
  .row { padding: 8px 10px; }
  .keys .nav { display: none; }
}

/* Every state still reads without motion: in-flight and failed carry a word,
   saved carries a word and a field, and membership carries a mark plus a full
   sentence on the row's accessible name. Nothing here is the sole carrier. */
@media (prefers-reduced-motion: reduce) {
  dialog, dialog::backdrop, .row, .x { transition-duration: 1ms; }
  .row.flash, .spin, .sk span { animation: none; }
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

function plsSvg(cls) {
  const svg = document.createElementNS(PLS_SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

function plsIcon(d) {
  const svg = plsSvg('mark');
  const p = document.createElementNS(PLS_SVGNS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

// An arc, not a pulsing check — a check that means "done" has no business
// standing in for "in flight".
function plsSpinner() {
  const svg = plsSvg('mark spin');
  const c = document.createElementNS(PLS_SVGNS, 'circle');
  c.setAttribute('cx', '7'); c.setAttribute('cy', '7'); c.setAttribute('r', '5');
  svg.append(c);
  return svg;
}

// Text nodes + spans only — never a string sink.
function plsWriteRun(node, text) {
  if (!PLS_EMOJI) { node.append(text); return; }
  let last = 0;
  for (const m of text.matchAll(PLS_EMOJI)) {
    if (m.index > last) node.append(text.slice(last, m.index));
    node.append(plsEl('span', 'emo', m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) node.append(text.slice(last));
}

const plsIsLowSurrogate = (s, i) => {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
};

// Mark the run the query matched. Skipped whenever the arithmetic is not
// provably safe: case-folding that changes length, or a boundary that would
// split a surrogate pair. A wrong highlight is worse than none.
function plsWriteTitle(node, text, q) {
  let a = -1;
  let b = -1;
  // One character matches nearly every row, so the marks stop being information
  // and become confetti. Two is where a highlight starts telling you something.
  if (q && q.length >= PLS_MIN_HL) {
    const lower = text.toLowerCase();
    if (lower.length === text.length) {
      a = lower.indexOf(q);
      b = a + q.length;
      if (a > -1 && (plsIsLowSurrogate(text, a) || plsIsLowSurrogate(text, b))) a = -1;
    }
  }
  if (a < 0) {
    plsWriteRun(node, text);
  } else {
    if (a > 0) plsWriteRun(node, text.slice(0, a));
    const hit = plsEl('span', 'hit');
    plsWriteRun(hit, text.slice(a, b));
    node.append(hit);
    if (b < text.length) plsWriteRun(node, text.slice(b));
  }
  if (!node.firstChild) node.textContent = text;
}

// onPick(playlist) -> Promise. onClose() fires exactly once.
/**
 * @param {object} opts
 * @param {string} opts.videoId              diagnostic only; never rendered
 * @param {string} [opts.videoTitle]         the video's name, if known yet
 * @param {(p: any) => Promise<any>} opts.onPick
 * @param {() => void} [opts.onClose]        fires exactly once
 */
export function createSheet({ videoId, videoTitle, onPick, onClose }) {
  const uid = 'pls' + Math.random().toString(36).slice(2, 8);
  const host = document.createElement('pls-save-sheet');
  const shadow = host.attachShadow({ mode: 'closed' });
  const css = new CSSStyleSheet();
  css.replaceSync(PLS_CSS);
  shadow.adoptedStyleSheets = [css];

  const dlg = document.createElement('dialog');
  // The field is the title, so the name lives on the dialog itself.
  dlg.setAttribute('aria-label', 'Save to playlist');

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Save to playlist';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Search playlists');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', uid + '-l');

  const readout = plsEl('div', 'readout');
  readout.title = 'Playlists matching your search';

  const closeBtn = plsEl('button', 'x');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.append(plsIcon(PLS_CROSS));

  const head = plsEl('div', 'head');
  head.append(input, readout, closeBtn);

  const list = plsEl('div', 'list');
  list.id = uid + '-l';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Your playlists');

  const status = plsEl('div', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const keyHint = (glyph, word) => {
    const s = plsEl('span', 'k');
    s.append(plsEl('span', 'kg', glyph), plsEl('span', 'kw', word));
    return s;
  };
  const navKeys = plsEl('span', 'nav');
  navKeys.append(keyHint('↑↓', 'move'), keyHint('⏎', 'save'));
  navKeys.hidden = true;
  const keys = plsEl('div', 'keys');
  keys.setAttribute('aria-hidden', 'true');
  keys.append(navKeys, keyHint('esc', 'close'));

  // The id is diagnostic, not user-facing: it goes on the host element where
  // console-poking and e2e specs can still reach it, and never on screen.
  if (videoId) host.setAttribute('data-video-id', videoId);
  const vid = plsEl('div', 'vid');
  // `setTitle` lets the caller fill this in once the name has been fetched,
  // which happens after the sheet is already on screen — the sheet must open
  // instantly on intent, so nothing in it waits on a network round trip.
  function setTitle(t) {
    const name = t == null ? '' : String(t).trim();
    vid.textContent = name;
    if (name) vid.title = name; else vid.removeAttribute('title');
  }
  setTitle(videoTitle);

  const foot = plsEl('div', 'foot');
  foot.append(vid, status, keys);

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
  // The status line is an aria-live region, so what it currently asserts matters
  // beyond the pixels. `restingStatus` is the last thing the caller set — the
  // library summary — and `failureShown` records that a save error has since
  // overwritten it, so a successful retry can put the truth back.
  let restingStatus = '';
  let failureShown = false;

  const patienceTimer = setTimeout(() => { patience = true; render(); }, PLS_LOAD_PATIENCE);

  function setStatus(t) {
    if (dead) return;
    const s = t == null ? '' : String(t);
    status.textContent = s;
    // The line clamps at two; the tooltip never truncates.
    if (s) status.title = s; else status.removeAttribute('title');
  }

  function destroy() {
    if (dead) return;
    dead = true;
    clearTimeout(patienceTimer);
    host.remove();
    onClose?.();
  }

  function rowNode(p, i, q) {
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
    plsWriteTitle(t, p.title, q);
    const gut = plsEl('span', 'gut');
    const cell = plsEl('span', 'state');
    b.append(t, cell);

    let said = p.title;
    if (st === 'adding') {
      b.classList.add('busy');
      gut.append(plsSpinner());
      cell.append(plsEl('span', 'tag', 'Saving'));
      said = p.title + ', saving';
    } else if (st === 'added') {
      b.classList.add('done');
      gut.append(plsIcon(PLS_CHECK));
      cell.append(plsEl('span', 'tag', 'Saved'));
      said = p.title + ', saved';
    } else if (st === 'error') {
      b.classList.add('fail');
      gut.append(plsIcon(PLS_CROSS));
      cell.append(plsEl('span', 'tag', 'Retry'));
      said = p.title + ', could not be saved. Activate to try again';
    } else if (known) {
      // A permanent fact whispers: a muted mark, no word, the title dimmed.
      // The sentence lives on the accessible name so colour is never alone.
      // Informative, not actionable — aria-disabled rather than `disabled`, so
      // it stays readable and arrow-navigable inside the listbox.
      b.classList.add('mem');
      b.setAttribute('aria-disabled', 'true');
      gut.append(plsIcon(PLS_CHECK));
      cell.append(plsEl('span', 'tag', 'Already in'));
      said = p.title + ', already in this playlist';
    }
    cell.append(gut);

    // Names the row for assistive tech and, via the tooltip, un-truncates it.
    b.setAttribute('aria-label', said);
    b.title = st === 'error'
      ? p.title + ' — couldn’t be saved. Click to try again.'
      : p.title;
    b.addEventListener('click', () => { active = i; paint(false); pick(p); });
    return b;
  }

  // Head line (which may mix text and spans, and must stay one flowing
  // sentence) over an optional quieter second line that says what to do next.
  function note(headKids, sub) {
    const n = plsEl('div', 'note');
    n.setAttribute('role', 'presentation');
    const h = plsEl('span', 'h');
    h.append(...(Array.isArray(headKids) ? headKids : [headKids]));
    n.append(h);
    if (sub) n.append(plsEl('span', 's', sub));
    return n;
  }

  function skeletons() {
    return Array.from({ length: 13 }, () => {
      const n = plsEl('div', 'sk');
      n.setAttribute('role', 'presentation');
      n.append(plsEl('span'));
      return n;
    });
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
    nodes = shown.map((p, i) => rowNode(p, i, q));

    const kids = [...nodes];
    if (!loaded && !patience) kids.push(...skeletons());
    else if (!loaded) {
      kids.push(note('Still waiting on YouTube.', 'Your playlists haven’t arrived yet.'));
    } else if (!data.length) {
      kids.push(note('No playlists yet.', 'Create one on YouTube and it will show up here.'));
    } else if (!matches.length) {
      kids.push(note(
        ['No playlist matches ', plsEl('span', 'q', '“' + raw + '”')],
        'Try a shorter word.',
      ));
    } else if (matches.length > shown.length) {
      const more = plsEl('div', 'more',
        `${matches.length - shown.length} more — keep typing to narrow`);
      more.setAttribute('role', 'presentation');
      kids.push(more);
    }
    list.replaceChildren(...kids);

    readout.textContent = q && loaded ? `${matches.length} of ${data.length}` : '';

    input.setAttribute('aria-expanded', shown.length ? 'true' : 'false');
    navKeys.hidden = !shown.length;
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
    if (top - PLS_PAD < list.scrollTop) list.scrollTop = top - PLS_PAD;
    else if (bottom + PLS_PAD > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom + PLS_PAD - list.clientHeight;
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
    // Already a member: terminal, not a toggle. YouTube would accept a second
    // copy of the video without complaint, and this build has no remove path.
    if (p.member === true) return;
    state.set(p.id, 'adding');
    render();
    try {
      await onPick(p);
      if (dead) return;
      state.set(p.id, 'added');
      render();
      // Clear any earlier failure. The status line is an aria-live region, so
      // leaving it asserting a save failed after the retry succeeded tells a
      // screen-reader user the opposite of what happened.
      if (failureShown) {
        failureShown = false;
        setStatus(restingStatus);
      }
      const i = shown.findIndex((x) => x.id === p.id);
      if (i > -1) nodes[i].classList.add('flash');
    } catch (e) {
      console.warn('[pls] add failed', p.id, e);
      if (dead) return;
      state.set(p.id, 'error');
      render();
      // Names the problem and the recovery, short enough to survive the clamp;
      // the title attribute carries the whole sentence either way.
      failureShown = true;
      setStatus(`Couldn’t save to “${p.title}”. Select it again to retry.`);
    }
  }

  input.addEventListener('input', render);
  list.addEventListener('pointermove', () => list.classList.remove('kb'), { passive: true });
  closeBtn.addEventListener('click', () => dlg.close());
  dlg.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // An IME owns the arrows and Enter while a candidate window is open: those
    // keys are picking a character, not a playlist. Acting on them would both
    // break composition for every CJK user AND commit a save to whatever row
    // the cursor happened to be on — and this build has no remove path, so that
    // save cannot be undone from here. keyCode 229 is the pre-`isComposing`
    // spelling, kept for engines that still report it that way.
    if (e.isComposing || e.keyCode === 229) return;
    // Home/End belong to the text caret while focus is in the query field —
    // the ARIA combobox pattern reserves them for exactly that — and Shift+
    // anything is a selection gesture, not navigation.
    if (e.shiftKey) return;
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'PageDown') move(8);
    else if (e.key === 'PageUp') move(-8);
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
    setTitle: (t) => { if (!dead) setTitle(t); },
    // The caller's status is the resting truth — the line a transient save
    // failure temporarily overwrites, and the one a successful retry restores.
    setStatus: (t) => {
      if (dead) return;
      restingStatus = t == null ? '' : String(t);
      failureShown = false;
      setStatus(restingStatus);
    },
    setData: (rows) => {
      data = rows;
      loaded = true;
      clearTimeout(patienceTimer);
      // The placeholder names the job until the library lands, then names the
      // tool: "what is this" first, "what do I do" once there is something to do.
      input.placeholder = rows.length
        ? `Search ${rows.length} playlist${rows.length === 1 ? '' : 's'}`
        : 'Save to playlist';
      render();
    },
    destroy,
    get dead() { return dead; },
  };
}
