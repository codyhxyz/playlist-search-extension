// L4 — UI. A surface we own outright. Knows nothing about YouTube.
// Zero HTML-string sinks anywhere — YouTube enforces require-trusted-types-for
// 'script'. Every node is built with createElement / createElementNS /
// textContent / append. Nodes only, no exceptions.
//
// ── Direction ───────────────────────────────────────────────────────────────
// THESIS    A command palette, not a picker. 256 playlists means you type, you
//           don't scroll — so search remains the primary control. One quiet,
//           elided line above it names the video being changed. The placeholder
//           names the job ("Save to playlist") until the library lands, then
//           names the tool ("Search 256 playlists") and gets out of the way.
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
//           Only `member === true` earns a mark and a removal path. Removal
//           requires a separate confirmation button so a double-click or key
//           repeat cannot delete anything. Session events — Saving, Saved,
//           Removing, Removed, Retry — use the same state slot. Every state
//           carries a word as well as a mark, so colour is never the sole carrier.
// ORDER     Three orderings, and every one of them is a *claim* the sheet can
//           back: "Best match" (where the query lands in the title, then the
//           shorter title, then A→Z — and plain A→Z when the field is empty,
//           because with no query there is nothing to match on and a mystery
//           order is not a claim), "A → Z", "Z → A". There is deliberately no
//           "Recently updated": no playlist entry YouTube returns carries a
//           date, in either renderer generation — see the note in innertube.js,
//           which records exactly what was checked. Membership is not one of the
//           orderings. It is a partition — `member === true` rows are not save
//           targets — so they group above the targets in every mode, and the
//           cursor opens on the first row that Enter can actually act on.
// VIEWPORT  Video title · field + count + order + close · hairline · list.
//           The title is elided above the query, and the raw video id remains
//           diagnostic-only on the host element. The footer exists only for a
//           useful transient status or removal confirmation. Top-anchored, so
//           the sheet grows down to a ceiling and shrinks with the query.
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
// Three descending rules. One glyph for all three orderings on purpose — the
// mode is carried by the word beside it, the same way every other state in this
// sheet carries a word rather than leaning on a shape.
const PLS_SORT = 'M2.6 3.6h8.8M2.6 7h5.8M2.6 10.4h2.8';

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

  --alt:rgba(255,255,255,.022);
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

  --alt:rgba(0,0,0,.018);
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

/* ── header ──────────────────────────────────────────────────────────────── */
.head {
  flex: none; display: grid; grid-template-columns: minmax(0,1fr) auto auto auto;
  align-items: center; gap: 8px 12px;
  padding: 15px 20px 14px; border-bottom: 1px solid var(--line);
}
.vid {
  grid-column: 1 / -1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; color: var(--fg-2);
  font: 400 12px/1.3 var(--sans);
}
.vid:empty { display: none; }
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
.row:nth-child(even) { background-color: var(--alt); }
/* In-flight and completed session events are terminal. Known member rows remain
   actionable, but activation only opens the separate removal confirmation. */
.row.done { background-color: var(--f-ok); }
.row.fail { background-color: var(--f-bad); }
.row.done, .row.busy, .row.removed { cursor: default; }
:where(.list:not(.kb)) .row:not(.on,.done,.busy,.removed):hover { background-color: var(--hov); }
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
/* Known members are dimmed at rest and brighten when targeted for removal. */
.row.mem .t { color: var(--fg-2); }
.row.mem:hover .t, .row.mem.on .t { color: var(--fg); }
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
.row.removed .state { color: var(--fg-2); }
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

/* ── footer: transient status and removal confirmation only ─────────────── */
.foot {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 10px 20px 11px; border-top: 1px solid var(--line);
  font: 400 11.5px/1.5 var(--sans); color: var(--fg-3);
}
.foot:has(.status:empty) { display: none; }
.status { flex: 1 1 auto; min-width: 0; overflow: hidden;
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.confirm { flex: none; display: flex; gap: 8px; }
.confirm button {
  all: initial; box-sizing: border-box; padding: 5px 9px; border-radius: 7px;
  font: 500 11.5px/1 var(--sans); color: var(--fg-2); cursor: pointer;
}
.confirm button:hover { background-color: var(--hov); color: var(--fg); }
.confirm button:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.confirm .danger { color: var(--bad); }

/* The header's order control cycles through the three supported modes. */
.sort {
  all: initial; box-sizing: border-box; flex: none;
  display: inline-flex; align-items: center; gap: 7px;
  height: 22px; padding: 0 8px; margin: 0 2px 0 0; border-radius: 7px;
  font: 500 11.5px/1 var(--sans); letter-spacing: .01em;
  color: var(--fg-3); cursor: pointer;
  transition: color .13s ease, background-color .13s ease;
}
.sort:hover { color: var(--fg); background-color: var(--hov); }
.sort:active { background-color: var(--act); }
.sort:focus-visible { color: var(--fg); outline: 2px solid var(--ring); outline-offset: -2px; }
.sort .mark { stroke-width: 1.6; }
/* Held to one width so cycling cannot move the query field. */
.sl { min-width: 38px; text-align: left; white-space: nowrap; }

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
}

/* Every state still reads without motion: in-flight and failed carry a word,
   saved carries a word and a field, and membership carries a mark plus a full
   sentence on the row's accessible name. Nothing here is the sole carrier. */
@media (prefers-reduced-motion: reduce) {
  dialog, dialog::backdrop, .row, .x, .sort { transition-duration: 1ms; }
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

// ── Ordering ────────────────────────────────────────────────────────────────
// Each mode has to be defensible if a user asks "why is this row above that
// one?", so each one is computed from data we actually hold — the title, and
// what they typed. Nothing here consults a date, because YouTube does not give
// us one: neither `gridPlaylistRenderer` nor `lockupViewModel` carries a
// timestamp, an "updated" string, or a publish time on a playlist entry, in the
// real captures or the rendered page. `innertube.js` records the evidence.
// The server's own response order IS available (`fetchAllPlaylists` preserves
// it) but its meaning is not established — labelling it "Recently updated"
// would be inventing a claim, which is the one failure mode this codebase has
// already shipped once and written down.

// Ties break on title, then id, so the order is total and a re-render can never
// shuffle two rows that compare equal.
const plsAZ = (a, b) =>
  a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const PLS_SORTS = [
  {
    id: 'match',
    // Short on screen, complete in the accessible name — the header stays compact
    // for "Best match" and every neighbour in it is already eliding.
    label: 'Match',
    // Where the query lands in the title, then the shorter title, then A→Z. With
    // an empty field there is no match to rank by, so it resolves to A→Z rather
    // than to an order nobody could explain.
    say: 'best match, closest to the start of the title first',
    cmp: (x, y, q) =>
      (q ? x.pos - y.pos || x.p.title.length - y.p.title.length : 0) || plsAZ(x.p, y.p),
  },
  { id: 'az', label: 'A → Z', say: 'A to Z', cmp: (x, y) => plsAZ(x.p, y.p) },
  { id: 'za', label: 'Z → A', say: 'Z to A', cmp: (x, y) => -plsAZ(x.p, y.p) },
];

const plsSortAt = (i) => PLS_SORTS[((i % PLS_SORTS.length) + PLS_SORTS.length) % PLS_SORTS.length];

/**
 * Order the rows that survived the filter.
 *
 * Membership groups FIRST in every mode, and it is not itself a mode: a
 * `member === true` row is not a save target (`pick()` returns early), so this
 * is a partition of facts from targets rather than an ordering of peers. The
 * comparison is `=== true` on both sides, so `false` and `undefined` land in
 * the same group — the tri-state promise holds through sorting, and an unmarked
 * row still claims nothing.
 *
 * @param {Array<{id: string, title: string, member?: boolean}>} rows
 * @param {number} sortIdx
 * @param {string} q lowercased query, or ''
 */
function plsOrder(rows, sortIdx, q) {
  const mode = plsSortAt(sortIdx);
  // Decorate once: the match position is O(title) to compute and a sort would
  // otherwise ask for it O(n log n) times.
  const dec = rows.map((p, i) => ({ p, i, pos: q ? p.title.toLowerCase().indexOf(q) : -1 }));
  dec.sort(
    (x, y) =>
      Number(y.p.member === true) - Number(x.p.member === true) ||
      mode.cmp(x, y, q) ||
      x.i - y.i,
  );
  return dec.map((d) => d.p);
}

// onPick(playlist) -> Promise. onClose() fires exactly once.
/**
 * @param {object} opts
 * @param {string} opts.videoId              diagnostic only; never rendered
 * @param {string} [opts.videoTitle]         the video's name, if known yet
 * @param {(p: any) => Promise<any>} opts.onPick
 * @param {(p: any) => Promise<any>} opts.onRemove
 * @param {() => void} [opts.onClose]        fires exactly once
 * @param {string} [opts.sort]               initial ordering: match | az | za
 * @param {(id: string) => void} [opts.onSort]  fires when the user changes it
 */
export function createSheet({ videoId, videoTitle, onPick, onRemove, onClose, sort, onSort }) {
  const uid = 'pls' + Math.random().toString(36).slice(2, 8);
  const host = document.createElement('pls-save-sheet');
  const shadow = host.attachShadow({ mode: 'closed' });
  const css = new CSSStyleSheet();
  css.replaceSync(PLS_CSS);
  shadow.adoptedStyleSheets = [css];

  // ── Keystrokes stop here ──────────────────────────────────────────────────
  // While the sheet is open the keyboard is ours, and the host page must not see
  // it. This is not theoretical: YouTube binds single-key shortcuts on `document`
  // (f fullscreen, k play/pause, m mute, t theater, j/l seek, digits scrub), and
  // guards them with the usual "ignore this if the user is typing" check against
  // the event target.
  //
  // That guard cannot see us. Events from inside a shadow root are RETARGETED on
  // the way out, so by the time the event reaches `document` its target is the
  // host element — `<pls-save-sheet>`, which is not an input — and the guard
  // waves it through. `document.activeElement` reports the host for the same
  // reason. Measured: typing "f" into the search field toggled fullscreen.
  //
  // `showModal()` does not help either. It makes the rest of the page `inert`,
  // which blocks focus and pointer hits, but document-level key listeners still
  // fire. So we stop the events at the boundary they are escaping through.
  //
  // Bubble phase, on the host: our own handlers live below it and have already
  // run. This cannot block a capture-phase listener on window/document — nothing
  // inside the tree can — but YouTube's shortcuts are bubble-phase, and
  // tests/e2e/specs/intent-chain.sh checks the real thing on a real watch page
  // rather than trusting this comment.
  //
  // It costs one thing, and it is not obvious: the UA's close watcher for
  // <dialog> also sits above the host, so Escape stops closing the sheet unless
  // we handle it ourselves. The keydown handler below does.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

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

  const head = plsEl('header', 'head');

  const list = plsEl('div', 'list');
  list.id = uid + '-l';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Your playlists');
  // Chrome makes any scrollable container a tab stop so a keyboard user can reach
  // its scrollbar. This one is already fully keyboard-driven from the query field,
  // so that stop is pure noise — and worse, it exists only when the list happens to
  // overflow, which made the number of Tabs to anything else in the sheet depend on
  // how many playlists matched. The listbox of a combobox does not belong in the
  // tab order anyway; the field owns focus and aria-activedescendant owns the row.
  list.tabIndex = -1;

  const status = plsEl('div', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const cancelRemoveBtn = plsEl('button', null, 'Cancel');
  cancelRemoveBtn.type = 'button';
  const confirmRemoveBtn = plsEl('button', 'danger', 'Remove');
  confirmRemoveBtn.type = 'button';
  const confirmRemove = plsEl('div', 'confirm');
  confirmRemove.hidden = true;
  confirmRemove.append(cancelRemoveBtn, confirmRemoveBtn);

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

  // Ordering. A plain button beside the query, in the natural tab order, that cycles. No chord:
  // every modifier+letter that is free on one platform is taken on the other, and
  // Option+letter types a real character into a field people search in — a sort
  // shortcut that eats a keystroke someone meant for the query is a worse bug
  // than no shortcut. One Tab from the field reaches it; a click reaches it; and
  // typing anywhere puts focus straight back in the query (see the keydown
  // handler), so wandering here never costs the common path a keystroke.
  let sortIdx = Math.max(0, PLS_SORTS.findIndex((s) => s.id === sort));
  const sortLabel = plsEl('span', 'sl');
  const sortBtn = plsEl('button', 'sort');
  sortBtn.type = 'button';
  sortBtn.append(plsIcon(PLS_SORT), sortLabel);

  function paintSort() {
    const s = plsSortAt(sortIdx);
    sortLabel.textContent = s.label;
    // The name is the announcement: activating a cycling button re-reads it, so
    // the change is spoken without hijacking the status line's live region —
    // that region is reserved for what happened to the user's playlists.
    sortBtn.setAttribute('aria-label', `Sort order: ${s.say}. Activate to change.`);
    sortBtn.title = `Sort: ${s.say}. Playlists you’re already in stay at the top.`;
  }

  function setSort(next) {
    cancelRemoval(false);
    sortIdx = (next + PLS_SORTS.length) % PLS_SORTS.length;
    paintSort();
    // Every row just moved, so the cursor cannot keep its index — treat it like a
    // new query and reopen on the top target.
    lastQ = null;
    render();
    onSort?.(plsSortAt(sortIdx).id);
  }
  paintSort();

  head.append(vid, input, readout, sortBtn, closeBtn);

  const foot = plsEl('div', 'foot');
  foot.append(status, confirmRemove);

  dlg.append(head, list, foot);
  shadow.append(dlg);
  document.documentElement.append(host);

  let data = [];                 // {id, title, member}
  const state = new Map();       // id -> add/remove pending, success, or error
  let armedRemove = null;
  let dead = false;
  let loaded = false;
  let patience = false;          // load took long enough to stop promising rows
  let shown = [];                // playlists currently rendered
  let nodes = [];                // row elements, parallel to `shown`
  let active = 0;
  let lastQ = null;
  // The status line is an aria-live region, so what it currently asserts matters
  // beyond the pixels. `restingStatus` is the last thing the caller set, and
  // `failureShown` records that an operation error has overwritten it.
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
    // Out of the tab order, per the combobox pattern: the query field holds focus
    // and `aria-activedescendant` names the current row. These are <button>s, so
    // without this every one of them is a tab stop — 200 presses to get past the
    // list to anything else in the sheet, which is not a tab order, it is a wall.
    // They stay mouse- and script-focusable, so clicking a row behaves as before.
    b.tabIndex = -1;

    const t = plsEl('span', 't');
    plsWriteTitle(t, p.title, q);
    const gut = plsEl('span', 'gut');
    const cell = plsEl('span', 'state');
    b.append(t, cell);

    let said = p.title;
    if (st === 'adding') {
      b.classList.add('busy');
      b.setAttribute('aria-busy', 'true');
      b.setAttribute('aria-disabled', 'true');
      gut.append(plsSpinner());
      cell.append(plsEl('span', 'tag', 'Saving'));
      said = p.title + ', saving';
    } else if (st === 'added') {
      b.classList.add('done');
      b.setAttribute('aria-disabled', 'true');
      gut.append(plsIcon(PLS_CHECK));
      cell.append(plsEl('span', 'tag', 'Saved'));
      said = p.title + ', saved';
    } else if (st === 'error') {
      b.classList.add('fail');
      gut.append(plsIcon(PLS_CROSS));
      cell.append(plsEl('span', 'tag', 'Retry'));
      said = p.title + ', could not be saved. Activate to try again';
    } else if (st === 'removing') {
      b.classList.add('busy');
      b.setAttribute('aria-busy', 'true');
      b.setAttribute('aria-disabled', 'true');
      gut.append(plsSpinner());
      cell.append(plsEl('span', 'tag', 'Removing'));
      said = p.title + ', removing';
    } else if (st === 'removed') {
      b.classList.add('removed');
      b.setAttribute('aria-disabled', 'true');
      cell.append(plsEl('span', 'tag', 'Removed'));
      said = p.title + ', removed';
    } else if (st === 'remove-error') {
      b.classList.add('fail');
      gut.append(plsIcon(PLS_CROSS));
      cell.append(plsEl('span', 'tag', 'Retry remove'));
      said = p.title + ', could not be removed. Activate to try again';
    } else if (known) {
      b.classList.add('mem');
      gut.append(plsIcon(PLS_CHECK));
      cell.append(plsEl('span', 'tag', 'Already in'));
      said = p.title + ', already in this playlist. Activate to remove';
    }
    cell.append(gut);

    // Names the row for assistive tech and, via the tooltip, un-truncates it.
    b.setAttribute('aria-label', said);
    b.title = st === 'error'
      ? p.title + ' — couldn’t be saved. Click to try again.'
      : st === 'remove-error'
        ? p.title + ' — couldn’t be removed. Click to try again.'
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

    const matches = plsOrder(
      q ? data.filter((p) => p.title.toLowerCase().includes(q)) : data,
      sortIdx,
      q,
    );
    // Ordering happens BEFORE the cap, so the 200 rows that survive are the 200
    // best under the current mode rather than the 200 that happened to arrive
    // first. On a 253-playlist library that is the difference between the cap
    // being a scroll limit and the cap hiding the row you were looking for.
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
    // Rest on the first add target. Removal remains reachable with the arrows,
    // but Enter at rest must not arm a destructive action without navigation.
    active = fresh ? shown.findIndex(canAdd) : Math.min(active, Math.max(0, shown.length - 1));
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
    cancelRemoval(false);
    active = Math.max(0, Math.min(shown.length - 1, active + delta));
    list.classList.add('kb');
    paint(true);
  }

  function canPick(p) {
    const cur = state.get(p.id);
    return cur !== 'adding' && cur !== 'added' && cur !== 'removing' && cur !== 'removed';
  }

  function canAdd(p) {
    return p.member !== true && canPick(p);
  }

  function cancelRemoval(focus = true) {
    if (!armedRemove) return;
    armedRemove = null;
    confirmRemove.hidden = true;
    confirmRemoveBtn.removeAttribute('aria-label');
    setStatus(restingStatus);
    if (focus) input.focus();
  }

  function armRemoval(p) {
    if (armedRemove === p) return;
    armedRemove = p;
    confirmRemove.hidden = false;
    confirmRemoveBtn.setAttribute('aria-label', `Remove from ${p.title}`);
    setStatus(`Remove from “${p.title}”?`);
    cancelRemoveBtn.focus();
  }

  async function remove(p) {
    armedRemove = null;
    confirmRemove.hidden = true;
    confirmRemoveBtn.removeAttribute('aria-label');
    input.focus();
    state.set(p.id, 'removing');
    setStatus(`Removing from “${p.title}”…`);
    render();
    try {
      await onRemove(p);
      if (dead) return;
      p.member = false;
      state.set(p.id, 'removed');
      failureShown = false;
      setStatus(restingStatus);
      render();
      const i = shown.findIndex((x) => x.id === p.id);
      if (i > -1) { active = i; paint(false); }
    } catch (e) {
      console.warn('[pls] remove failed', p.id, e);
      if (dead) return;
      state.set(p.id, 'remove-error');
      render();
      failureShown = true;
      setStatus(`Couldn’t remove from “${p.title}”. Select it again to retry.`);
    }
  }

  async function pick(p) {
    if (!canPick(p)) return;
    const cur = state.get(p.id);
    if (p.member === true) {
      if (cur === 'remove-error') remove(p);
      else armRemoval(p);
      return;
    }
    cancelRemoval(false);
    state.set(p.id, 'adding');
    render();
    try {
      await onPick(p);
      if (dead) return;
      p.member = true;
      state.set(p.id, 'added');
      render();
      if (failureShown) {
        failureShown = false;
        setStatus(restingStatus);
      }
      const i = shown.findIndex((x) => x.id === p.id);
      if (i > -1) { active = i; paint(false); nodes[i].classList.add('flash'); }
    } catch (e) {
      console.warn('[pls] add failed', p.id, e);
      if (dead) return;
      state.set(p.id, 'error');
      render();
      failureShown = true;
      setStatus(`Couldn’t save to “${p.title}”. Select it again to retry.`);
    }
  }

  input.addEventListener('input', () => { cancelRemoval(false); render(); });
  list.addEventListener('pointermove', () => list.classList.remove('kb'), { passive: true });
  closeBtn.addEventListener('click', () => dlg.close());
  sortBtn.addEventListener('click', () => setSort(sortIdx + 1));
  cancelRemoveBtn.addEventListener('click', () => cancelRemoval());
  confirmRemoveBtn.addEventListener('click', () => { if (armedRemove) remove(armedRemove); });
  dlg.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // An IME owns the arrows and Enter while a candidate window is open: those
    // keys are picking a character, not a playlist. Acting on them would both
    // break composition for every CJK user and commit an unintended write.
    // keyCode 229 is the pre-`isComposing` spelling, kept for engines that still
    // report it that way.
    if (e.isComposing || e.keyCode === 229) return;
    // Close on Escape OURSELVES rather than leaning on the UA's close watcher.
    // Stopping key events at the host (see above) also stops them reaching the
    // window, which is where that watcher lives — so the containment fix silently
    // broke Escape. Owning the key is the right answer anyway: the sheet's
    // dismissal should not depend on a platform behaviour we are deliberately
    // cutting off. destroy() is idempotent, so a UA close on top of ours is fine.
    if (e.key === 'Escape') {
      if (armedRemove) cancelRemoval(); else dlg.close();
      e.preventDefault();
      return;
    }
    // A palette's field must never be out of reach. If focus has wandered to one
    // of the header buttons, a typed character belongs in the query, not
    // on the floor — otherwise adding a focusable control would have quietly put
    // a "click back into the box first" step in front of the common path. Space
    // is left alone: it is how a focused button is activated.
    if (e.target !== input && e.key.length === 1 && e.key !== ' ') {
      cancelRemoval(false);
      input.focus();
      input.value += e.key;
      render();
      e.preventDefault();
      return;
    }
    // The list keys below belong to the list. While a button owns focus, Enter
    // and Space are its activation and the arrows are its own business — running
    // both would have made Enter on the close button save a playlist instead of
    // closing, because preventDefault here suppresses the button's click.
    // `contains`, not `===`: the chip holds an icon and a label, and a key event
    // retargeted from either of them is still the button's.
    if (closeBtn.contains(/** @type {Node} */ (e.target))) return;
    if (confirmRemove.contains(/** @type {Node} */ (e.target))) return;
    if (sortBtn.contains(/** @type {Node} */ (e.target))) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') setSort(sortIdx + 1);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') setSort(sortIdx - 1);
      else return;
      e.preventDefault();
      return;
    }
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
