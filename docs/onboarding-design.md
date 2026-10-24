# Welcome page: the actual product

The identity comes from `src/icons/icon128.png`, displayed at 72 CSS pixels.
Red is reserved for the primary Open YouTube action; neutral surfaces follow
the browser’s light/dark preference. White on #c62828 exceeds 4.5:1 contrast.
Amber appears only when the existing permission controller detects restricted
YouTube access.

The teaching surface is the existing recording, not a reconstructed Save
dialog: `assets/onboarding-demo.mp4`, with
`assets/onboarding-demo-poster.webp` as its loading preview.
The video autoplays muted, loops, and plays inline. Reduced-motion users get
the static poster instead. Native video controls allow pausing or playing
without a separate demo button. The video retains its aspect ratio on narrow screens.

The factual headline and brief description precede Open YouTube. A separate
Shortcuts section gives the two commands readable labels, with keys read from
chrome.commands so they match the OS and any rebinding. There is no pinning
disclosure, fake dialog, numbered explainer, setup reassurance, or reload copy.

The one exception is a collapsed native `<details>`, "What it can access", in
the footer row after Privacy and Get help. It needs no JavaScript. Open, it
explains the single install warning ("Read and change your data on
www.youtube.com") and what it enables, that requests go only to www.youtube.com
with thumbnails from i.ytimg.com, what is stored on the device, and the one
right-click item, then links to the source on GitHub and the privacy policy.
Each statement must stay true against the code and `PRIVACY.md`. It stays
closed by default so the desktop page still fits one screen; open, the page may
scroll but must not overflow horizontally. Its zero flex basis keeps the
summary in place when it opens; below 600px it sits on its own row. The
restricted-access notice adds one line saying access is used only on
www.youtube.com, to search and save to your playlists.

On desktop, the introduction and recording share a row. Shortcuts and help
remain visible below them without scrolling, including at 800×600 and 1366×768.
The layout keeps 16px body text, the 72px logo, and full-size action buttons.
Narrow windows stack naturally. Expanded recovery notices remain scrollable
rather than being clipped to force a one-screen layout.

On load the page arrives in stages, 100ms apart: header, headline, description, Open YouTube, recording, then shortcuts and help. Each fades in with 4px of blur and a 12px rise over 300ms. Reduced motion keeps only the fade. `main` clips overflow so a section mid-rise never makes the page scrollable. Buttons scale to 0.96 when pressed, and hover styles apply only on hover-capable pointers.

The permission/registration controller, race guards, direct-gesture recovery,
retry, live status, and fresh-tab action are unchanged. Version comes from
`chrome.runtime.getManifest().version`, with an arbitrary-version regression.
Browser validation fixtures must read `src/manifest.json`, never inject a
release number as a literal.

Validation: welcome VM tests cover autoplay, reduced motion, playback rejection,
version, and existing permission races. Local Chromium
captures cover desktop/narrow, light/dark, normal/restricted states, asset
loading, keyboard operation, reduced-motion startup, and horizontal overflow.
Screenshots are review artifacts outside the repository; no remote assets or
new dependencies are used.
`tests/test-welcome-layout.mjs` prevents desktop scrolling and horizontal
overflow with the access disclosure closed, checks horizontal overflow again
with it open at every size, and runs as part of `npm test`.
