# In-Feed Limit Card V1 Plan

Status: implemented V1 with significant edge case risk.
Current planning context: June 2026.

Implementation note: this document remains the robustness reference for the shipped V1. The card is live for modern Reddit when a valid recent anchor exists, while overlay fallback remains canonical for old Reddit, narrow layouts, missing anchors, sizing failures, and repeated recovery failures.

## Executive Summary

The in-feed card concept is viable because the extension already has the hard parts: route-aware sessions, viewed-post counting, global lockouts, snooze, countdown, warning, temporary disable, and scroll blocking. The card should be a presentation upgrade layered on top of that behavior.

The plan must account for three likely failure modes:

1. React reconciliation can remove, move, or orphan extension-injected DOM.
2. Anchor posts can be removed, reordered, hidden, or unmounted.
3. Modern Reddit styling varies across hosts, themes, and A/B tests.

The safe product posture is not "make the card always work." It is "try the card when confidence is high, detect failure early, and fall back to the overlay before the page can become unlocked or confusing."

## V1 Scope

Build the in-feed limit card as a defensive modern-Reddit enhancement, not a replacement for the overlay. The guiding rule is: detect card failure early, recover briefly, then fall back to the proven overlay.

The feature is architecturally sound because it reuses the existing limiter state, post-counting, lockout, snooze, countdown, and scroll-blocking behavior. The main risk is not business logic; it is DOM reliability inside Reddit's React feed.

V1 supports modern Reddit only, adds no settings or permissions, and keeps old Reddit on the overlay path.

## Major Risks And Mitigations

### React Reconciliation Can Remove Or Move The Card

Modern Reddit is a React SPA. When the feed rerenders, React may remove extension-injected DOM because it is not in React's virtual tree. It may also reorder posts, replace parent containers, or orphan the card.

Why this matters:

- The card is inserted outside Reddit's virtual DOM.
- Infinite scroll and lazy loading cause frequent rerenders.
- Reddit may replace the parent container that holds the anchor post.
- A card that vanishes silently is worse than no card because the user may be locked without visible guidance.

Example failure:

```text
Extension inserts card after post 5.
User scrolls and Reddit lazy-loads more posts.
React rerenders the feed and removes the unknown card node.
The user remains locked, but the in-feed explanation is gone.
The extension should recover the card or show the overlay.
```

Precedent from other React-feed extensions is useful but not identical. A YouTube extension can often inject into a more stable header area; this feature injects directly into a dynamic feed, so the lifecycle monitor is not optional.

Mitigation:

- Add a card lifecycle monitor that runs only while locked.
- Validate the card every 1 second.
- Also validate after relevant mutation batches, reusing the existing mutation-observer flow.
- Confirm the card still exists, is still connected, and is still adjacent to a valid anchor.
- Reinsert or re-anchor the card when possible.
- Fall back to the overlay after 3 consecutive recovery failures.

Implementation shape:

```js
function validateFeedCard() {
  if (!this.feedCardElement || !document.contains(this.feedCardElement)) {
    return this.recoverFeedCardOrFallback();
  }

  const anchor = this.getCurrentFeedCardAnchor();
  if (!anchor || !document.contains(anchor)) {
    return this.recoverFeedCardOrFallback();
  }

  if (this.feedCardElement.previousElementSibling !== anchor) {
    return this.reanchorFeedCard(anchor);
  }

  return true;
}
```

Do not use production `console.log`; tests should inspect DOM state and behavior instead of debug logs.

### Anchor Elements Are Fragile

The post used as the card anchor may disappear or move because Reddit lazy-loads, unmounts off-screen posts, injects ads, refreshes feed content, hides posts, or removes deleted/moderated content.

Possible causes:

- User hides a post.
- A post is deleted, moderated, or removed from the live feed.
- Reddit unmounts off-screen posts to save memory.
- Feed content is reordered by refresh, sort change, or injected content.
- Ads or featured content displace nearby posts.

Example failure:

```text
t=0s: User views post 5.
t=2s: Limit triggers and card is inserted after post 5.
t=6s: User scrolls; Reddit unmounts or replaces post 5.
t=7s: Card is no longer adjacent to a meaningful anchor.
t=8s: Extension tries the last 5 valid anchors, then falls back to overlay if none remain.
```

Mitigation:

- Track a ring buffer of the last 5 viewed, non-promoted modern post anchors.
- Store both stable post IDs and live element references.
- Prefer the newest valid anchor when inserting the card.
- If the primary anchor disappears, try older anchors in order.
- If no valid anchors remain, fall back to the overlay.

Implementation shape:

```js
function recordFeedCardAnchor(postElement) {
  if (!isModernFeedPost(postElement) || isPromotedPost(postElement)) return;

  const postId = getStablePostId(postElement);
  if (!postId) return;

  this.feedCardAnchors = [
    { id: postId, element: postElement },
    ...this.feedCardAnchors.filter((anchor) => anchor.id !== postId)
  ].slice(0, 5);
}

function findRecoverableFeedCardAnchor() {
  return this.feedCardAnchors.find((anchor) =>
    anchor.element &&
    document.contains(anchor.element) &&
    isModernFeedPost(anchor.element) &&
    !isPromotedPost(anchor.element)
  );
}
```

### Modern Reddit Styling Changes Frequently

Reddit runs layout and style changes across modern surfaces. Hardcoded feed width, spacing, border, or color assumptions can break on A/B variants, light/dark themes, or host variants.

Fragile assumptions include:

- feed width
- post margin and spacing
- card padding and border radius
- light/dark background colors
- font family and font size
- grid or column layout around the feed

If these break, the card can look unrelated to the feed, overflow horizontally, overlap Reddit UI, or be hidden by surrounding layout rules.

Mitigation:

- Derive outer width and margin from the anchor post or adjacent post.
- Use extension-owned internal card styling for readable content.
- Avoid hardcoded feed-width assumptions.
- Fail back to the overlay if the card cannot be sized sanely.

Implementation shape:

```js
function applyFeedCardOuterStyle(card, anchorPost) {
  const computed = window.getComputedStyle(anchorPost);
  card.style.width = computed.width;
  card.style.maxWidth = computed.maxWidth;
  card.style.margin = computed.margin;
}
```

Do not blindly copy all computed styles. Copy only outer layout values; keep the card content controlled by extension CSS so the text and buttons remain readable.

If copied width or margin is empty, zero, extremely narrow, wider than the viewport, or otherwise invalid, skip the card and use the overlay.

## Edge Cases To Handle

### Promoted Or Sponsored Posts

The card should not anchor next to likely ads or promoted content. This is not full ad-count exclusion and should not be described that way to users. It is only a placement safeguard.

Likely signals:

- `data-promoted="true"`
- attributes or test IDs containing `promoted`, `sponsored`, or `ad`
- visible text labels such as `Promoted` or `Sponsored`
- old Reddit `.promoted`, if encountered, should still use overlay because old Reddit is not a card target

If the newest anchor is promoted, skip it and try the next non-promoted anchor. If all anchors are promoted or invalid, fall back to overlay.

### User Returns Above The Limit

When the user scrolls up or clicks `Back to viewed posts`, the card may become off-screen while still existing in the feed DOM.

Mitigation:

- Observe card visibility while locked.
- If the card scrolls fully out of view because the user returned above the limit, remove the card.
- Keep the existing locked state and downward-scroll blocking behavior canonical.

The card is not the lock itself. It is the visible explanation for the lock. Removing the card when the user returns above it is acceptable because the existing locked/suppressed state already controls whether downward movement should restore the blocker or keep the user above the limit.

### Old Reddit And Redirects

Old Reddit stays on overlay. Do not attempt card placement on `.thing.link`.

Tests should explicitly verify:

- `old.reddit.com` does not create `#reddit-scroll-limiter-feed-card`
- old Reddit still shows the overlay at the limit
- if an old Reddit URL redirects to a modern host, behavior follows the final page's detected route and post selectors

### Mobile Or Narrow Layouts

Use overlay fallback for narrow/mobile-like layouts in v1. A safe threshold can be based on viewport width, for example using the overlay below a conservative desktop width.

## Key Changes

- Add `#reddit-scroll-limiter-feed-card` as the preferred blocker presentation only when a valid modern post anchor exists.
- Keep the overlay as fallback for old Reddit, popup-started/global lockouts without an anchor, failed card placement, repeated card recovery failures, promoted-only anchors, narrow/mobile layouts, and sizing failures.
- Track recent valid modern anchors as the user views posts.
- Add a card lifecycle monitor while locked:
  - validate every 1 second
  - validate after relevant mutation batches
  - re-anchor if Reddit removes, moves, or detaches the card
  - fall back to overlay after 3 consecutive recovery failures
- Add promoted/sponsored anchor detection for placement only.
- Match feed outer layout dynamically from adjacent posts while keeping extension-owned internal styling.
- Remove/update the card on the same paths that currently remove/update the overlay: route change, snooze, disable, lockout expiry, back-to-viewed-posts, and countdown refresh.

## Implementation Design

Add feed-card state to the existing `RedditScrollLimiter` instance:

- `feedCardElement`
- `feedCardAnchors`
- `feedCardValidationTimer`
- `feedCardVisibilityObserver`
- `feedCardRecoveryFailures`
- `feedCardFallbackActive`

Add helper behavior:

- `isModernFeedPost(element)`: true for modern post selectors only.
- `isPromotedPost(element)`: best-effort placement safeguard.
- `recordFeedCardAnchor(element)`: stores last 5 valid viewed anchors.
- `showFeedCard(reason)`: tries card insertion and returns success/failure.
- `validateFeedCard()`: verifies card existence, anchor existence, and adjacency.
- `recoverFeedCardOrFallback()`: retries anchors before overlay fallback.
- `removeFeedCard()`: clears card node, validation timer, visibility observer, and card-specific counters.
- `refreshFeedCard()`: updates message/countdown/actions while locked.

Presentation choice:

```text
showBlocker(reason)
  mark blocked state
  stop active timer
  add blocked body class
  if canUseFeedCard(reason) && showFeedCard(reason):
    do not show overlay
  else:
    showOverlay(reason)
  start countdown
```

`canUseFeedCard(reason)` should reject old Reddit, narrow/mobile layouts, missing anchors, promoted-only anchors, and manual/global lockouts that do not have a current feed anchor.

## Behavior Details

- Card content mirrors existing overlay behavior:
  - `Time for a break`
  - existing post/time lockout message
  - countdown from `globalLockedUntil`
  - `Back to viewed posts`
  - `Snooze X minutes` only when `canSnooze()` is true
- `Back to viewed posts` removes the card and uses the existing return/clear-blocking behavior.
- If the card is removed by Reddit, the extension tries to recover it from the anchor buffer before falling back.
- Existing `body.reddit-scroll-limiter-blocked`, wheel/touch/keyboard blocking, snooze, countdown, and global lockout state remain canonical.
- The overlay remains fully functional and is the final fallback.
- If the card falls back to overlay, do not keep both visible at the same time.
- Card failure should not reset viewed-post counts, active time, snooze usage, or global lockout timing.

## Implementation Checklist

Before coding:

- Research how stable `shreddit-post` elements and IDs are across rerenders.
- Confirm which modern selectors are reliable enough for anchors: `shreddit-post`, `[data-testid="post-container"]`, and qualifying `article[aria-label]`.
- Check whether off-screen posts remain in DOM during normal scrolling and rapid scrolling.
- Identify available Reddit CSS variables or layout values that can be safely reused.
- Identify promoted/sponsored indicators on modern Reddit from live pages.

During implementation:

- Add feed-card state to the content script: card element, anchor buffer, validation interval, visibility observer, and consecutive recovery failure count.
- Record anchor candidates during post intersection handling.
- Render the card only from connected, non-promoted modern anchors.
- Validate the card periodically and after mutation batches.
- Recover from card removal, anchor removal, and moved adjacency.
- Remove the card on clear/snooze/route/disable/expiry paths.
- Keep overlay fallback as the default when confidence is low.
- Avoid production debug logging.
- Avoid using CSS selectors that browsers do not support, such as `span:contains("Promoted")`; inspect text content in JavaScript instead.
- Ensure cleanup is idempotent so repeated route changes, rerenders, and fallback transitions do not leave duplicate cards or timers.

## Fallback Triggers

Show the overlay instead of the card when:

1. Old Reddit is detected.
2. The viewport is too narrow for the v1 card.
3. No valid modern anchor exists.
4. Card injection fails.
5. The card cannot be sized to a sane feed width.
6. All available anchors are promoted or sponsored.
7. Card validation fails 3 consecutive times.
8. The lockout is already active from a global/manual break and there is no current route anchor.

## Test Plan

- Static: `npm run test:static`.
- Runtime smoke: keep current service worker/content-script/storage/popup checks.
- UI smoke: verify fallback overlay still renders and existing overlay interactions still pass.
- Live modern Reddit:
  - low post limit triggers `#reddit-scroll-limiter-feed-card`
  - card appears after a real modern post, not old Reddit `.thing.link`
  - card text/countdown/actions match expected lockout state
  - downward scroll remains blocked while locked
  - `Back to viewed posts` removes the card and clears visible blocking
  - snooze from the card works and removes the card
- React stability:
  - rapid scrolling after card insertion does not permanently lose the blocker
  - removing the anchor element causes re-anchor to a fallback post or overlay fallback
  - removing the card manually causes reinsertion or overlay fallback
  - repeated recovery failures show overlay after 3 attempts
  - feed pagination/lazy loading does not leave the page unlocked
  - moving the card away from the anchor causes re-anchoring or fallback
  - replacing the anchor parent container does not leave duplicate cards
- Promoted placement:
  - likely promoted anchors are skipped
  - if only promoted anchors are available, overlay is used
- Live old Reddit:
  - no card is attempted
  - overlay behavior remains current and passes existing old Reddit validation
- Release: `npm run test:release`, confirming no new permissions and no debug/test residue.

## Manual QA Scenarios

- Trigger the card on modern `https://www.reddit.com/r/popular/`.
- Scroll rapidly after the card appears and verify the blocker remains visible or falls back to overlay.
- In DevTools, remove the anchor post and verify the card re-anchors or the overlay appears.
- In DevTools, remove the card and verify recovery or overlay fallback.
- In DevTools, move the card to another part of the DOM and verify re-anchoring or overlay fallback.
- Trigger the card, then scroll enough to force feed pagination/lazy loading.
- Verify light and dark theme readability if available.
- Verify the card does not horizontally overflow the feed.
- Verify the card is not inserted next to a visible `Promoted` or `Sponsored` post when a regular anchor is available.
- Verify old Reddit still uses overlay only.

Suggested live stability loop for a manual or automated test:

```js
for (let i = 0; i < 10; i += 1) {
  window.scrollBy(0, window.innerHeight * 3);
  await new Promise((resolve) => setTimeout(resolve, 500));
  // Test should then assert that either the feed card is valid or the overlay is visible.
}
```

## Assumptions

- V1 is modern Reddit only.
- No user-facing blocker-style setting is added.
- No new storage schema is added.
- Overlay fallback is required and remains fully functional.
- Promoted detection is only used to avoid card placement next to likely ads; full ad-count exclusion remains separate research.
- Mobile/narrow layouts use overlay fallback in v1.
- The main deliverable is robustness, not just UI.

## References To Consider During Implementation

- Existing content-script MutationObserver and IntersectionObserver logic.
- Existing live Reddit post-evidence collection in `scripts/live-reddit-test.js`.
- MutationObserver API behavior for dynamic feeds.
- React reconciliation behavior for extension-injected DOM.
- Reddit Enhancement Suite as precedent for Reddit DOM modification.
