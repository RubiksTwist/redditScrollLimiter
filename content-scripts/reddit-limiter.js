(() => {
  const DEFAULT_SETTINGS = {
    postLimit: 100,
    enabled: true,
    resetAfterMinutes: 30,
    lockoutMinutes: 30,
    snoozeEnabled: true,
    snoozeMinutes: 5,
    snoozeLimitPerSession: 1,
    showCountdown: true,
    limitMode: "posts",
    timeLimitMinutes: 30,
    pauseTimerWhenTabHidden: true,
    subredditMode: "all",
    subredditAllowlist: [],
    subredditBlocklist: [],
    warningEnabled: true,
    warningThresholdPercent: 80
  };
  const LOCAL_STATE_KEY = "redditScrollLimiterState";
  const MIN_LIMIT = 1;
  const MAX_LIMIT = 500;
  const POST_SELECTOR = [
    "shreddit-post",
    "article[aria-label]",
    "[data-testid=\"post-container\"]",
    ".thing.link"
  ].join(",");
  const MODERN_POST_SELECTOR = "shreddit-post, article[aria-label], [data-testid=\"post-container\"]";
  const OVERLAY_ID = "reddit-scroll-limiter-overlay";
  const FEED_CARD_ID = "reddit-scroll-limiter-feed-card";
  const WARNING_ID = "reddit-scroll-limiter-warning";
  const ROUTE_POLL_MS = 500;
  const MUTATION_DEBOUNCE_MS = 150;
  const STATE_SAVE_DEBOUNCE_MS = 250;
  const COUNTDOWN_REFRESH_MS = 30000;
  const ACTIVE_TIME_TICK_MS = 1000;
  const WARNING_DISMISS_MS = 5500;
  const FEED_CARD_VALIDATE_MS = 1000;
  const FEED_CARD_MAX_ANCHORS = 5;
  const FEED_CARD_MAX_RECOVERY_FAILURES = 3;
  const FEED_CARD_MIN_VIEWPORT_WIDTH = 700;
  const FEED_CARD_MIN_WIDTH = 280;
  const VIEW_THRESHOLD = 0.5;
  const RETURN_ZONE_PX = 120;
  const DOWN_KEYS = new Set([" ", "Spacebar", "PageDown", "ArrowDown", "End"]);

  class RedditScrollLimiter {
    constructor(settings, state) {
      this.settings = normalizeSettings(settings);
      this.state = normalizeLocalState(state);
      this.enabled = false;
      this.blocked = false;
      this.lockSuppressedAboveLimit = false;
      this.overlayHiddenByEscape = false;
      this.seenPostIds = new Set();
      this.observedPosts = new WeakSet();
      this.currentRoute = getRouteInfo();
      this.lastUrl = window.location.href;
      this.lastScrollY = window.scrollY;
      this.limitReachedY = 0;
      this.touchStartY = 0;
      this.lastLockReason = "";
      this.mutationObserver = null;
      this.intersectionObserver = null;
      this.mutationTimer = 0;
      this.routeTimer = 0;
      this.stateSaveTimer = 0;
      this.countdownTimer = 0;
      this.activeTimeTimer = 0;
      this.warningTimer = 0;
      this.feedCardElement = null;
      this.feedCardAnchors = [];
      this.feedCardValidationTimer = 0;
      this.feedCardVisibilityObserver = null;
      this.feedCardRecoveryFailures = 0;
      this.feedCardFallbackActive = false;

      this.handleStorageChange = this.handleStorageChange.bind(this);
      this.handlePopstate = this.handlePopstate.bind(this);
      this.handleWheel = this.handleWheel.bind(this);
      this.handleTouchStart = this.handleTouchStart.bind(this);
      this.handleTouchMove = this.handleTouchMove.bind(this);
      this.handleKeydown = this.handleKeydown.bind(this);
      this.handleScroll = this.handleScroll.bind(this);
      this.handleRoutePoll = this.handleRoutePoll.bind(this);
      this.handleMutations = this.handleMutations.bind(this);
      this.handleIntersections = this.handleIntersections.bind(this);
      this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
      this.handleActiveTimeTick = this.handleActiveTimeTick.bind(this);
      this.handleFeedCardVisibility = this.handleFeedCardVisibility.bind(this);
    }

    init() {
      chrome.storage.onChanged.addListener(this.handleStorageChange);
      window.addEventListener("popstate", this.handlePopstate);
      window.addEventListener("wheel", this.handleWheel, { capture: true, passive: false });
      window.addEventListener("touchstart", this.handleTouchStart, { capture: true, passive: true });
      window.addEventListener("touchmove", this.handleTouchMove, { capture: true, passive: false });
      window.addEventListener("keydown", this.handleKeydown, true);
      window.addEventListener("scroll", this.handleScroll, { passive: true });
      document.addEventListener("visibilitychange", this.handleVisibilityChange);

      this.startRoutePolling();
      this.reconcileGlobalLockout();

      if (this.settings.enabled && this.currentRoute.countable && (this.isCurrentRouteLimited() || this.state.globalLockedUntil > Date.now())) {
        this.start();
      } else {
        this.persistLastKnownRoute();
      }
    }

    start() {
      if (this.enabled || !this.currentRoute.countable || (!this.isCurrentRouteLimited() && !(this.state.globalLockedUntil > Date.now()))) {
        return;
      }

      this.enabled = true;
      this.loadRouteSession();
      this.startObservers();
      this.scanForPosts();
      this.startActiveTimeTracking();
      this.enforceStateIfNeeded();
    }

    stop() {
      this.enabled = false;
      this.blocked = false;
      this.lockSuppressedAboveLimit = false;
      this.overlayHiddenByEscape = false;
      this.seenPostIds.clear();
      this.observedPosts = new WeakSet();
      this.stopObservers();
      this.stopRoutePolling();
      this.stopCountdown();
      this.stopActiveTimeTracking();
      this.removeWarning();
      this.removeFeedCard();
      this.removeOverlay();
      document.body.classList.remove("reddit-scroll-limiter-blocked");
      this.scheduleStateSave();
    }

    pauseCurrentRoute() {
      this.saveCurrentRouteSession();
      this.enabled = false;
      this.blocked = false;
      this.lockSuppressedAboveLimit = false;
      this.overlayHiddenByEscape = false;
      this.seenPostIds.clear();
      this.observedPosts = new WeakSet();
      this.stopObservers();
      this.stopCountdown();
      this.stopActiveTimeTracking();
      this.removeWarning();
      this.removeFeedCard();
      this.removeOverlay();
      document.body.classList.remove("reddit-scroll-limiter-blocked");
      this.persistLastKnownRoute();
    }

    startObservers() {
      if (!this.intersectionObserver) {
        this.intersectionObserver = new IntersectionObserver(this.handleIntersections, {
          threshold: [VIEW_THRESHOLD]
        });
      }

      if (!this.mutationObserver && document.body) {
        this.mutationObserver = new MutationObserver(this.handleMutations);
        this.mutationObserver.observe(document.body, {
          childList: true,
          subtree: true
        });
      }
    }

    stopObservers() {
      clearTimeout(this.mutationTimer);
      this.mutationTimer = 0;

      if (this.mutationObserver) {
        this.mutationObserver.disconnect();
        this.mutationObserver = null;
      }

      if (this.intersectionObserver) {
        this.intersectionObserver.disconnect();
        this.intersectionObserver = null;
      }
    }

    startRoutePolling() {
      if (!this.routeTimer) {
        this.routeTimer = setInterval(this.handleRoutePoll, ROUTE_POLL_MS);
      }
    }

    stopRoutePolling() {
      if (this.routeTimer) {
        clearInterval(this.routeTimer);
        this.routeTimer = 0;
      }
    }

    startCountdown() {
      if (!this.countdownTimer) {
        this.countdownTimer = setInterval(() => this.refreshCountdown(), COUNTDOWN_REFRESH_MS);
      }
    }

    stopCountdown() {
      if (this.countdownTimer) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = 0;
      }
    }

    startActiveTimeTracking() {
      if (this.activeTimeTimer || !this.shouldTrackActiveTime()) {
        return;
      }

      this.markActiveTickStart();
      this.activeTimeTimer = setInterval(this.handleActiveTimeTick, ACTIVE_TIME_TICK_MS);
    }

    stopActiveTimeTracking() {
      if (this.activeTimeTimer) {
        clearInterval(this.activeTimeTimer);
        this.activeTimeTimer = 0;
      }
      this.clearActiveTickStart();
    }

    restartActiveTimeTracking() {
      this.stopActiveTimeTracking();
      this.startActiveTimeTracking();
    }

    handleStorageChange(changes, areaName) {
      if (areaName === "sync") {
        const nextSettings = {
          ...this.settings,
          postLimit: changes.postLimit ? changes.postLimit.newValue : this.settings.postLimit,
          enabled: changes.enabled ? changes.enabled.newValue : this.settings.enabled,
          resetAfterMinutes: changes.resetAfterMinutes ? changes.resetAfterMinutes.newValue : this.settings.resetAfterMinutes,
          lockoutMinutes: changes.lockoutMinutes ? changes.lockoutMinutes.newValue : this.settings.lockoutMinutes,
          snoozeEnabled: changes.snoozeEnabled ? changes.snoozeEnabled.newValue : this.settings.snoozeEnabled,
          snoozeMinutes: changes.snoozeMinutes ? changes.snoozeMinutes.newValue : this.settings.snoozeMinutes,
          snoozeLimitPerSession: changes.snoozeLimitPerSession ? changes.snoozeLimitPerSession.newValue : this.settings.snoozeLimitPerSession,
          showCountdown: changes.showCountdown ? changes.showCountdown.newValue : this.settings.showCountdown,
          limitMode: changes.limitMode ? changes.limitMode.newValue : this.settings.limitMode,
          timeLimitMinutes: changes.timeLimitMinutes ? changes.timeLimitMinutes.newValue : this.settings.timeLimitMinutes,
          pauseTimerWhenTabHidden: changes.pauseTimerWhenTabHidden ? changes.pauseTimerWhenTabHidden.newValue : this.settings.pauseTimerWhenTabHidden,
          subredditMode: changes.subredditMode ? changes.subredditMode.newValue : this.settings.subredditMode,
          subredditAllowlist: changes.subredditAllowlist ? changes.subredditAllowlist.newValue : this.settings.subredditAllowlist,
          subredditBlocklist: changes.subredditBlocklist ? changes.subredditBlocklist.newValue : this.settings.subredditBlocklist,
          warningEnabled: changes.warningEnabled ? changes.warningEnabled.newValue : this.settings.warningEnabled,
          warningThresholdPercent: changes.warningThresholdPercent ? changes.warningThresholdPercent.newValue : this.settings.warningThresholdPercent
        };

        this.settings = normalizeSettings(nextSettings);

        if (!this.settings.enabled) {
          this.stop();
          return;
        }

        this.startRoutePolling();
        this.reconcileGlobalLockout();

        if (!this.enabled && this.currentRoute.countable) {
          this.start();
          return;
        }

        if (this.enabled) {
          this.cancelSnoozeIfDisabled();
          this.restartActiveTimeTracking();
          this.enforceStateIfNeeded();
        }

        return;
      }

      if (areaName === "local" && changes[LOCAL_STATE_KEY]) {
        this.state = normalizeLocalState(changes[LOCAL_STATE_KEY].newValue);
        this.enforceStateIfNeeded();
      }
    }

    handleMutations() {
      if (!this.enabled || !this.currentRoute.countable || !this.isCurrentRouteLimited()) {
        return;
      }

      clearTimeout(this.mutationTimer);
      this.mutationTimer = setTimeout(() => {
        this.scanForPosts();
        if (this.blocked) {
          this.validateFeedCard();
        }
      }, MUTATION_DEBOUNCE_MS);
    }

    scanForPosts() {
      if (!this.enabled || !this.intersectionObserver || !this.currentRoute.countable || !this.isCurrentRouteLimited() || this.isTemporarilyDisabled()) {
        return;
      }

      const posts = document.querySelectorAll(POST_SELECTOR);

      for (const post of posts) {
        if (!this.observedPosts.has(post) && isLikelyFeedPost(post)) {
          this.observedPosts.add(post);
          this.intersectionObserver.observe(post);
        }
      }
    }

    handleIntersections(entries) {
      if (!this.enabled || this.blocked || !this.currentRoute.countable || !this.isCurrentRouteLimited() || this.isTemporarilyDisabled() || this.isSnoozed()) {
        return;
      }

      let changed = false;

      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < VIEW_THRESHOLD) {
          continue;
        }

        const postId = getStablePostId(entry.target);
        if (postId && !this.seenPostIds.has(postId)) {
          this.seenPostIds.add(postId);
          this.recordFeedCardAnchor(entry.target, postId);
          changed = true;

          if (this.seenPostIds.size >= this.settings.postLimit) {
            break;
          }
        }
      }

      if (changed) {
        this.saveCurrentRouteSession();
        this.scheduleStateSave();
      }

      this.enforceStateIfNeeded();
    }

    enforceStateIfNeeded() {
      if (!this.settings.enabled || !this.currentRoute.countable) {
        return;
      }

      this.reconcileGlobalLockout();

      if (this.isSnoozed()) {
        this.clearBlockingUi();
        return;
      }

      if (this.isLockSuppressedAboveLimit()) {
        return;
      }

      if (this.blocked && this.overlayHiddenByEscape) {
        return;
      }

      if (this.state.globalLockedUntil > Date.now()) {
        this.showBlocker("lockout");
        return;
      }

      if (!this.isCurrentRouteLimited() || this.isTemporarilyDisabled()) {
        this.clearBlockingUi();
        return;
      }

      this.maybeShowWarning();

      const lockReason = this.getTriggeredLimitReason();
      if (this.enabled && lockReason) {
        this.state.globalLockedUntil = Date.now() + (this.settings.lockoutMinutes * 60000);
        this.saveCurrentRouteSession();
        this.scheduleStateSave();
        this.showBlocker(lockReason);
      }
    }

    showBlocker(reason) {
      if (!this.blocked) {
        this.limitReachedY = window.scrollY;
      }

      this.removeWarning();

      if (this.blocked && this.feedCardElement && document.contains(this.feedCardElement)) {
        this.refreshFeedCard();
        this.validateFeedCard();
        this.startCountdown();
        return;
      }

      this.lastLockReason = reason;
      this.blocked = true;
      this.lockSuppressedAboveLimit = false;
      this.overlayHiddenByEscape = false;
      this.stopActiveTimeTracking();
      document.body.classList.add("reddit-scroll-limiter-blocked");
      if (!this.tryShowFeedCard(reason)) {
        this.showOverlay(reason);
      }
      this.startCountdown();
    }

    clearBlockingUi(suppressAboveLimit = false) {
      this.blocked = false;
      this.lockSuppressedAboveLimit = suppressAboveLimit && this.state.globalLockedUntil > Date.now();
      this.overlayHiddenByEscape = false;
      this.stopCountdown();
      this.removeFeedCard();
      this.removeOverlay();
      document.body.classList.remove("reddit-scroll-limiter-blocked");
      this.startActiveTimeTracking();
    }

    handlePopstate() {
      this.handleRouteChangeIfNeeded();
    }

    handleRoutePoll() {
      this.handleRouteChangeIfNeeded();
      this.enforceStateIfNeeded();
    }

    handleRouteChangeIfNeeded() {
      if (window.location.href === this.lastUrl) {
        return;
      }

      this.saveCurrentRouteSession();
      this.lastUrl = window.location.href;
      this.currentRoute = getRouteInfo();
      this.persistLastKnownRoute();

      if (!this.settings.enabled) {
        return;
      }

      if (this.currentRoute.countable && (this.isCurrentRouteLimited() || this.state.globalLockedUntil > Date.now())) {
        if (!this.enabled) {
          this.start();
        } else {
          this.loadRouteSession();
          this.scanForPosts();
          this.enforceStateIfNeeded();
        }
      } else if (this.enabled) {
        this.pauseCurrentRoute();
      } else {
        this.enforceStateIfNeeded();
      }
    }

    loadRouteSession() {
      this.currentRoute = getRouteInfo();
      this.persistLastKnownRoute();

      if (!this.currentRoute.countable) {
        return;
      }

      const existing = this.getRouteSession();
      const expired = this.isRouteSessionExpired(existing);
      const session = expired ? createRouteSession(Date.now()) : normalizeRouteSession(existing);
      if (expired) {
        this.clearSessionDisableState();
      }

      this.state.routes[this.currentRoute.key] = session;
      this.seenPostIds = new Set(session.seenPostIds);
      this.observedPosts = new WeakSet();
      this.blocked = false;
      this.lockSuppressedAboveLimit = false;
      this.overlayHiddenByEscape = false;
      this.limitReachedY = 0;
      this.lastScrollY = window.scrollY;
      this.removeOverlay();
      this.removeFeedCard();
      document.body.classList.remove("reddit-scroll-limiter-blocked");

      if (this.intersectionObserver) {
        this.intersectionObserver.disconnect();
      }

      this.scheduleStateSave();
      this.restartActiveTimeTracking();
    }

    saveCurrentRouteSession() {
      if (!this.currentRoute.countable) {
        return;
      }

      const now = Date.now();
      const existing = normalizeRouteSession(this.getRouteSession());
      this.state.routes[this.currentRoute.key] = {
        ...existing,
        seenPostIds: Array.from(this.seenPostIds).slice(0, MAX_LIMIT),
        viewedPostCount: this.seenPostIds.size,
        sessionStartedAt: existing.sessionStartedAt || now,
        lastActivityAt: now,
        snoozedUntil: existing.snoozedUntil || null,
        snoozesUsed: existing.snoozesUsed || 0
      };
      this.state.lastKnownRoute = {
        key: this.currentRoute.key,
        label: this.currentRoute.label,
        href: window.location.href,
        updatedAt: now
      };
    }

    getRouteSession() {
      if (!this.currentRoute.countable) {
        return createRouteSession(Date.now());
      }

      return this.state.routes[this.currentRoute.key] || createRouteSession(Date.now());
    }

    isRouteSessionExpired(session) {
      if (!this.settings.resetAfterMinutes) {
        return false;
      }

      const normalized = normalizeRouteSession(session);
      if (!normalized.lastActivityAt) {
        return false;
      }

      return Date.now() - normalized.lastActivityAt > this.settings.resetAfterMinutes * 60000;
    }

    isCurrentRouteLimited() {
      if (!this.currentRoute.countable) {
        return false;
      }

      const routeName = getRouteRuleName(this.currentRoute);
      const allowlist = new Set(this.settings.subredditAllowlist);
      const blocklist = new Set(this.settings.subredditBlocklist);

      if (this.settings.subredditMode === "only_listed") {
        return allowlist.has(routeName);
      }

      if (this.settings.subredditMode === "exclude_listed") {
        return !blocklist.has(routeName);
      }

      return true;
    }

    isTemporarilyDisabled() {
      const now = Date.now();

      if (this.state.disabledUntil && this.state.disabledUntil <= now) {
        this.state.disabledUntil = null;
        this.scheduleStateSave();
      }

      if (this.state.disabledUntil && this.state.disabledUntil > now) {
        return true;
      }

      if (this.state.disabledUntilSessionReset) {
        return true;
      }

      return this.currentRoute.countable && this.state.disabledRouteKeys.includes(this.currentRoute.key);
    }

    clearSessionDisableState() {
      if (this.state.disabledUntilSessionReset || this.state.disabledRouteKeys.length > 0) {
        this.state.disabledUntilSessionReset = false;
        this.state.disabledRouteKeys = [];
        this.scheduleStateSave();
      }
    }

    persistLastKnownRoute() {
      if (!this.currentRoute.countable) {
        return;
      }

      this.state.lastKnownRoute = {
        key: this.currentRoute.key,
        label: this.currentRoute.label,
        href: window.location.href,
        updatedAt: Date.now()
      };
      this.scheduleStateSave();
    }

    scheduleStateSave() {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = setTimeout(() => {
        this.persistStateNow();
      }, STATE_SAVE_DEBOUNCE_MS);
    }

    persistStateNow() {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = 0;
      chrome.storage.local.set({ [LOCAL_STATE_KEY]: this.state });
    }

    reconcileGlobalLockout() {
      if (this.state.globalLockedUntil && this.state.globalLockedUntil <= Date.now()) {
        this.state.globalLockedUntil = null;
        if (this.currentRoute.countable) {
          this.resetCurrentRouteSession();
        }
        this.clearBlockingUi();
        this.scheduleStateSave();
      }
    }

    resetCurrentRouteSession() {
      if (!this.currentRoute.countable) {
        return;
      }

      const fresh = createRouteSession(Date.now());
      this.state.routes[this.currentRoute.key] = fresh;
      this.seenPostIds = new Set();
      this.observedPosts = new WeakSet();
      this.limitReachedY = 0;

      if (this.intersectionObserver) {
        this.intersectionObserver.disconnect();
      }

      this.scanForPosts();
    }

    cancelSnoozeIfDisabled() {
      if (this.settings.snoozeEnabled || !this.currentRoute.countable) {
        return;
      }

      const session = normalizeRouteSession(this.getRouteSession());
      if (session.snoozedUntil) {
        session.snoozedUntil = null;
        this.state.routes[this.currentRoute.key] = session;
        this.scheduleStateSave();
      }
    }

    isSnoozed() {
      if (!this.settings.snoozeEnabled || !this.currentRoute.countable) {
        return false;
      }

      const session = normalizeRouteSession(this.getRouteSession());
      if (!session.snoozedUntil) {
        return false;
      }

      if (session.snoozedUntil <= Date.now()) {
        session.snoozedUntil = null;
        this.state.routes[this.currentRoute.key] = session;
        this.scheduleStateSave();
        return false;
      }

      return true;
    }

    canSnooze() {
      if (!this.settings.snoozeEnabled || !this.currentRoute.countable) {
        return false;
      }

      const session = normalizeRouteSession(this.getRouteSession());
      return session.snoozesUsed < this.settings.snoozeLimitPerSession;
    }

    snooze() {
      if (!this.canSnooze()) {
        return;
      }

      const session = normalizeRouteSession(this.getRouteSession());
      session.snoozesUsed += 1;
      session.snoozedUntil = Date.now() + (this.settings.snoozeMinutes * 60000);
      this.state.routes[this.currentRoute.key] = session;
      this.saveCurrentRouteSession();
      this.scheduleStateSave();
      this.clearBlockingUi();
      this.startActiveTimeTracking();
    }

    shouldTrackActiveTime() {
      return (
        this.enabled &&
        this.currentRoute.countable &&
        this.isCurrentRouteLimited() &&
        !this.isTemporarilyDisabled() &&
        !this.blocked &&
        !(this.state.globalLockedUntil > Date.now()) &&
        (!this.settings.pauseTimerWhenTabHidden || document.visibilityState === "visible")
      );
    }

    handleActiveTimeTick() {
      if (!this.shouldTrackActiveTime()) {
        this.stopActiveTimeTracking();
        return;
      }

      const now = Date.now();
      const session = normalizeRouteSession(this.getRouteSession());
      const previous = session.lastActiveTickAt || now;
      const deltaSeconds = Math.max(0, Math.min(5, Math.round((now - previous) / 1000)));

      session.activeSeconds += deltaSeconds;
      session.lastActiveTickAt = now;
      session.lastActivityAt = now;
      this.state.routes[this.currentRoute.key] = session;
      this.scheduleStateSave();
      this.enforceStateIfNeeded();
    }

    handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        this.startActiveTimeTracking();
      } else if (this.settings.pauseTimerWhenTabHidden) {
        this.stopActiveTimeTracking();
      }
    }

    markActiveTickStart() {
      if (!this.currentRoute.countable) {
        return;
      }

      const session = normalizeRouteSession(this.getRouteSession());
      session.lastActiveTickAt = Date.now();
      this.state.routes[this.currentRoute.key] = session;
      this.scheduleStateSave();
    }

    clearActiveTickStart() {
      if (!this.currentRoute.countable) {
        return;
      }

      const session = normalizeRouteSession(this.getRouteSession());
      session.lastActiveTickAt = null;
      this.state.routes[this.currentRoute.key] = session;
      this.scheduleStateSave();
    }

    getTriggeredLimitReason() {
      const mode = this.settings.limitMode;
      const session = normalizeRouteSession(this.getRouteSession());
      const postTriggered = this.seenPostIds.size >= this.settings.postLimit;
      const timeTriggered = session.activeSeconds >= this.settings.timeLimitMinutes * 60;

      if ((mode === "posts" || mode === "both") && postTriggered) {
        return "postLimit";
      }

      if ((mode === "time" || mode === "both") && timeTriggered) {
        return "timeLimit";
      }

      return "";
    }

    maybeShowWarning() {
      if (!this.settings.warningEnabled || this.blocked || !this.currentRoute.countable) {
        return;
      }

      const session = normalizeRouteSession(this.getRouteSession());
      if (session.warningShown) {
        return;
      }

      const warningText = this.getWarningText(session);
      if (!warningText) {
        return;
      }

      session.warningShown = true;
      this.state.routes[this.currentRoute.key] = session;
      this.scheduleStateSave();
      this.showWarning(warningText);
    }

    getWarningText(session) {
      const threshold = this.settings.warningThresholdPercent / 100;
      const mode = this.settings.limitMode;

      if ((mode === "posts" || mode === "both") && this.seenPostIds.size >= Math.ceil(this.settings.postLimit * threshold)) {
        const count = Math.min(this.seenPostIds.size, this.settings.postLimit);
        return `You are close to your Reddit limit: ${count} of ${this.settings.postLimit} posts.`;
      }

      if (mode === "time" || mode === "both") {
        const timeLimitSeconds = this.settings.timeLimitMinutes * 60;
        if (session.activeSeconds >= Math.ceil(timeLimitSeconds * threshold)) {
          const remainingMinutes = Math.max(1, Math.ceil((timeLimitSeconds - session.activeSeconds) / 60));
          return `${remainingMinutes} ${remainingMinutes === 1 ? "minute" : "minutes"} left before your Reddit break.`;
        }
      }

      return "";
    }

    showWarning(text) {
      this.removeWarning();

      const warning = document.createElement("div");
      warning.id = WARNING_ID;
      warning.setAttribute("role", "status");
      warning.textContent = text;
      document.documentElement.appendChild(warning);

      clearTimeout(this.warningTimer);
      this.warningTimer = setTimeout(() => {
        this.removeWarning();
      }, WARNING_DISMISS_MS);
    }

    removeWarning() {
      clearTimeout(this.warningTimer);
      this.warningTimer = 0;
      const warning = document.getElementById(WARNING_ID);
      if (warning) {
        warning.remove();
      }
    }

    handleScroll() {
      const currentScrollY = window.scrollY;

      if (this.blocked && this.overlayHiddenByEscape && currentScrollY > this.lastScrollY) {
        this.restoreOverlayAfterEscape();
      }

      if (this.blocked && currentScrollY < Math.max(0, this.limitReachedY - RETURN_ZONE_PX)) {
        this.clearBlockingUi(true);
      }

      this.lastScrollY = currentScrollY;
    }

    handleWheel(event) {
      if (!this.shouldBlockDownwardMovement(event.deltaY)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.restoreOverlayAfterEscape();
    }

    handleTouchStart(event) {
      this.touchStartY = event.touches && event.touches.length > 0 ? event.touches[0].clientY : 0;
    }

    handleTouchMove(event) {
      if (!this.blocked || !event.touches || event.touches.length === 0) {
        return;
      }

      const currentY = event.touches[0].clientY;
      const fingerMovedUp = currentY < this.touchStartY;

      if (fingerMovedUp) {
        event.preventDefault();
        event.stopPropagation();
        this.restoreOverlayAfterEscape();
      }
    }

    handleKeydown(event) {
      if (!this.blocked) {
        return;
      }

      if (event.key === "Escape") {
        this.hideOverlayText();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (DOWN_KEYS.has(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        this.restoreOverlayAfterEscape();
      }
    }

    shouldBlockDownwardMovement(deltaY) {
      return (this.blocked || this.isLockSuppressedAboveLimit()) && deltaY > 0;
    }

    showOverlay(reason) {
      this.removeFeedCard({ clearAnchors: false, keepFallback: true });
      const existing = document.getElementById(OVERLAY_ID);
      if (existing) {
        existing.remove();
      }

      const overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.tabIndex = -1;
      overlay.dataset.reason = reason;

      const dialog = document.createElement("section");
      dialog.className = "reddit-scroll-limiter-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "reddit-scroll-limiter-title");

      const title = document.createElement("h2");
      title.id = "reddit-scroll-limiter-title";
      title.textContent = "Time for a break";

      const message = document.createElement("p");
      message.className = "reddit-scroll-limiter-message";
      message.textContent = this.getOverlayMessage();

      const countdown = document.createElement("p");
      countdown.className = "reddit-scroll-limiter-countdown";
      countdown.textContent = this.getCountdownText();
      countdown.hidden = !this.settings.showCountdown;

      const snoozeHelp = document.createElement("p");
      snoozeHelp.className = "reddit-scroll-limiter-snooze-help";
      snoozeHelp.textContent = `Need a little longer? You can snooze once for ${this.settings.snoozeMinutes} minutes.`;
      snoozeHelp.hidden = !this.canSnooze();

      const actions = document.createElement("div");
      actions.className = "reddit-scroll-limiter-actions";

      const returnButton = document.createElement("button");
      returnButton.type = "button";
      returnButton.textContent = "Back to viewed posts";
      returnButton.addEventListener("click", () => {
        window.scrollTo({
          top: Math.max(0, this.limitReachedY - window.innerHeight),
          behavior: "smooth"
        });
      });

      actions.append(returnButton);

      if (this.canSnooze()) {
        const snoozeButton = document.createElement("button");
        snoozeButton.type = "button";
        snoozeButton.textContent = `Snooze ${this.settings.snoozeMinutes} minutes`;
        snoozeButton.addEventListener("click", () => this.snooze());
        actions.append(snoozeButton);
      }

      const hideButton = document.createElement("button");
      hideButton.type = "button";
      hideButton.textContent = "Hide message";
      hideButton.addEventListener("click", () => this.hideOverlayText());
      actions.append(hideButton);

      dialog.append(title, message, countdown, snoozeHelp, actions);
      overlay.append(dialog);
      document.documentElement.appendChild(overlay);
      this.refreshCountdown();

      requestAnimationFrame(() => {
        returnButton.focus();
      });
    }

    tryShowFeedCard(reason) {
      if (!this.canUseFeedCard(reason)) {
        return false;
      }

      const anchor = this.findRecoverableFeedCardAnchor();
      if (!anchor) {
        return false;
      }

      const card = this.createFeedCard(anchor.element, reason);
      if (!card) {
        return false;
      }

      this.removeOverlay();
      this.removeFeedCard({ clearAnchors: false });
      anchor.element.parentElement.insertBefore(card, anchor.element.nextSibling);
      this.feedCardElement = card;
      this.feedCardAnchors = [
        anchor,
        ...this.feedCardAnchors.filter((candidate) => candidate.id !== anchor.id)
      ].slice(0, FEED_CARD_MAX_ANCHORS);
      this.feedCardRecoveryFailures = 0;
      this.feedCardFallbackActive = false;
      this.startFeedCardLifecycle();
      return true;
    }

    canUseFeedCard(reason) {
      if (this.feedCardFallbackActive) {
        return false;
      }

      if (window.innerWidth < FEED_CARD_MIN_VIEWPORT_WIDTH) {
        return false;
      }

      if (!this.currentRoute.countable) {
        return false;
      }

      if (getRedditRoute() === "POST_DETAIL") {
        return false;
      }

      if (isOldRedditHost()) {
        return false;
      }

      if (!this.findRecoverableFeedCardAnchor()) {
        return false;
      }

      return true;
    }

    createFeedCard(anchorPost, reason) {
      if (!anchorPost || !anchorPost.parentElement || !document.contains(anchorPost) || !isModernFeedPost(anchorPost) || isPromotedPost(anchorPost)) {
        return null;
      }

      const card = document.createElement("section");
      card.id = FEED_CARD_ID;
      card.className = "reddit-scroll-limiter-feed-card";
      card.dataset.reason = reason;
      card.dataset.anchorPostId = getStablePostId(anchorPost);
      card.setAttribute("role", "region");
      card.setAttribute("aria-labelledby", "reddit-scroll-limiter-feed-card-title");

      if (!this.applyFeedCardOuterStyle(card, anchorPost)) {
        return null;
      }

      const title = document.createElement("h2");
      title.id = "reddit-scroll-limiter-feed-card-title";
      title.textContent = "Time for a break";

      const message = document.createElement("p");
      message.className = "reddit-scroll-limiter-feed-card-message";
      message.textContent = this.getOverlayMessage();

      const countdown = document.createElement("p");
      countdown.className = "reddit-scroll-limiter-feed-card-countdown";
      countdown.textContent = this.getCountdownText();
      countdown.hidden = !this.settings.showCountdown || !countdown.textContent;

      const actions = document.createElement("div");
      actions.className = "reddit-scroll-limiter-feed-card-actions";

      const returnButton = document.createElement("button");
      returnButton.type = "button";
      returnButton.textContent = "Back to viewed posts";
      returnButton.addEventListener("click", () => {
        this.removeFeedCard({ clearAnchors: false });
        window.scrollTo({
          top: Math.max(0, this.limitReachedY - window.innerHeight),
          behavior: "smooth"
        });
      });
      actions.append(returnButton);

      if (this.canSnooze()) {
        const snoozeButton = document.createElement("button");
        snoozeButton.type = "button";
        snoozeButton.textContent = `Snooze ${this.settings.snoozeMinutes} minutes`;
        snoozeButton.addEventListener("click", () => this.snooze());
        actions.append(snoozeButton);
      }

      const inner = document.createElement("div");
      inner.className = "reddit-scroll-limiter-feed-card-inner";
      inner.append(title, message, countdown, actions);
      card.append(inner);
      return card;
    }

    applyFeedCardOuterStyle(card, anchorPost) {
      const rect = anchorPost.getBoundingClientRect();
      if (rect.width < FEED_CARD_MIN_WIDTH || rect.width > window.innerWidth) {
        return false;
      }

      const computed = window.getComputedStyle(anchorPost);
      card.style.width = `${Math.round(rect.width)}px`;
      this.applyFeedCardTheme(card, anchorPost);

      if (computed.marginLeft && computed.marginLeft !== "0px") {
        card.style.marginLeft = computed.marginLeft;
      }
      if (computed.marginRight && computed.marginRight !== "0px") {
        card.style.marginRight = computed.marginRight;
      }

      const marginTop = parseCssPixels(computed.marginTop);
      const marginBottom = parseCssPixels(computed.marginBottom);
      card.style.marginTop = `${Math.max(8, Math.min(24, marginTop || 12))}px`;
      card.style.marginBottom = `${Math.max(12, Math.min(28, marginBottom || 16))}px`;
      return true;
    }

    applyFeedCardTheme(card, anchorPost) {
      const surfaceColor = getElementSurfaceColor(anchorPost);
      const darkMode = isDarkColor(surfaceColor);
      const theme = darkMode
        ? {
            bg: "#0b1416",
            border: "#263538",
            title: "#eef3f5",
            muted: "#8ba2ad",
            accent: "#ff9c73",
            buttonBg: "#223237",
            buttonBorder: "#223237",
            buttonHover: "#2d3d42",
            buttonText: "#eef3f5",
            focus: "#629fff"
          }
        : {
            bg: "#ffffff",
            border: "#edeff1",
            title: "#0f1a1c",
            muted: "#576f76",
            accent: "#d93900",
            buttonBg: "#eef3f5",
            buttonBorder: "#eef3f5",
            buttonHover: "#e5ebee",
            buttonText: "#0f1a1c",
            focus: "#0045ac"
          };

      card.dataset.redditTheme = darkMode ? "dark" : "light";
      card.style.setProperty("--rsl-feed-bg", theme.bg);
      card.style.setProperty("--rsl-feed-border", theme.border);
      card.style.setProperty("--rsl-feed-title", theme.title);
      card.style.setProperty("--rsl-feed-muted", theme.muted);
      card.style.setProperty("--rsl-feed-accent", theme.accent);
      card.style.setProperty("--rsl-feed-button-bg", theme.buttonBg);
      card.style.setProperty("--rsl-feed-button-border", theme.buttonBorder);
      card.style.setProperty("--rsl-feed-button-hover", theme.buttonHover);
      card.style.setProperty("--rsl-feed-button-text", theme.buttonText);
      card.style.setProperty("--rsl-feed-focus", theme.focus);
    }

    recordFeedCardAnchor(postElement, postId = getStablePostId(postElement)) {
      if (!postId || !isModernFeedPost(postElement) || isPromotedPost(postElement)) {
        return;
      }

      this.feedCardAnchors = [
        { id: postId, element: postElement },
        ...this.feedCardAnchors.filter((anchor) => anchor.id !== postId)
      ].slice(0, FEED_CARD_MAX_ANCHORS);
    }

    findRecoverableFeedCardAnchor() {
      const bufferedAnchor = this.feedCardAnchors.find((anchor) =>
        anchor &&
        anchor.element &&
        document.contains(anchor.element) &&
        isModernFeedPost(anchor.element) &&
        !isPromotedPost(anchor.element)
      );

      if (bufferedAnchor) {
        return bufferedAnchor;
      }

      return this.findVisibleModernFeedCardAnchor();
    }

    findVisibleModernFeedCardAnchor() {
      const candidates = Array.from(document.querySelectorAll(MODERN_POST_SELECTOR))
        .filter((post) => isModernFeedPost(post) && !isPromotedPost(post))
        .map((post) => ({
          id: getStablePostId(post),
          element: post,
          rect: post.getBoundingClientRect()
        }))
        .filter((candidate) =>
          candidate.id &&
          candidate.rect.width >= FEED_CARD_MIN_WIDTH &&
          candidate.rect.bottom > 0 &&
          candidate.rect.top < window.innerHeight
        )
        .sort((a, b) => b.rect.bottom - a.rect.bottom);

      const anchor = candidates[0];
      if (!anchor) {
        return null;
      }

      const savedAnchor = { id: anchor.id, element: anchor.element };
      this.feedCardAnchors = [
        savedAnchor,
        ...this.feedCardAnchors.filter((candidate) => candidate.id !== savedAnchor.id)
      ].slice(0, FEED_CARD_MAX_ANCHORS);
      return savedAnchor;
    }

    getCurrentFeedCardAnchor() {
      if (!this.feedCardElement) {
        return null;
      }

      const anchorId = this.feedCardElement.dataset.anchorPostId;
      return this.feedCardAnchors.find((anchor) =>
        anchor.id === anchorId &&
        anchor.element &&
        document.contains(anchor.element) &&
        isModernFeedPost(anchor.element) &&
        !isPromotedPost(anchor.element)
      ) || null;
    }

    startFeedCardLifecycle() {
      this.stopFeedCardLifecycle();

      this.feedCardValidationTimer = setInterval(() => {
        if (this.blocked) {
          this.validateFeedCard();
        } else {
          this.removeFeedCard({ clearAnchors: false });
        }
      }, FEED_CARD_VALIDATE_MS);

      if (this.feedCardElement && "IntersectionObserver" in window) {
        this.feedCardVisibilityObserver = new IntersectionObserver(this.handleFeedCardVisibility, {
          threshold: [0]
        });
        this.feedCardVisibilityObserver.observe(this.feedCardElement);
      }
    }

    stopFeedCardLifecycle() {
      if (this.feedCardValidationTimer) {
        clearInterval(this.feedCardValidationTimer);
        this.feedCardValidationTimer = 0;
      }

      if (this.feedCardVisibilityObserver) {
        this.feedCardVisibilityObserver.disconnect();
        this.feedCardVisibilityObserver = null;
      }
    }

    handleFeedCardVisibility(entries) {
      if (!this.blocked) {
        return;
      }

      for (const entry of entries) {
        if (entry.target === this.feedCardElement && !entry.isIntersecting && window.scrollY < this.limitReachedY) {
          this.removeFeedCard({ clearAnchors: false });
        }
      }
    }

    validateFeedCard() {
      if (!this.blocked || !this.feedCardElement) {
        return false;
      }

      if (!document.contains(this.feedCardElement)) {
        return this.recoverFeedCardOrFallback();
      }

      const anchor = this.getCurrentFeedCardAnchor();
      if (!anchor || !document.contains(anchor.element)) {
        return this.recoverFeedCardOrFallback();
      }

      if (this.feedCardElement.previousElementSibling !== anchor.element) {
        return this.reanchorFeedCard(anchor);
      }

      this.feedCardRecoveryFailures = 0;
      return true;
    }

    recoverFeedCardOrFallback() {
      const anchor = this.findRecoverableFeedCardAnchor();
      if (anchor && this.reanchorFeedCard(anchor)) {
        return true;
      }

      this.feedCardRecoveryFailures += 1;
      if (this.feedCardRecoveryFailures >= FEED_CARD_MAX_RECOVERY_FAILURES) {
        this.feedCardFallbackActive = true;
        this.removeFeedCard({ clearAnchors: false, keepFallback: true });
        this.showOverlay(this.lastLockReason || "lockout");
      }

      return false;
    }

    reanchorFeedCard(anchor) {
      if (!anchor || !anchor.element || !document.contains(anchor.element)) {
        return false;
      }

      const card = this.createFeedCard(anchor.element, this.lastLockReason || "lockout");
      if (!card) {
        return false;
      }

      this.removeFeedCard({ clearAnchors: false });
      anchor.element.parentElement.insertBefore(card, anchor.element.nextSibling);
      this.feedCardElement = card;
      this.feedCardAnchors = [
        anchor,
        ...this.feedCardAnchors.filter((candidate) => candidate.id !== anchor.id)
      ].slice(0, FEED_CARD_MAX_ANCHORS);
      this.feedCardRecoveryFailures = 0;
      this.startFeedCardLifecycle();
      return true;
    }

    refreshFeedCard() {
      const card = this.feedCardElement;
      if (!card || !document.contains(card)) {
        return;
      }

      const message = card.querySelector(".reddit-scroll-limiter-feed-card-message");
      if (message) {
        message.textContent = this.getOverlayMessage();
      }

      const countdown = card.querySelector(".reddit-scroll-limiter-feed-card-countdown");
      if (countdown) {
        countdown.textContent = this.getCountdownText();
        countdown.hidden = !this.settings.showCountdown || !countdown.textContent;
      }
    }

    removeFeedCard(options = {}) {
      const clearAnchors = options.clearAnchors !== false;
      const keepFallback = options.keepFallback === true;

      this.stopFeedCardLifecycle();
      const card = this.feedCardElement || document.getElementById(FEED_CARD_ID);
      if (card) {
        card.remove();
      }

      this.feedCardElement = null;
      if (clearAnchors) {
        this.feedCardAnchors = [];
      }
      if (!keepFallback) {
        this.feedCardFallbackActive = false;
      }
    }

    getOverlayMessage() {
      const minutes = formatMinutes(this.getRemainingLockoutMs());
      const session = normalizeRouteSession(this.getRouteSession());

      if (this.lastLockReason === "timeLimit") {
        return `You have been scrolling for ${formatMinutes(session.activeSeconds * 1000)}. Come back in ${minutes}.`;
      }

      if (this.seenPostIds.size === 0) {
        return `Reddit scrolling is paused. Come back in ${minutes}.`;
      }

      const displayedCount = Math.min(this.seenPostIds.size, this.settings.postLimit);
      return `You have scrolled through ${displayedCount} posts. Come back in ${minutes}.`;
    }

    getCountdownText() {
      if (!this.state.globalLockedUntil || this.state.globalLockedUntil <= Date.now()) {
        return "";
      }

      return `Reddit scrolling is paused until ${formatTime(this.state.globalLockedUntil)}.`;
    }

    getRemainingLockoutMs() {
      if (!this.state.globalLockedUntil) {
        return this.settings.lockoutMinutes * 60000;
      }

      return Math.max(0, this.state.globalLockedUntil - Date.now());
    }

    refreshCountdown() {
      this.reconcileGlobalLockout();
      this.refreshFeedCard();

      const overlay = document.getElementById(OVERLAY_ID);
      if (!overlay) {
        return;
      }

      const message = overlay.querySelector(".reddit-scroll-limiter-message");
      if (message) {
        message.textContent = this.getOverlayMessage();
      }

      const countdown = overlay.querySelector(".reddit-scroll-limiter-countdown");
      if (countdown) {
        countdown.textContent = this.getCountdownText();
        countdown.hidden = !this.settings.showCountdown || !countdown.textContent;
      }
    }

    hideOverlayText() {
      const overlay = document.getElementById(OVERLAY_ID);
      if (overlay) {
        overlay.hidden = true;
      }
      this.overlayHiddenByEscape = true;
    }

    restoreOverlayAfterEscape() {
      if (this.isLockSuppressedAboveLimit()) {
        this.lockSuppressedAboveLimit = false;
        this.showBlocker("restored");
        return;
      }

      if (!this.overlayHiddenByEscape) {
        return;
      }

      this.overlayHiddenByEscape = false;
      this.lockSuppressedAboveLimit = false;
      this.showOverlay("restored");
    }

    removeOverlay() {
      const overlay = document.getElementById(OVERLAY_ID);
      if (overlay) {
        overlay.remove();
      }
    }

    isLockSuppressedAboveLimit() {
      return this.lockSuppressedAboveLimit && this.state.globalLockedUntil > Date.now();
    }
  }

  getSettingsAndState((settings, state) => {
    const limiter = new RedditScrollLimiter(settings, state);
    limiter.init();
  });

  function getSettingsAndState(callback) {
    chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (settings) => {
      chrome.storage.local.get([LOCAL_STATE_KEY], (stateItems) => {
        callback(
          { ...DEFAULT_SETTINGS, ...settings },
          stateItems[LOCAL_STATE_KEY]
        );
      });
    });
  }

  function normalizeSettings(settings) {
    return {
      postLimit: clampNumber(settings.postLimit, DEFAULT_SETTINGS.postLimit, MIN_LIMIT, MAX_LIMIT),
      enabled: settings.enabled !== false,
      resetAfterMinutes: clampNumber(settings.resetAfterMinutes, DEFAULT_SETTINGS.resetAfterMinutes, 0, 10080),
      lockoutMinutes: clampNumber(settings.lockoutMinutes, DEFAULT_SETTINGS.lockoutMinutes, 1, 1440),
      snoozeEnabled: settings.snoozeEnabled !== false,
      snoozeMinutes: clampNumber(settings.snoozeMinutes, DEFAULT_SETTINGS.snoozeMinutes, 1, 120),
      snoozeLimitPerSession: clampNumber(settings.snoozeLimitPerSession, DEFAULT_SETTINGS.snoozeLimitPerSession, 0, 10),
      showCountdown: settings.showCountdown !== false,
      limitMode: normalizeOption(settings.limitMode, ["posts", "time", "both"], DEFAULT_SETTINGS.limitMode),
      timeLimitMinutes: clampNumber(settings.timeLimitMinutes, DEFAULT_SETTINGS.timeLimitMinutes, 1, 1440),
      pauseTimerWhenTabHidden: settings.pauseTimerWhenTabHidden !== false,
      subredditMode: normalizeOption(settings.subredditMode, ["all", "only_listed", "exclude_listed"], DEFAULT_SETTINGS.subredditMode),
      subredditAllowlist: normalizeSubredditList(settings.subredditAllowlist),
      subredditBlocklist: normalizeSubredditList(settings.subredditBlocklist),
      warningEnabled: settings.warningEnabled !== false,
      warningThresholdPercent: clampNumber(settings.warningThresholdPercent, DEFAULT_SETTINGS.warningThresholdPercent, 1, 99)
    };
  }

  function normalizeOption(value, allowedValues, fallback) {
    return allowedValues.includes(value) ? value : fallback;
  }

  function normalizeSubredditList(value) {
    const rawItems = Array.isArray(value) ? value : String(value || "").split(",");
    const items = rawItems
      .map((item) => String(item).trim().toLowerCase().replace(/^r\//, ""))
      .filter(Boolean);

    return Array.from(new Set(items));
  }

  function clampNumber(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);

    if (Number.isNaN(parsed)) {
      return fallback;
    }

    return Math.max(min, Math.min(max, parsed));
  }

  function normalizeLocalState(state) {
    const normalized = state && typeof state === "object" ? state : {};
    return {
      globalLockedUntil: Number(normalized.globalLockedUntil) || null,
      disabledUntil: Number(normalized.disabledUntil) || null,
      disabledUntilSessionReset: normalized.disabledUntilSessionReset === true,
      disabledRouteKeys: Array.isArray(normalized.disabledRouteKeys) ? normalized.disabledRouteKeys.filter(Boolean) : [],
      lastKnownRoute: normalized.lastKnownRoute && typeof normalized.lastKnownRoute === "object"
        ? normalized.lastKnownRoute
        : null,
      routes: normalized.routes && typeof normalized.routes === "object"
        ? normalized.routes
        : {}
    };
  }

  function normalizeRouteSession(session) {
    const normalized = session && typeof session === "object" ? session : {};
    return {
      seenPostIds: Array.isArray(normalized.seenPostIds) ? normalized.seenPostIds.filter(Boolean) : [],
      viewedPostCount: Number(normalized.viewedPostCount) || 0,
      sessionStartedAt: Number(normalized.sessionStartedAt) || Date.now(),
      lastActivityAt: Number(normalized.lastActivityAt) || Date.now(),
      activeSeconds: Number(normalized.activeSeconds) || 0,
      lastActiveTickAt: Number(normalized.lastActiveTickAt) || null,
      warningShown: normalized.warningShown === true,
      snoozedUntil: Number(normalized.snoozedUntil) || null,
      snoozesUsed: Number(normalized.snoozesUsed) || 0
    };
  }

  function createRouteSession(now) {
    return {
      seenPostIds: [],
      viewedPostCount: 0,
      sessionStartedAt: now,
      lastActivityAt: now,
      activeSeconds: 0,
      lastActiveTickAt: null,
      warningShown: false,
      snoozedUntil: null,
      snoozesUsed: 0
    };
  }

  function getRouteInfo(pathname = window.location.pathname) {
    const path = pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "/home") {
      return { type: "HOME", countable: true, key: "home", label: "Reddit home" };
    }

    if (path.includes("/comments/")) {
      return { type: "POST_DETAIL", countable: false, key: "post-detail", label: "Post detail" };
    }

    if (path === "/search") {
      return { type: "SEARCH", countable: true, key: "search", label: "Reddit search" };
    }

    const subredditMatch = path.match(/^\/r\/([\w-]+)$/i);
    if (subredditMatch) {
      const subreddit = subredditMatch[1].toLowerCase();
      return {
        type: "SUBREDDIT",
        countable: true,
        key: `subreddit:${subreddit}`,
        label: `r/${subreddit}`
      };
    }

    return { type: "UNKNOWN", countable: false, key: "unknown", label: "Reddit" };
  }

  function getRedditRoute(pathname = window.location.pathname) {
    return getRouteInfo(pathname).type;
  }

  function getRouteRuleName(route) {
    if (route.key === "home" || route.key === "search") {
      return route.key;
    }

    if (route.key.startsWith("subreddit:")) {
      return route.key.replace("subreddit:", "");
    }

    return route.key;
  }

  function isModernFeedPost(postElement) {
    return Boolean(
      postElement &&
      postElement.isConnected &&
      postElement.matches(MODERN_POST_SELECTOR) &&
      !postElement.matches(".thing.link") &&
      getRedditRoute() !== "POST_DETAIL" &&
      isLikelyFeedPost(postElement)
    );
  }

  function isOldRedditHost() {
    return window.location.hostname.toLowerCase().startsWith("old.");
  }

  function isPromotedPost(postElement) {
    if (!postElement) {
      return false;
    }

    if (postElement.matches(".promoted") || postElement.getAttribute("data-promoted") === "true") {
      return true;
    }

    for (const attribute of postElement.attributes || []) {
      if (isPromotedToken(attribute.name) || isPromotedToken(attribute.value)) {
        return true;
      }
    }

    if (postElement.querySelector("[data-promoted='true']")) {
      return true;
    }

    for (const node of postElement.querySelectorAll("[data-testid], [aria-label], [class], [id]")) {
      for (const attribute of node.attributes || []) {
        if (isPromotedToken(attribute.name) || isPromotedToken(attribute.value)) {
          return true;
        }
      }
    }

    const text = (postElement.innerText || postElement.textContent || "").replace(/\s+/g, " ").trim();
    return /(^|\s)(Promoted|Sponsored)(\s|$)/.test(text);
  }

  function isPromotedToken(value) {
    return /(^|[-_:\s])(promoted|sponsored)([-_:\s]|$)/i.test(String(value || ""));
  }

  function parseCssPixels(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getElementSurfaceColor(element) {
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const color = parseCssColor(window.getComputedStyle(current).backgroundColor);
      if (color && color.a > 0.5) {
        return color;
      }
      current = current.parentElement;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? { r: 11, g: 20, b: 22, a: 1 }
      : { r: 255, g: 255, b: 255, a: 1 };
  }

  function parseCssColor(value) {
    const color = String(value || "").trim();
    if (!color || color === "transparent") {
      return null;
    }

    const match = color.match(/^rgba?\(([^)]+)\)$/i);
    if (!match) {
      return null;
    }

    const parts = match[1].split(",").map((part) => part.trim());
    if (parts.length < 3) {
      return null;
    }

    const r = Number.parseFloat(parts[0]);
    const g = Number.parseFloat(parts[1]);
    const b = Number.parseFloat(parts[2]);
    const a = parts.length >= 4 ? Number.parseFloat(parts[3]) : 1;
    if (![r, g, b, a].every(Number.isFinite)) {
      return null;
    }

    return { r, g, b, a };
  }

  function isDarkColor(color) {
    const channel = (value) => {
      const normalized = Math.max(0, Math.min(255, value)) / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };

    const luminance = (0.2126 * channel(color.r)) + (0.7152 * channel(color.g)) + (0.0722 * channel(color.b));
    return luminance < 0.45;
  }

  function isLikelyFeedPost(postElement) {
    if (!postElement || !postElement.isConnected || getRedditRoute() === "POST_DETAIL") {
      return false;
    }

    if (postElement.matches(".thing.comment")) {
      return false;
    }

    const isSpecificPostSelector = postElement.matches("shreddit-post, [data-testid=\"post-container\"], .thing.link");
    const hasCommentsPermalink = Boolean(getPostIdFromLink(postElement));

    if (postElement.matches("article[aria-label]") && !isSpecificPostSelector && !hasCommentsPermalink) {
      return false;
    }

    return Boolean(getStablePostId(postElement));
  }

  function getStablePostId(postElement) {
    const linkId = getPostIdFromLink(postElement);
    if (linkId) {
      return `link_${linkId}`;
    }

    const elementId = postElement.id || postElement.getAttribute("data-fullname") || postElement.getAttribute("data-name");
    if (elementId) {
      return `element_${elementId}`;
    }

    const testId = postElement.getAttribute("data-testid");
    if (testId) {
      return `testid_${testId}_${hashString(getTextSignature(postElement))}`;
    }

    const signature = getTextSignature(postElement);
    if (!signature) {
      return "";
    }

    return `hash_${hashString(signature)}`;
  }

  function getPostIdFromLink(postElement) {
    const hrefs = [];

    if (postElement.href) {
      hrefs.push(postElement.href);
    }

    for (const link of postElement.querySelectorAll("a[href]")) {
      hrefs.push(link.href);
    }

    for (const href of hrefs) {
      const match = href.match(/\/comments\/([a-z0-9]+)/i);
      if (match) {
        return match[1].toLowerCase();
      }
    }

    return "";
  }

  function getTextSignature(postElement) {
    const title = postElement.querySelector("h1, h2, h3, [slot=\"title\"], .title")?.textContent || "";
    const link = postElement.querySelector("a[href]")?.href || "";
    const text = `${title} ${link} ${postElement.textContent || ""}`;
    return text.trim().replace(/\s+/g, " ").slice(0, 220);
  }

  function hashString(value) {
    let hash = 0;

    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) - hash) + value.charCodeAt(index);
      hash |= 0;
    }

    return Math.abs(hash).toString(36);
  }

  function formatMinutes(ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });
  }
})();
