# Reddit Scroll Limiter: Product Roadmap Ideas

## Summary

These notes capture product ideas beyond the current MVP and track what has already shipped. The extension has now moved from a simple viewed-post blocker toward a more humane break system: clearer lockout wording, break countdowns, adjustable reset windows, optional snoozing, manual breaks, reliable popup status, feed-specific sessions, time-based limits, subreddit rules, warning banners, temporary disable controls, and a defensive modern Reddit in-feed limit card with overlay fallback.

The extension should feel firm but not punitive. The user is choosing guardrails for future distracted moments, so the product should make those guardrails easy to understand, hard to accidentally bypass, and respectful when the user needs flexibility.

## Roadmap Triage

### Implemented

These have been implemented and validated with automated Chromium tests as appropriate. The current suite covers static parsing, runtime extension loading/state round-trips, popup controls, packaged release checks, and live Reddit blocker behavior on modern and old Reddit. Some focused live regression tests are still useful, but they are test hardening for shipped behavior rather than unimplemented product features.

| Idea | Value | Effort | Risk | Notes |
|---|---:|---:|---:|---|
| Better lockout wording | High | Low | Low | Overlay now uses `Time for a break` and direct break copy. |
| Reliable popup status | High | Low-Medium | Low | Popup shows route, break, and snooze status from extension state. |
| Break countdown | High | Low-Medium | Low | Overlay and popup derive countdown from `globalLockedUntil`. |
| Adjustable reset window | High | Medium | Low-Medium | Popup supports `10`, `15`, `30`, `60`, `120`, and `Never`. |
| Manual break button | Medium | Low-Medium | Low | Popup can start a global break immediately. |
| Snooze toggle and basic snooze | High | Medium | Medium | Popup controls snooze; overlay offers snooze when available. |
| Feed-to-post-to-feed state restoration | High | Medium | Medium | Countable feed sessions persist in local storage and post-detail pages stay non-countable. |
| Time-based scrolling lockout | High | Medium-High | Medium | `limitMode` supports `posts`, `time`, and `both`; active seconds persist per route. |
| Temporary disable controls | Medium | Medium | Medium | Popup supports one-hour, until-next-session, and current-feed temporary disable. |
| Warning before lockout | Medium | Medium | Low-Medium | Lightweight warning banner appears once per route session at the configured threshold. |
| Simple subreddit allowlist/blocklist | High | Medium-High | Medium | Popup supports all, only listed, and exclude listed feed policies. |
| Snooze refinement | Medium | Medium | Medium | Snooze hides unavailable actions/helper copy and restores blocking after expiry when still over limit. |
| In-feed limit card V1 | High | High | High | Modern Reddit can show `#reddit-scroll-limiter-feed-card` after a real non-promoted post anchor; old Reddit, narrow layouts, weak anchors, and recovery failures still use the overlay. |

### High Effort

These are attractive, but they should wait until the storage/session model is solid.

| Idea | Value | Effort | Risk | Notes |
|---|---:|---:|---:|---|
| Per-subreddit overrides | Medium-High | High | Medium | More settings UI and policy edge cases. |
| Schedule profiles | Medium | High | Medium | Powerful, but too much before core break behavior is stable. |
| Hide posts below limit card | Medium-High | High | High | More invasive than V1 card placement because Reddit may append, reorder, or virtualize feed content. |

### Needs Research

These may be valuable, but we should not ship them until live testing proves they are reliable.

| Idea | Value | Effort | Risk | Notes |
|---|---:|---:|---:|---|
| Exact popup viewed-post count | Medium | Medium | Medium-High | Depends on robust post-card detection. |
| Ad/promoted-card exclusion | Medium | Medium-High | High | Reddit ad markup is unstable and may mimic posts. |
| "Feed items viewed" wording | Medium | Low | Product risk | More honest if ads cannot be excluded, but less satisfying. |

## Recommended Next Work

1. Replace placeholder icons before store submission.
2. Add focused live regression coverage for the newly shipped medium bundle:
   - feed-to-post-to-feed restoration on real Reddit navigation
   - subreddit `only_listed` and `exclude_listed` behavior
   - time-based limits with a very low test value
   - snooze expiry restoring the blocker
   - short reset-window expiry starting a fresh route session
3. Harden in-feed card V1 with focused live/manual regressions:
   - rapid scrolling after card insertion
   - anchor removal and card removal recovery
   - light/dark theme readability
   - promoted-anchor skip behavior
   - narrow/mobile overlay fallback
4. Research ad/promoted-card detection and decide whether the popup can safely show exact viewed-post counts.
5. Consider per-subreddit overrides if users want different post/time/break limits per feed.
6. Consider schedule profiles after the core session behavior has more real-world soak time.

## Settings Model

Implemented synced preferences:

```json
{
  "enabled": true,
  "postLimit": 100,
  "lockoutMinutes": 30,
  "resetAfterMinutes": 30,
  "snoozeEnabled": true,
  "snoozeMinutes": 5,
  "snoozeLimitPerSession": 1,
  "showCountdown": true,
  "limitMode": "posts",
  "timeLimitMinutes": 30,
  "pauseTimerWhenTabHidden": true,
  "subredditMode": "all",
  "subredditAllowlist": [],
  "subredditBlocklist": [],
  "warningEnabled": true,
  "warningThresholdPercent": 80
}
```

Implemented local session state:

```json
{
  "globalLockedUntil": 1780774920000,
  "disabledUntil": null,
  "disabledUntilSessionReset": false,
  "disabledRouteKeys": [],
  "lastKnownRoute": {
    "key": "subreddit:popular",
    "label": "r/popular",
    "href": "https://www.reddit.com/r/popular/",
    "updatedAt": 1780773120000
  },
  "routes": {
    "subreddit:popular": {
      "seenPostIds": ["abc123", "def456"],
      "viewedPostCount": 42,
      "sessionStartedAt": 1780771200000,
      "lastActivityAt": 1780773120000,
      "activeSeconds": 742,
      "lastActiveTickAt": null,
      "warningShown": false,
      "snoozedUntil": null,
      "snoozesUsed": 0
    }
  }
}
```

Use `chrome.storage.sync` for lightweight user settings and `chrome.storage.local` for route/session state. Do not rely on service worker memory for state; MV3 service workers can idle and lose globals.

## Implemented Quick Wins

### Better Lockout Wording

Current status: implemented.

Overlay copy now follows this direction:

Title:
> Time for a break

Post limit:
> You have scrolled through 100 posts. Come back in 30 minutes.

Time limit:
> You have been scrolling for 30 minutes. Come back in 30 minutes.

Both:
> You have scrolled through 100 posts in 24 minutes. Come back in 30 minutes.

Locked:
> Reddit scrolling is paused until 3:42 PM.

Snooze:
> Need a little longer? You can snooze once for 5 minutes.

Button labels:
- `Back to viewed posts`
- `Snooze 5 minutes`
- `Open settings`
- `Start break now`

Avoid:
- "You are blocked"
- "Access denied"
- "Productivity failed"
- overly cute language

Follow-up:
- Consider changing `Hide message` to something clearer, such as `Hide until I scroll down`.
- Re-check the `both` mode copy after focused live time-limit testing.

### Reliable Popup Status

Current status: implemented.

The popup prioritizes status that comes from explicit extension state rather than exact DOM post classification.

Recommended reliable status v1:
- `Break active until 3:42 PM`
- `Snoozed until 3:17 PM`
- `Limiter active on r/popular`

Why this is realistic:
- `Break active until` comes from `globalLockedUntil`.
- `Snoozed until` comes from route session state.
- `Limiter active on r/popular` comes from URL route parsing and settings.
- None of these require perfect ad detection or exact post-card counting.

Needs further work:
- `r/popular: 42 of 100 posts viewed`
- `42 of 100 feed items viewed`
- ad/promoted-card exclusion

Implementation notes:
- The popup reads `chrome.storage.local` directly for global lockout/snooze state.
- Active route status uses last-known route state from the content script.
- No `tabs` or `activeTab` permission was added.

### Break Countdown

Current status: implemented.

The overlay and popup show countdown/status from `globalLockedUntil`.

Overlay:
> Reddit scrolling is paused. Come back in 24 minutes.

Popup:
> Break active until 3:42 PM.

Setting:
- `showCountdown`, default `true`.

If disabled:
> Reddit scrolling is paused. Take a break and come back later.

Edge cases:
- If the system clock changes, recalculate from `Date.now()` on the next tick.
- If `globalLockedUntil <= Date.now()`, clear the lockout state and remove the overlay.

Follow-up:
- Add a compact `Come back in X minutes` line to the popup, not only the exact clock time.

### Adjustable Reset Window

Current status: implemented.

Default behavior: reset the browsing session after 30 minutes of inactivity. This is adjustable in the popup.

Popup control:
- Label: `Reset session after`
- Type: select first, number input later if needed
- Suggested options: `10 min`, `15 min`, `30 min`, `1 hour`, `2 hours`, `Never`
- Default: `30 min`

Meaning:
- The reset window is inactivity-based, not wall-clock from the first post.
- If the user has not actively browsed a countable Reddit feed for the configured window, the next visit starts fresh.
- If the user is still actively scrolling, the session should not reset underneath them.

Edge cases:
- If `resetAfterMinutes` is `null` or `0`, never reset automatically.
- If a global lockout is active, do not clear it just because route state expired.
- If a user changes the reset window in the popup, apply it on the next route/session check rather than surprise-clearing an active overlay mid-interaction.

Follow-up:
- Add a targeted regression test for stale route state expiry, beyond the current full-suite coverage.

### Manual Break Button

Current status: implemented.

The popup has a button that lets the user start a break immediately.

Button:
- `Start break now`

Behavior:
- Sets `globalLockedUntil = Date.now() + lockoutMinutes * 60_000`.
- Any open Reddit feed shows the overlay on the next storage change or route check.

Why it fits:
- Some users will notice they are drifting before the extension catches them.
- It turns the tool into a self-control assist, not only an automatic stop.

Follow-up:
- Consider adding `End current break` in popup settings, but keep it secondary.

### Basic Snooze

Current status: implemented.

The overlay has a snooze button when snooze is enabled and the route session has snoozes remaining. The popup controls whether snooze is allowed, its length, and uses per session.

Popup controls:
- Toggle: `Allow snooze`
- `Snooze length`: default `5 minutes`
- `Snoozes per session`: default `1`

Session fields:
- `snoozedUntil`
- `snoozesUsed`
- `snoozeLimitPerSession`

Behavior:
- Snooze hides the overlay and temporarily permits scrolling.
- Snooze does not reset viewed-post count or active time.
- If `Date.now() < snoozedUntil`, suppress the overlay but keep counting.
- Once snooze expires, restore the blocker if the user is still over the limit or globally locked.
- If snooze is disabled while currently snoozed, cancel the active snooze and restore the blocker if the limit still applies.

Popup status:
- `Snoozed until 3:17 PM`

Copy:
> Snooze gives you a short extension without resetting the limit.

Follow-up:
- Make the disabled/used snooze state more explicit in the overlay.
- Add a live test that waits through a short snooze expiry and verifies the blocker returns.

## Implemented Medium-Effort Features

### Feed-to-Post-to-Feed State Restoration

Current status: implemented.

Original risk:
- A user may hit the limit on `/r/popular`, click into a post detail page, then navigate back.
- Reddit may preserve the feed DOM, remount it, or partially rerender it.
- Without stored route/session state, the extension may either recount old posts or forget the limit.

Desired behavior:
- Post detail pages should not count comments as feed posts.
- Moving from feed to post detail should pause counting but keep session state.
- Returning to the same feed route should restore the existing session count.
- Returning after the reset window has expired should start fresh.

Implemented approach:
- Compute a stable `routeKey` for countable feed routes:
  - `/`
  - `/home`
  - `/r/<subreddit>`
  - `/r/popular`
  - `/r/all`
  - `/search?q=<query>`
- Do not count `/r/<subreddit>/comments/...`.
- Store session state by `routeKey` in `chrome.storage.local`.
- On route change:
  - If moving from feed to post detail, save current route state.
  - If moving from post detail back to the same feed, restore route state.
  - If moving to a different countable feed, load or create that route session.

Recommended policy:
- Keep viewed-post counts per route.
- Keep active lockouts global across Reddit, so switching subreddits cannot bypass a break.

Further tests to add:
- Real Reddit: hit a low limit on `r/popular`, click a real post, go back, verify lock/count state is preserved.
- Real Reddit: click from one subreddit feed to another, verify separate route state and global lockout policy.

### Time-Based Scrolling Lockout

Current status: implemented.

The extension supports a time limit in addition to the post limit.

Example settings:
- `postLimit`: default `100`
- `timeLimitMinutes`: default `30`
- `lockoutMinutes`: default `30`
- `limitMode`: `posts`, `time`, or `both`
- `pauseTimerWhenTabHidden`: default `true`

Popup controls:
- `Limit by`: segmented control with `Posts`, `Time`, `Both`
- `Post limit`: number input and slider
- `Time limit`: select or number input
- `Break length`: select or number input

Implemented behavior:
- Start active-time tracking while the user is on an enabled, limited, countable Reddit route.
- Count active browsing time while the tab is visible.
- Pause time counting when `document.visibilityState !== "visible"` if `pauseTimerWhenTabHidden` is enabled.
- Lock browsing when either:
  - viewed posts reach `postLimit`, or
  - active browsing time reaches `timeLimitMinutes`.
- Set `globalLockedUntil = Date.now() + lockoutMinutes * 60_000`.

Recommended policy:
- Counts and active time are route-specific.
- Lockouts are global.
- Switching subreddits should not bypass an active break.

Implementation caution:
- Do not run persistent background timers.
- Track time in the content script while Reddit is open and persist `activeSeconds` periodically.
- On page hide/unload, flush session state if possible.

### Temporary Disable Controls

Current status: implemented.

Avoid making uninstalling the extension the only bypass path.

Possible controls:
- `Disable until next session`
- `Disable for 1 hour`
- `Disable on this subreddit`

Current placement:
- Put these in the popup settings first.
- Keep them out of the overlay initially.
- Avoid making bypass controls more prominent than `Back to viewed posts` and `Snooze`.

Storage:
- `disabledUntil`
- `disabledRouteKeys`

Privacy note:
- These are local preferences/session controls. They should not leave the device.

### Warning Before Lockout

Current status: implemented.

The extension shows a warning before the full lockout.

Examples:
- At 80 percent of post limit:
  > You are close to your Reddit limit: 80 of 100 posts.
- At 5 minutes remaining:
  > 5 minutes left before your Reddit break.

Implemented approach:
- Add `warningThresholdPercent`, default `80`.
- Show a lightweight banner, not a blocking overlay.
- Auto-dismiss the warning after a few seconds.
- Add a route-session flag so the warning appears once per session.

Reasoning:
- Warnings make the lockout feel less abrupt.
- They give the user a chance to leave intentionally instead of being stopped mid-scroll.

### Simple Subreddit Allowlist and Blocklist

Current status: implemented.

Subreddit-specific rules let users decide where the limiter applies.

Examples:
- Limit only `r/popular`.
- Exempt supportive or intentional subreddits.
- Apply the limiter everywhere except listed communities.

Implemented first version:
- Mode select:
  - `Limit all Reddit feeds`
  - `Only limit listed feeds`
  - `Do not limit listed feeds`
- Text field:
  - `popular, all, askreddit`
- Helper text:
  - `Use names like popular, all, askreddit. Do not include r/.`

Settings:

```json
{
  "subredditMode": "all",
  "subredditAllowlist": ["popular"],
  "subredditBlocklist": []
}
```

Implemented details:
- Parse subreddit from `location.pathname`.
- Treat `r/popular` as route key `popular`.
- Treat `r/all` as route key `all`.
- Treat home and search as special route keys: `home`, `search`.
- User profiles should stay non-countable unless a clear feed container is detected.

Policy edge cases:
- `r/popular` and `r/all` should be treated as high-distraction defaults.
- Search results should be limitable separately because they can become feeds.
- `only_listed` mode should probably include home/search only if explicitly listed as `home` or `search`.

## High Effort

### Per-Subreddit Overrides

Future version of subreddit rules.

Settings shape:

```json
{
  "subredditOverrides": {
    "popular": {
      "postLimit": 25,
      "timeLimitMinutes": 10,
      "lockoutMinutes": 30
    }
  }
}
```

Use cases:
- Stricter limits for `popular` and `all`.
- Softer limits for intentional communities.
- Different lockout length by subreddit.

Why it is high effort:
- Needs more settings UI.
- Needs policy precedence rules.
- Needs tests for default settings, mode settings, and per-subreddit overrides.

Suggested precedence:
1. Global disabled state.
2. Temporary disabled state.
3. Active global lockout.
4. Subreddit mode include/exclude decision.
5. Subreddit override.
6. Global limit settings.

### Schedule Profiles

Optional future feature: stricter rules during work hours.

Examples:
- Work hours: 25 posts or 10 minutes, then 30-minute break.
- Evening: 100 posts or 30 minutes, then 15-minute break.
- Weekend: disabled or softer limits.

Implementation idea:
- Add `profiles`, each with:
  - days of week
  - start time
  - end time
  - settings override
- Evaluate the active profile in the content script using local browser time.

Why it is high effort:
- Time-zone and local-time edge cases.
- UI gets larger quickly.
- Needs careful copy so users understand which profile is active.

Recommendation:
- Defer until core lockout/session behavior feels excellent.

### In-Feed Limit Card V1

Implemented modern Reddit enhancement: instead of always showing a modal-style overlay, insert a native-looking card into the Reddit feed when the extension has a connected, recent, non-promoted modern post anchor.

Example card copy:
> Time for a break
>
> You have scrolled through 100 posts. Come back in 30 minutes.

Implemented buttons:
- `Back to viewed posts`
- `Snooze 5 minutes`

Implemented behavior:
- Insert the limiter card after the newest valid modern Reddit anchor.
- Track a ring buffer of recent valid anchors so the card can recover if Reddit removes or remounts the primary anchor.
- Validate the card while locked on a one-second lifecycle timer and after relevant mutation batches.
- Re-anchor or reinsert the card when possible.
- Fall back to the overlay after repeated recovery failures.
- Skip likely promoted/sponsored anchors for card placement only.
- Use overlay fallback for old Reddit, narrow/mobile-like layouts, missing anchors, sizing failures, and active global lockouts without a current route anchor.
- Block downward wheel, touch, and keyboard scroll while locked.
- Allow upward scroll so the user can move back through already viewed content.
- Keep the overlay as the canonical fallback.

Implementation shape:
- Create an extension-owned card with ID `reddit-scroll-limiter-feed-card`.
- Derive outer layout values from the anchor post while keeping extension-owned internal card styling for readability.
- Keep a lifecycle monitor running only while locked.
- Reuse the existing global lockout, countdown, snooze, back-to-viewed-posts, and scroll-blocking behavior.

Why it is attractive:
- Feels more native than a modal.
- Makes the break feel like part of the feed on modern Reddit.
- Could reduce the jarring feel of a full-screen blocker.

Why it remains risky:
- Reddit has multiple layouts: modern, old, `sh.reddit.com`, `new.reddit.com`, and A/B variants.
- Feed containers and post-card boundaries are not guaranteed stable.
- Ads/promoted cards may resemble normal posts.
- Reddit may virtualize or remount feed content, which can move or remove the inserted card.
- Hiding content below the limiter card is still deferred because it is more invasive than V1 placement.
- Needs stronger live testing across real Reddit pages.

Follow-up:
- Keep `IN_FEED_LIMIT_CARD_PLAN.md` as the robustness reference for edge cases and manual QA.
- Add more live/manual stress coverage before considering hidden-below-limit behavior.
- Do not describe promoted-anchor skipping as full ad exclusion; exact ad-count exclusion remains separate research.

## Needs Research

### Exact Popup Viewed-Post Count

The idea:
- Show `r/popular: 42 of 100 posts viewed` in the popup.

Why it is useful:
- Makes the limiter feel legible.
- Lets the user understand how close they are to the break.

Why it needs more work:
- The count depends on stable post-card detection.
- Reddit markup changes across old/new/sh layouts.
- Ads/promoted cards may resemble normal posts.
- The current live tests prove basic counting works, but not that the count is always semantically perfect.

Recommended path:
- Do not block reliable status on this.
- First show route and lockout/snooze status.
- Later add viewed count only when the content script has a confident route session.
- Consider wording as `feed items viewed` if ad exclusion remains imperfect.

### Ad and Promoted-Card Exclusion

Possible heuristics:
- Skip elements containing visible labels like `Promoted`, `Sponsored`, or `Ad`.
- Skip old Reddit `.promoted` items.
- Prefer cards with real `/comments/<id>` permalinks.
- Avoid counting cards without stable post IDs.

Why it is hard:
- Ads can mimic normal posts.
- Some promoted posts may have comments/permalinks.
- Reddit may change labels and containers.

Testing requirement:
- Live tests should capture evidence for candidate cards:
  - ID
  - permalink
  - title/snippet
  - whether promoted/sponsored text was detected
- The test should not fail on a single ambiguous promoted card until the heuristic is proven.

Recommendation:
- Treat ad exclusion as a best-effort quality improvement, not a guarantee.
- Avoid strong user-facing claims like "ads are never counted" unless proven across layouts.

## Test Ideas

### Implemented Regression Coverage

- Popup: verify `Break active until 3:42 PM` renders from seeded local storage.
- Popup: verify `Snoozed until 3:17 PM` renders from seeded route state.
- Popup: verify `Limiter active on r/popular` renders from last known route state.
- Runtime: verify the extension service worker loads.
- Runtime: verify the content script initializes on `www.reddit.com` and persists home route state.
- Runtime: verify settings and local state round-trip through extension storage.
- UI: verify medium-effort popup controls persist, including limit mode, time limit, pause-when-hidden, feed rules, warnings, and temporary-disable buttons.
- Live Reddit: verify modern and old Reddit show the new `Time for a break` copy at low limits.
- Release: verify packaged `dist/` still passes live Reddit validation with no new permissions.

### Remaining Medium-Bundle Hardening Tests

- Real Reddit: hit limit on `https://www.reddit.com/r/popular/`, click a real post, go back, verify lock/count state is preserved.
- Real Reddit: hit a time-based limit with a very low test setting, verify lockout persists across refresh.
- Real Reddit: enable snooze, hit the limit, snooze once, verify scrolling works until snooze expiry and the blocker returns.
- Real Reddit: disable snooze in the popup, hit the limit, verify no snooze button appears.
- Real Reddit: set reset window to a very short test value, wait for inactivity reset, verify the next feed session starts fresh.
- Real Reddit: set `r/popular` as the only limited subreddit, verify `r/popular` locks and another subreddit does not.

### High Effort Tests

- Real Reddit: validate in-feed limit card placement on modern Reddit.
- Real Reddit: validate hidden-below-limit behavior while new posts are appended.
- Real Reddit: validate old Reddit behavior separately; soft-skip if old Reddit blocks automation.
- Release: ensure session state uses `chrome.storage.local` and no browsing data is transmitted.
