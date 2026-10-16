# Welcome page: the actual product

The identity comes from `src/icons/icon128.png`, displayed at 72 CSS pixels.
Red is reserved for the primary Open YouTube action; neutral surfaces follow
the browser’s light/dark preference. White on #c62828 exceeds 4.5:1 contrast.
Amber appears only when the existing permission controller detects restricted
YouTube access.

The teaching surface is the existing recording, not a reconstructed Save
dialog: `assets/onboarding-demo.gif`, with
`assets/onboarding-demo-poster.webp` as its initial and stopped frame.
There is no autoplay, including with reduced motion. The native Play demo /
Stop demo button swaps those assets and exposes the playing state through
`aria-pressed`. Stop returns to the poster rather than promising pause/resume.
The image retains its aspect ratio on narrow screens.

The factual headline and brief description precede Open YouTube. A separate
Shortcuts section gives Alt+S and Alt+P readable labels. There is no pinning
disclosure, fake dialog, numbered explainer, setup reassurance, or reload copy.

The permission/registration controller, race guards, direct-gesture recovery,
retry, live status, and fresh-tab action are unchanged. Version comes from
`chrome.runtime.getManifest().version`, with an arbitrary-version regression.
Browser validation fixtures must read `src/manifest.json`, never inject a
release number as a literal.

Validation: welcome VM tests cover static startup, real asset switching,
accessible state, version, and existing permission races. Local Chromium
captures cover desktop/narrow, light/dark, normal/restricted states, asset
loading, keyboard operation, reduced-motion startup, and horizontal overflow.
Screenshots are review artifacts outside the repository; no remote assets or
new dependencies are used.
