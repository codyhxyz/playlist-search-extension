# First use and site-access recovery

YouTube access is a required host permission, limited to `https://www.youtube.com/*`.
Chrome requests consent during installation. The welcome page does not ask again on a normal install.
The extension works without reading, acknowledging, or completing the welcome page.

## First use

The welcome page introduces the real workflow: open a video, select Save, search, and pick a playlist.
Its primary action opens a fresh YouTube tab.
Existing YouTube tabs need a reload because registration does not retrofit the early request observer into an existing document.
The user must sign in to the account that contains their playlists.
Pinning and keyboard shortcuts are optional convenience features.

The page checks actual site access and waits for content-script registration before it claims readiness.
It shows an amber recovery notice only if Chrome blocks access.
Required manifest permissions do not override the user's Chrome site-access controls.

## Missed welcome

The extension opens the welcome page automatically only on installation.
Browser startup, updates, and permission removal do not open reminder tabs.
Missing access leaves an **OFF** badge and an explanatory toolbar title.
The toolbar, right-click menu, and keyboard shortcuts reopen or focus the same recovery page.
Page-controlled hook messages cannot open that page.

No stored acknowledgement controls whether the extension runs.
There is no need to make users complete an optional tour.

## Established patterns

- [Chrome permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions):
  use required permissions for basic functionality and optional permissions for optional features.
- [Chrome permission policy](https://developer.chrome.com/docs/webstore/program-policies/permissions):
  request only the narrowest access necessary for implemented features.
- [SponsorBlock's Chrome manifest](https://github.com/ajayyy/SponsorBlock/blob/914e2c88d4f80be9bcf3b3299f155c703ee99061/manifest/chrome-manifest-extra.json):
  requires YouTube access while supporting optional extra sites.
- [uBlock Origin Lite's change to installation-time host access](https://github.com/gorhill/uBlock/commit/01e36db23a0caae09a3734606b99af8b15522a76):
  removes the permission-less installation default to address functional limitations.

The transferable pattern is required access for the core feature, not more forceful permission onboarding.
The extension still supports Chrome 123 and keeps the toolbar popup-free for its existing Save/Find action.

## Upgrade and checks

Changing optional access to required access can disable an update until the user accepts a new permission warning.
Users who previously granted the same access can behave differently from users who never granted it.
Chrome's [permission-warning guide](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings) describes testing signed updates.

The migration investigation used the official update-testing tool and generated same-ID signed fixtures.
Headless installation failed at Chrome's native file-drop boundary, so the signed-update cases were not observed.
[Chromium's privilege check](https://github.com/chromium/chromium/blob/971a7443b0c9b0a9b2860529b33331b76077ec62/chrome/browser/extensions/chrome_extension_registrar_delegate.cc#L490-L593)
supports the expected distinction: previously granted access normally avoids a new warning; never-granted access normally requires approval.
This source inspection is not an executed migration test.
A separate unpacked required-host fixture verified that site controls can withhold access and restore it.
Unpacked reloads do not test signed-update permission warnings.

`tests/onboarding.test.mjs` checks the narrow manifest, automatic registration without acknowledgement, recovery routes, and badge state.
`tests/welcome.test.mjs` checks normal first-use readiness, access recovery, registration failure, retry, and revocation.
Local browser layout checks use mocked Chrome APIs. They do not establish native permission or signed-update behavior.
Live signed-in YouTube testing is separate.
