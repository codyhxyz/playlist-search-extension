# Welcome page design

Scope: `src/welcome.html`; existing `welcome.js` state machine is unchanged.

## Direction contract

**Thesis:** Show what searching a playlist feels like, instead of asking users to
read a setup checklist. Replace the narrow prose column with a side-by-side
invitation and a recognizable Save-sheet example.

**Own-world:** Blue carries the example region and primary action; amber belongs
only to withheld site access. Neutral system UI typography connects the example
to the real YouTube-native sheet. This is a functional tutorial, not a campaign.

**Story:** Understand the search benefit, open a fresh YouTube tab, sign in to the
correct account, choose Save, type, and pick. Existing tabs need a reload.
Shortcuts and pinning remain optional.

**First viewport:** A large two-line benefit and primary action on the left;
a blue-backed, explicitly illustrative sheet on the right. A numbered workflow
spans the next row. Narrow windows stack in reading order without shrinking text.

**Form:** Product demonstration beside first-use invitation. The demo is static,
not an imitation interactive form; it never requests or represents account data.

**Finish:** Reviewed actual Chromium renders at 1360×1000 and 390×844 in both
themes, plus narrow restricted-access state. No shipping raster assets.

## Grounding and review

- `src/lib/sheet.js` supplies the real sheet vocabulary: “Save to...”, video
  title, search, count/order, playlist rows, bookmark indicators, New playlist.
  The example simplifies these controls and labels itself as an example.
- 1Password browser getting-started guidance is the precedent for teaching a
  first useful action while keeping toolbar pinning secondary. Public
  documentation research was used, not a live authenticated installation.
- The user may close this page without disabling the extension. Required
  installation access is not represented as an additional onboarding consent.
- Existing registration acknowledgement, recovery gesture, retry, stale
  generation checks, focus management and tab-opening logic remain untouched.
- Keyboard check: the first tab stop is the primary action. The illustrative
  sheet adds no tab stops. Narrow captures have no horizontal overflow.
- Verdict: ready for parent/user visual review, not deployed. A static demo may
  need updating if the actual Save-sheet structure changes.
