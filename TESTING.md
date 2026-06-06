# Testing

## Static Checks

```powershell
npm run test:static
```

This syntax-checks the service worker, popup script, and Reddit content script.

## Full Test Pass

```powershell
npm run test:all
```

Run extension tests sequentially, including release-readiness validation. Do not run storage-backed browser tests in parallel because they use the same unpacked extension ID and `chrome.storage.sync`, so concurrent runs can overwrite each other's configured post limits.

## Release Package

```powershell
npm run build:dist
```

This creates a clean `dist/` folder with only store-loadable extension assets:

- `manifest.json`
- `background.js`
- `content-scripts/`
- `popup/`
- `images/`

Do not upload the project root to the Chrome Web Store. The project root includes tests, artifacts, docs, and research notes.

## Release-Readiness Test

```powershell
npm run test:release
```

This rebuilds `dist/`, validates the packaged extension, then runs live Reddit validation against the packaged `dist/` extension. It checks:

- `dist/` excludes tests, artifacts, docs, and package metadata
- packaged JS has no debug/test residue such as `__redditScrollLimiter`
- manifest permissions are limited to `storage`
- no remote scripts, styles, analytics endpoints, or broad host permissions are present
- icon files match the manifest dimensions
- `PRIVACY.md` documents local-only `chrome.storage.sync` settings
- fresh install defaults restore `postLimit = 100`, `enabled = true`, post-based mode, warning defaults, and time/subreddit/snooze settings
- packaged `dist/` passes live Reddit validation, including the modern in-feed card path and old Reddit overlay fallback

The release test notes that the current icons are development placeholders. Replace them with polished icons before store submission unless you explicitly approve shipping the placeholders.

## Automated Chromium Smoke Test

```powershell
npm run test:runtime
```

The runtime smoke test launches an automation-friendly Chromium browser with this folder loaded as an unpacked extension. It verifies that the service worker loads, the content script initializes on `www.reddit.com`, route state is persisted through `chrome.storage.local`, configured settings round-trip through extension storage, and the popup page renders without inline-script CSP issues. It does not inject fake Reddit posts or validate post-count blocker behavior; live Reddit tests cover that behavior against real rendered posts.

By default, the test prefers Chrome for Testing or Chromium, then falls back to Microsoft Edge. Normal branded Google Chrome is not used by default because recent Chrome builds ignore `--load-extension` in command-line automation.

To force a specific browser:

```powershell
$env:RSL_BROWSER_PATH = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
npm run test:runtime
```

For exact consumer Chrome validation, load the extension manually:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select `C:\Users\Home\redditFiniteScroll`.
5. Refresh any open Reddit tabs.

## Automated UI Smoke Test

```powershell
npm run test:ui
```

This launches the same automation-friendly Chromium browser and checks visual/interaction basics:

- popup controls render inside the fixed 320px body without horizontal overflow
- popup reset keeps the number input, slider, and display synchronized
- limit mode, time limit, pause-when-hidden, feed rules, warning controls, and temporary-disable buttons persist to extension storage
- old Reddit fallback blocker overlay covers the viewport and focuses the primary action
- Escape hides the blocker message
- downward scrolling restores the blocker
- Back to viewed posts clears the blocked state

The test writes screenshots to:

- `artifacts/popup-ui.png`
- `artifacts/blocker-ui.png`

## Live Reddit UI and Functionality Test

```powershell
npm run test:live
```

This is an on-demand live-site test. It uses public Reddit pages anonymously and does not inject fake posts, replace Reddit's DOM, use credentials, or rely on saved cookies. It configures the extension with a low post limit through the real popup/extension storage, then validates the limiter against actual rendered Reddit posts.

Because this hits the live Reddit website, failures can come from network issues, Reddit outages, anti-bot pages, consent/interstitial pages, or markup changes. For that reason, this test is intended for local validation rather than a hard CI gate.

The test checks:

- popup reflects live configured storage (`postLimit = 5`) plus post-based mode, warning defaults, feed-rule defaults, and timer defaults
- `https://www.reddit.com/r/popular/` renders real post candidates
- real post IDs/permalinks are collected from Reddit DOM
- at least five distinct real posts cross the viewport while scrolling
- modern Reddit shows `#reddit-scroll-limiter-feed-card` after a real feed post with `You have scrolled through 5 posts`
- downward scroll remains blocked while the modern in-feed card is active
- Back to viewed posts clears the modern in-feed card path
- optional `https://old.reddit.com/r/popular/` coverage activates at three real posts or soft-skips with a reason
- old Reddit never creates `#reddit-scroll-limiter-feed-card` and keeps using the overlay fallback

The test writes screenshots to:

- `artifacts/live-popup-ui.png`
- `artifacts/live-reddit-blocker-ui.png`
- `artifacts/live-old-reddit-blocker-ui.png` when old Reddit coverage activates

Useful overrides:

```powershell
$env:RSL_BROWSER_PATH = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$env:RSL_LIVE_REDDIT_URL = "https://www.reddit.com/r/popular/"
$env:RSL_LIVE_POST_LIMIT = "5"
npm run test:live
```
