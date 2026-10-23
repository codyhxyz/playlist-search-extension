# Review request

## Policy and timing

Chrome's [Spam and Abuse policy](https://developer.chrome.com/docs/webstore/program-policies/spam-and-abuse) prohibits fraudulent or incentivized ratings. We ask for an honest review, without rewards, a star target, or a satisfaction survey that filters reviewers.

Chrome's [store help](https://support.google.com/chrome_webstore/answer/1050673?hl=en) directs installed users to the listing's Reviews page. The prompt follows that flow through a normal, user-clicked link. No native rating dialog or new permission is needed.

The timing thresholds are product choices, not proven conversion optima:

- Five confirmed saves, across at least three UTC days.
- At least seven UTC days since the first confirmed save.
- Show only after another confirmed save, in a visible tab with an idle, healthy save sheet.
- Never show during loading, an outstanding write, a removal confirmation, or an error.
- Keep the save status, Undo, search, and keyboard focus intact.
- Ask at most once. Dismissal, closing the sheet, or opening the store all end requests.

Repeated use is a value signal, not proof of satisfaction. The prompt welcomes any honest rating. Chrome's Featured criteria do not establish that more ratings guarantee placement.

## State and failure behavior

`lib/review.js` serializes storage operations in the service worker, across tabs. `REVIEW_SAVE` records a confirmed new save. `REVIEW_CLAIM` atomically consumes the one request before display. Only top-frame YouTube content scripts can send these messages.

The sheet reports confirmed new saves and saves into newly created playlists. It excludes failures, already-present videos, removals, Undo restorations, and saves undone before confirmation.

All state lives in `chrome.storage.local`, not sync storage. It contains capped counts, day numbers, and a prompted flag. It contains no content identifiers and never leaves the browser.

Storage errors skip the prompt without changing a save's result. A tab closed or made busy between claim and display can lose its request. This conservative race favors no interruption over another request.

Existing users start from zero because earlier versions did not record usage. Clearing extension storage or reinstalling can reset the request. The extension cannot detect an existing or newly submitted review.
