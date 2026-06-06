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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (items) => {
    const updates = {};

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (items[key] === undefined) {
        updates[key] = value;
      }
    }

    if (Object.keys(updates).length > 0) {
      chrome.storage.sync.set(updates);
    }
  });
});
