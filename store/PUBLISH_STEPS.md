# Publish Steps

1. Host `docs/` publicly (recommended: GitHub Pages).
2. Confirm these URLs are reachable:
   - https://ydoc5212.github.io/playlist-search-extension/
   - https://ydoc5212.github.io/playlist-search-extension/privacy-policy.html
   - https://ydoc5212.github.io/playlist-search-extension/support.html
3. Build upload ZIP:
   - `scripts/build-store-zip.sh`
4. Upload `dist/youtube-playlist-filter-<version>.zip` to Chrome Web Store Developer Dashboard.
5. Fill listing using `store/CWS_SUBMISSION.md`.
6. Upload store assets from `store-assets/`.
7. Run through `QA_CHECKLIST.md` and resolve any failures.
