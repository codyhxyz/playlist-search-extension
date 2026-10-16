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
Shortcuts section gives Alt+S and Alt+P readable labels. There is no pinning
disclosure, fake dialog, numbered explainer, setup reassurance, or reload copy.

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
