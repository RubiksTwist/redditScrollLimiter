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
const DEBOUNCE_MS = 500;

const limitInput = document.getElementById("postLimit");
const limitSlider = document.getElementById("postLimitSlider");
const valueDisplay = document.getElementById("valueDisplay");
const enabledInput = document.getElementById("enabled");
const limitModeSelect = document.getElementById("limitMode");
const timeLimitSelect = document.getElementById("timeLimitMinutes");
const lockoutSelect = document.getElementById("lockoutMinutes");
const resetSelect = document.getElementById("resetAfterMinutes");
const pauseTimerInput = document.getElementById("pauseTimerWhenTabHidden");
const subredditModeSelect = document.getElementById("subredditMode");
const subredditListInput = document.getElementById("subredditList");
const warningEnabledInput = document.getElementById("warningEnabled");
const warningThresholdSelect = document.getElementById("warningThresholdPercent");
const snoozeEnabledInput = document.getElementById("snoozeEnabled");
const snoozeControls = document.getElementById("snoozeControls");
const snoozeMinutesSelect = document.getElementById("snoozeMinutes");
const snoozeLimitSelect = document.getElementById("snoozeLimitPerSession");
const startBreakButton = document.getElementById("startBreakBtn");
const disableHourButton = document.getElementById("disableHourBtn");
const disableSessionButton = document.getElementById("disableSessionBtn");
const disableFeedButton = document.getElementById("disableFeedBtn");
const resetButton = document.getElementById("resetBtn");
const status = document.getElementById("status");
const routeStatus = document.getElementById("routeStatus");
const breakStatus = document.getElementById("breakStatus");
const snoozeStatus = document.getElementById("snoozeStatus");

let saveTimer = 0;
let statusTimer = 0;
let countdownTimer = 0;
let currentSettings = { ...DEFAULT_SETTINGS };
let currentState = normalizeLocalState();

document.addEventListener("DOMContentLoaded", loadState);

limitInput.addEventListener("input", () => {
  const value = clampLimit(limitInput.value);
  syncLimitControls(value);
  queueLimitSave(value);
});

limitInput.addEventListener("change", () => {
  const value = clampLimit(limitInput.value);
  syncLimitControls(value);
  saveSyncSetting("postLimit", value, `Saved limit: ${value}`);
});

limitSlider.addEventListener("input", () => {
  const value = clampLimit(limitSlider.value);
  syncLimitControls(value);
  queueLimitSave(value);
});

enabledInput.addEventListener("change", () => {
  saveSyncSetting("enabled", enabledInput.checked, enabledInput.checked ? "Limiter enabled" : "Limiter disabled");
});

limitModeSelect.addEventListener("change", () => {
  saveSyncSetting("limitMode", limitModeSelect.value, `Limit mode saved: ${limitModeSelect.selectedOptions[0].textContent}`);
});

timeLimitSelect.addEventListener("change", () => {
  const value = Number.parseInt(timeLimitSelect.value, 10);
  saveSyncSetting("timeLimitMinutes", value, `Time limit saved: ${formatDuration(value)}`);
});

lockoutSelect.addEventListener("change", () => {
  const value = Number.parseInt(lockoutSelect.value, 10);
  saveSyncSetting("lockoutMinutes", value, `Break length saved: ${formatDuration(value)}`);
});

resetSelect.addEventListener("change", () => {
  const value = Number.parseInt(resetSelect.value, 10);
  saveSyncSetting("resetAfterMinutes", value, value === 0 ? "Session reset disabled" : `Reset window saved: ${formatDuration(value)}`);
});

pauseTimerInput.addEventListener("change", () => {
  saveSyncSetting(
    "pauseTimerWhenTabHidden",
    pauseTimerInput.checked,
    pauseTimerInput.checked ? "Timer pauses when hidden" : "Timer runs while hidden"
  );
});

subredditModeSelect.addEventListener("change", () => {
  saveSubredditRules();
});

subredditListInput.addEventListener("change", () => {
  saveSubredditRules();
});

warningEnabledInput.addEventListener("change", () => {
  saveSyncSetting(
    "warningEnabled",
    warningEnabledInput.checked,
    warningEnabledInput.checked ? "Warning enabled" : "Warning disabled"
  );
});

warningThresholdSelect.addEventListener("change", () => {
  const value = Number.parseInt(warningThresholdSelect.value, 10);
  saveSyncSetting("warningThresholdPercent", value, `Warning threshold saved: ${value}%`);
});

snoozeEnabledInput.addEventListener("change", () => {
  const enabled = snoozeEnabledInput.checked;
  snoozeControls.hidden = !enabled;
  saveSyncSetting("snoozeEnabled", enabled, enabled ? "Snooze enabled" : "Snooze disabled");
});

snoozeMinutesSelect.addEventListener("change", () => {
  const value = Number.parseInt(snoozeMinutesSelect.value, 10);
  saveSyncSetting("snoozeMinutes", value, `Snooze length saved: ${formatDuration(value)}`);
});

snoozeLimitSelect.addEventListener("change", () => {
  const value = Number.parseInt(snoozeLimitSelect.value, 10);
  saveSyncSetting("snoozeLimitPerSession", value, `Snoozes saved: ${value} per session`);
});

startBreakButton.addEventListener("click", () => {
  const lockedUntil = Date.now() + (currentSettings.lockoutMinutes * 60000);
  currentState.globalLockedUntil = lockedUntil;
  chrome.storage.local.set({ [LOCAL_STATE_KEY]: currentState }, () => {
    renderReliableStatus();
    showStatus(`Break active until ${formatTime(lockedUntil)}`);
  });
});

disableHourButton.addEventListener("click", () => {
  currentState.disabledUntil = Date.now() + 60 * 60000;
  chrome.storage.local.set({ [LOCAL_STATE_KEY]: currentState }, () => {
    showStatus("Limiter disabled for 1 hour");
  });
});

disableSessionButton.addEventListener("click", () => {
  currentState.disabledUntilSessionReset = true;
  chrome.storage.local.set({ [LOCAL_STATE_KEY]: currentState }, () => {
    showStatus("Limiter disabled until next session");
  });
});

disableFeedButton.addEventListener("click", () => {
  const routeKey = currentState.lastKnownRoute?.key;
  if (!routeKey) {
    showStatus("Open a Reddit feed first");
    return;
  }

  currentState.disabledRouteKeys = Array.from(new Set([...currentState.disabledRouteKeys, routeKey]));
  chrome.storage.local.set({ [LOCAL_STATE_KEY]: currentState }, () => {
    showStatus(`Disabled on ${currentState.lastKnownRoute.label} until next session`);
  });
});

resetButton.addEventListener("click", () => {
  syncLimitControls(DEFAULT_SETTINGS.postLimit);
  saveSyncSetting("postLimit", DEFAULT_SETTINGS.postLimit, `Saved limit: ${DEFAULT_SETTINGS.postLimit}`);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync") {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (changes[key]) {
        currentSettings[key] = changes[key].newValue;
      }
    }
    currentSettings = normalizeSettings(currentSettings);
    syncSettingsControls(currentSettings);
  }

  if (areaName === "local" && changes[LOCAL_STATE_KEY]) {
    currentState = normalizeLocalState(changes[LOCAL_STATE_KEY].newValue);
    renderReliableStatus();
  }
});

function loadState() {
  chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (settings) => {
    currentSettings = normalizeSettings({ ...DEFAULT_SETTINGS, ...settings });
    syncSettingsControls(currentSettings);

    chrome.storage.local.get([LOCAL_STATE_KEY], (stateItems) => {
      currentState = normalizeLocalState(stateItems[LOCAL_STATE_KEY]);
      renderReliableStatus();
      startStatusCountdown();
    });
  });
}

function syncSettingsControls(settings) {
  syncLimitControls(clampLimit(settings.postLimit));
  enabledInput.checked = settings.enabled !== false;
  limitModeSelect.value = settings.limitMode;
  timeLimitSelect.value = String(settings.timeLimitMinutes);
  lockoutSelect.value = String(settings.lockoutMinutes);
  resetSelect.value = String(settings.resetAfterMinutes);
  pauseTimerInput.checked = settings.pauseTimerWhenTabHidden !== false;
  subredditModeSelect.value = settings.subredditMode;
  subredditListInput.value = getSubredditListForMode(settings).join(", ");
  warningEnabledInput.checked = settings.warningEnabled !== false;
  warningThresholdSelect.value = String(settings.warningThresholdPercent);
  snoozeEnabledInput.checked = settings.snoozeEnabled !== false;
  snoozeControls.hidden = !snoozeEnabledInput.checked;
  snoozeMinutesSelect.value = String(settings.snoozeMinutes);
  snoozeLimitSelect.value = String(settings.snoozeLimitPerSession);
}

function syncLimitControls(value) {
  limitInput.value = String(value);
  limitSlider.value = String(value);
  valueDisplay.textContent = String(value);
}

function queueLimitSave(value) {
  clearTimeout(saveTimer);

  // Debounce storage writes so slider dragging stays smooth and storage I/O stays modest.
  saveTimer = setTimeout(() => {
    saveSyncSetting("postLimit", value, `Saved limit: ${value}`);
  }, DEBOUNCE_MS);
}

function saveSyncSetting(key, value, message) {
  clearTimeout(saveTimer);
  currentSettings[key] = value;
  chrome.storage.sync.set({ [key]: value }, () => {
    showStatus(message);
  });
}

function saveSubredditRules() {
  const mode = subredditModeSelect.value;
  const list = normalizeSubredditList(subredditListInput.value);
  const updates = {
    subredditMode: mode,
    subredditAllowlist: mode === "only_listed" ? list : currentSettings.subredditAllowlist,
    subredditBlocklist: mode === "exclude_listed" ? list : currentSettings.subredditBlocklist
  };

  if (mode === "all") {
    updates.subredditAllowlist = currentSettings.subredditAllowlist;
    updates.subredditBlocklist = currentSettings.subredditBlocklist;
  }

  currentSettings = normalizeSettings({ ...currentSettings, ...updates });
  chrome.storage.sync.set(updates, () => {
    syncSettingsControls(currentSettings);
    showStatus("Feed rules saved");
  });
}

function renderReliableStatus() {
  cleanupExpiredState();

  const routeLabel = currentState.lastKnownRoute?.label || "Reddit";
  routeStatus.textContent = `Limiter active on ${routeLabel}`;

  if (currentState.globalLockedUntil && currentState.globalLockedUntil > Date.now()) {
    breakStatus.hidden = false;
    breakStatus.textContent = `Break active until ${formatTime(currentState.globalLockedUntil)}`;
  } else if (currentState.disabledUntil && currentState.disabledUntil > Date.now()) {
    breakStatus.hidden = false;
    breakStatus.textContent = `Disabled until ${formatTime(currentState.disabledUntil)}`;
  } else if (currentState.disabledUntilSessionReset) {
    breakStatus.hidden = false;
    breakStatus.textContent = "Disabled until next session";
  } else {
    breakStatus.hidden = true;
    breakStatus.textContent = "";
  }

  const snoozedUntil = getActiveSnoozedUntil();
  if (snoozedUntil && snoozedUntil > Date.now()) {
    snoozeStatus.hidden = false;
    snoozeStatus.textContent = `Snoozed until ${formatTime(snoozedUntil)}`;
  } else {
    snoozeStatus.hidden = true;
    snoozeStatus.textContent = "";
  }
}

function cleanupExpiredState() {
  let changed = false;

  if (currentState.globalLockedUntil && currentState.globalLockedUntil <= Date.now()) {
    currentState.globalLockedUntil = null;
    changed = true;
  }

  if (currentState.disabledUntil && currentState.disabledUntil <= Date.now()) {
    currentState.disabledUntil = null;
    changed = true;
  }

  for (const route of Object.values(currentState.routes)) {
    if (route.snoozedUntil && route.snoozedUntil <= Date.now()) {
      route.snoozedUntil = null;
      changed = true;
    }
  }

  if (changed) {
    chrome.storage.local.set({ [LOCAL_STATE_KEY]: currentState });
  }
}

function getActiveSnoozedUntil() {
  let activeUntil = 0;

  for (const route of Object.values(currentState.routes)) {
    if (route.snoozedUntil && route.snoozedUntil > activeUntil) {
      activeUntil = route.snoozedUntil;
    }
  }

  return activeUntil;
}

function startStatusCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
  }

  countdownTimer = setInterval(renderReliableStatus, 30000);
}

function normalizeSettings(settings) {
  return {
    postLimit: clampLimit(settings.postLimit),
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

function normalizeLocalState(state = {}) {
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

function getSubredditListForMode(settings) {
  if (settings.subredditMode === "only_listed") {
    return settings.subredditAllowlist;
  }

  if (settings.subredditMode === "exclude_listed") {
    return settings.subredditBlocklist;
  }

  return settings.subredditAllowlist.length > 0 ? settings.subredditAllowlist : settings.subredditBlocklist;
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

function clampLimit(value) {
  return clampNumber(value, DEFAULT_SETTINGS.postLimit, MIN_LIMIT, MAX_LIMIT);
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function formatDuration(minutes) {
  if (minutes === 60) {
    return "1 hour";
  }

  if (minutes > 60 && minutes % 60 === 0) {
    return `${minutes / 60} hours`;
  }

  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function showStatus(message) {
  clearTimeout(statusTimer);
  status.textContent = message;
  status.classList.add("visible");

  statusTimer = setTimeout(() => {
    status.classList.remove("visible");
  }, 1600);
}
