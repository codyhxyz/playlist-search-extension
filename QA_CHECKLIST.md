# Pre-Publish QA Checklist

## Functional
- [ ] Open YouTube video page and click Save.
- [ ] Inline search appears inside Save to playlist UI.
- [ ] Typing filters playlist list in real time.
- [ ] Clear button resets results.
- [ ] Escape key clears current query.
- [ ] Paste works in search input.
- [ ] Open `https://www.youtube.com/feed/playlists` and verify inline filter appears.
- [ ] Typing on `/feed/playlists` filters playlist cards correctly.

## Ranking and Highlight
- [ ] Exact matches rank above partial matches.
- [ ] Multi-word queries rank relevant items correctly.
- [ ] Fuzzy query (minor typo) still finds expected playlists.
- [ ] Matching terms are highlighted.

## Visual
- [ ] Light theme looks correct.
- [ ] Dark theme looks correct.
- [ ] Mobile viewport remains usable.

## Stability
- [ ] No infinite rerender while typing.
- [ ] No uncaught errors in DevTools console.
- [ ] Works after YouTube SPA navigation.

## Policy
- [ ] Privacy policy URL is public and reachable.
- [ ] Support URL is public and reachable.
- [ ] CWS privacy questionnaire answers match actual behavior.
- [ ] No remote hosted executable code.
