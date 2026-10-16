# Setup and permission recovery

YouTube access remains an optional host permission. The extension cannot work without it.
The current permission state determines setup status. Reading or closing the setup page does not complete setup.

## Required actions

1. Select **Grant YouTube access**.
2. Select **Allow** in Chrome's permission prompt.
3. Open a fresh YouTube tab, or reload an existing YouTube tab.
4. Sign in to the YouTube account that contains your playlists.

The setup page waits for content-script registration before it shows success.
Registration affects future documents. It does not install the early request observer into an existing document.

## Missed setup

The extension opens setup automatically only on installation.
Missing access leaves an **OFF** badge and an explanatory toolbar title.
The toolbar, right-click menu, and keyboard shortcuts reopen or focus the same setup tab.
Browser startup, updates, and permission removal do not open reminder tabs.
Page-controlled hook messages cannot open setup.

Users can find an unpinned extension in Chrome's **Extensions** menu.
The setup page explains this route. Pinning is optional.
A badge does not guarantee discovery when the user never opens that menu.

## Established patterns

- [Chrome permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions):
  request access directly from a user gesture and check actual permissions.
- [Chrome action guidance](https://developer.chrome.com/docs/extensions/develop/ui/implement-action):
  badges can indicate required user action.
- [uBlock Origin Lite popup source](https://github.com/gorhill/uBlock/blob/master/platform/mv3/extension/js/popup.js):
  requests host access for filtering changes, handles denial, and offers a reload.
- [SponsorBlock permission source](https://github.com/ajayyy/SponsorBlock/blob/master/src/utils.ts):
  registers extra-site scripts after permission approval and resets the setting after denial.

These examples support permission-driven setup and recovery. They do not prove that a badge guarantees onboarding completion.
This extension adapts those patterns to one required host and an existing reusable setup tab.

A static popup would suppress the existing toolbar Save/Find handler.
A conditional popup adds another permission-dependent surface without a demonstrated need.
Chrome's newer `addHostAccessRequest()` requires Chrome 133. This extension still supports Chrome 123.

## Checks and limits

`tests/onboarding.test.mjs` covers the worker's recovery routes, badge state, and setup-tab reuse.
`tests/welcome.test.mjs` covers permission requests, denial, registration failure, retry, and revocation.
Local browser checks cover page layout with mocked Chrome APIs.
These checks do not test Chrome's native permission prompt or live signed-in YouTube.
