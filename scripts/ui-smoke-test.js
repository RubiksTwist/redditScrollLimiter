const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const ARTIFACTS_DIR = path.join(EXTENSION_ROOT, "artifacts");
const REMOTE_DEBUGGING_PORT = Number(process.env.RSL_DEBUG_PORT || randomPort());
const START_TIMEOUT_MS = 15000;

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const browserPath = resolveBrowserPath();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-ui-smoke-"));
  const browser = launchBrowser(browserPath, profileDir);

  try {
    await waitForJson(`http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/version`, START_TIMEOUT_MS);
    const worker = await waitForExtensionWorker();
    const extensionId = extractExtensionId(worker.url);

    await setExtensionStorage(extensionId, 100);
    const popup = await testPopupUi(extensionId);
    await setExtensionStorage(extensionId, 100);
    const blocker = await testBlockerUi();

    console.log(JSON.stringify({
      ok: true,
      browserPath,
      extensionId,
      screenshots: {
        popup: popup.screenshot,
        blocker: blocker.screenshot
      },
      checks: [
        "popup controls render and fit within 320px body",
        "popup reset interaction keeps inputs synchronized",
        "blocker overlay covers viewport and focuses primary action",
        "blocker clears the warning toast",
        "hide message plus downward scroll restores blocker",
        "back-to-viewed-posts button clears blocked state"
      ]
    }, null, 2));
  } finally {
    browser.kill();
    await sleep(1000);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }
}

async function testPopupUi(extensionId) {
  const page = await newPage(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 520,
    deviceScaleFactor: 1,
    mobile: false
  });

  try {
    await page.waitFor("Page.loadEventFired", 10000);
  } catch {
    await sleep(1000);
  }

  await sleep(500);

  const initial = await page.evaluate(`(() => {
    const ids = [
      "postLimit",
      "postLimitSlider",
      "enabled",
      "resetBtn",
      "status",
      "lockoutMinutes",
      "resetAfterMinutes",
      "limitMode",
      "timeLimitMinutes",
      "pauseTimerWhenTabHidden",
      "subredditMode",
      "subredditList",
      "warningEnabled",
      "warningThresholdPercent",
      "snoozeEnabled",
      "snoozeMinutes",
      "snoozeLimitPerSession",
      "startBreakBtn",
      "disableHourBtn",
      "disableSessionBtn",
      "disableFeedBtn",
      "routeStatus"
    ];
    const elements = Object.fromEntries(ids.map((id) => [id, Boolean(document.getElementById(id))]));
    return {
      title: document.querySelector("h1")?.textContent || "",
      width: Math.round(document.body.getBoundingClientRect().width),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      controlsPresent: Object.values(elements).every(Boolean),
      limit: document.getElementById("postLimit")?.value,
      slider: document.getElementById("postLimitSlider")?.value,
      enabled: document.getElementById("enabled")?.checked,
      lockoutMinutes: document.getElementById("lockoutMinutes")?.value,
      resetAfterMinutes: document.getElementById("resetAfterMinutes")?.value,
      limitMode: document.getElementById("limitMode")?.value,
      timeLimitMinutes: document.getElementById("timeLimitMinutes")?.value,
      pauseTimerWhenTabHidden: document.getElementById("pauseTimerWhenTabHidden")?.checked,
      subredditMode: document.getElementById("subredditMode")?.value,
      subredditList: document.getElementById("subredditList")?.value,
      warningEnabled: document.getElementById("warningEnabled")?.checked,
      warningThresholdPercent: document.getElementById("warningThresholdPercent")?.value,
      snoozeEnabled: document.getElementById("snoozeEnabled")?.checked,
      snoozeMinutes: document.getElementById("snoozeMinutes")?.value,
      snoozeLimitPerSession: document.getElementById("snoozeLimitPerSession")?.value,
      resetText: document.getElementById("resetBtn")?.textContent || "",
      startBreakText: document.getElementById("startBreakBtn")?.textContent || "",
      routeStatus: document.getElementById("routeStatus")?.textContent || ""
    };
  })()`);

  assert(initial.title === "Reddit Scroll Limiter", "Popup heading is missing.");
  assert(initial.width === 320, `Expected popup width 320px, got ${initial.width}px.`);
  assert(initial.scrollWidth <= initial.width, "Popup has horizontal overflow.");
  assert(initial.controlsPresent, "Popup is missing expected controls.");
  assert(initial.limit === "100" && initial.slider === "100", "Popup inputs did not load default limit.");
  assert(initial.enabled === true, "Popup enabled toggle did not default to true.");
  assert(initial.lockoutMinutes === "30", "Popup break length did not default to 30.");
  assert(initial.resetAfterMinutes === "30", "Popup reset window did not default to 30.");
  assert(initial.limitMode === "posts", "Popup limit mode did not default to posts.");
  assert(initial.timeLimitMinutes === "30", "Popup time limit did not default to 30.");
  assert(initial.pauseTimerWhenTabHidden === true, "Popup pause-timer toggle did not default to true.");
  assert(initial.subredditMode === "all", "Popup subreddit mode did not default to all.");
  assert(initial.subredditList === "", "Popup listed-feed input should default to empty.");
  assert(initial.warningEnabled === true, "Popup warning toggle did not default to true.");
  assert(initial.warningThresholdPercent === "80", "Popup warning threshold did not default to 80.");
  assert(initial.snoozeEnabled === true, "Popup snooze toggle did not default to true.");
  assert(initial.snoozeMinutes === "5", "Popup snooze length did not default to 5.");
  assert(initial.snoozeLimitPerSession === "1", "Popup snooze limit did not default to 1.");
  assert(initial.resetText === "Reset to 100", "Popup reset button text changed unexpectedly.");
  assert(initial.startBreakText === "Start break now", "Popup start-break button is missing.");
  assert(initial.routeStatus.includes("Limiter active on"), "Popup reliable route status is missing.");

  await page.evaluate(`new Promise((resolve) => {
    chrome.storage.local.set({
      redditScrollLimiterState: {
        globalLockedUntil: Date.now() + 30 * 60000,
        lastKnownRoute: {
          key: "subreddit:popular",
          label: "r/popular",
          href: "https://www.reddit.com/r/popular/",
          updatedAt: Date.now()
        },
        routes: {
          "subreddit:popular": {
            seenPostIds: [],
            viewedPostCount: 0,
            sessionStartedAt: Date.now(),
            lastActivityAt: Date.now(),
            activeSeconds: 0,
            snoozedUntil: Date.now() + 5 * 60000,
            snoozesUsed: 1
          }
        }
      }
    }, resolve);
  })`);
  await sleep(500);

  const seededStatus = await page.evaluate(`(() => ({
    route: document.getElementById("routeStatus")?.textContent || "",
    breakText: document.getElementById("breakStatus")?.textContent || "",
    snoozeText: document.getElementById("snoozeStatus")?.textContent || ""
  }))()`);

  assert(seededStatus.route === "Limiter active on r/popular", "Popup did not render seeded route status.");
  assert(seededStatus.breakText.includes("Break active until"), "Popup did not render seeded break status.");
  assert(seededStatus.snoozeText.includes("Snoozed until"), "Popup did not render seeded snooze status.");

  await page.evaluate(`document.getElementById("startBreakBtn").click()`);
  await sleep(500);

  const manualBreak = await page.evaluate(`new Promise((resolve) => {
    chrome.storage.local.get(["redditScrollLimiterState"], (items) => {
      resolve(items.redditScrollLimiterState?.globalLockedUntil || 0);
    });
  })`);

  assert(manualBreak > Date.now(), "Start break button did not write a future global lockout.");

  await page.evaluate(`(() => {
    document.getElementById("limitMode").value = "both";
    document.getElementById("limitMode").dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("timeLimitMinutes").value = "45";
    document.getElementById("timeLimitMinutes").dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("pauseTimerWhenTabHidden").checked = false;
    document.getElementById("pauseTimerWhenTabHidden").dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("subredditMode").value = "only_listed";
    document.getElementById("subredditList").value = "r/popular, Popular, AskReddit, home";
    document.getElementById("subredditList").dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("warningEnabled").checked = false;
    document.getElementById("warningEnabled").dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("warningThresholdPercent").value = "90";
    document.getElementById("warningThresholdPercent").dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await sleep(700);

  const storedNewControls = await page.evaluate(`new Promise((resolve) => {
    chrome.storage.sync.get([
      "limitMode",
      "timeLimitMinutes",
      "pauseTimerWhenTabHidden",
      "subredditMode",
      "subredditAllowlist",
      "warningEnabled",
      "warningThresholdPercent"
    ], resolve);
  })`);

  assert(storedNewControls.limitMode === "both", "Limit mode control did not persist.");
  assert(storedNewControls.timeLimitMinutes === 45, "Time limit control did not persist.");
  assert(storedNewControls.pauseTimerWhenTabHidden === false, "Pause-timer toggle did not persist.");
  assert(storedNewControls.subredditMode === "only_listed", "Subreddit mode did not persist.");
  assert(
    JSON.stringify(storedNewControls.subredditAllowlist) === JSON.stringify(["popular", "askreddit", "home"]),
    `Subreddit allowlist did not normalize correctly: ${JSON.stringify(storedNewControls.subredditAllowlist)}.`
  );
  assert(storedNewControls.warningEnabled === false, "Warning toggle did not persist.");
  assert(storedNewControls.warningThresholdPercent === 90, "Warning threshold did not persist.");

  await page.evaluate(`document.getElementById("disableHourBtn").click()`);
  await sleep(300);
  const disabledHour = await page.evaluate(`new Promise((resolve) => {
    chrome.storage.local.get(["redditScrollLimiterState"], (items) => {
      resolve(items.redditScrollLimiterState?.disabledUntil || 0);
    });
  })`);
  assert(disabledHour > Date.now(), "Disable for 1 hour did not write disabledUntil.");

  await page.evaluate(`document.getElementById("disableSessionBtn").click()`);
  await sleep(300);
  const disabledSession = await page.evaluate(`new Promise((resolve) => {
    chrome.storage.local.get(["redditScrollLimiterState"], (items) => {
      resolve(items.redditScrollLimiterState?.disabledUntilSessionReset === true);
    });
  })`);
  assert(disabledSession, "Disable until next session did not write disabledUntilSessionReset.");

  await page.evaluate(`document.getElementById("disableFeedBtn").click()`);
  await sleep(300);
  const disabledFeed = await page.evaluate(`new Promise((resolve) => {
    chrome.storage.local.get(["redditScrollLimiterState"], (items) => {
      resolve(items.redditScrollLimiterState?.disabledRouteKeys || []);
    });
  })`);
  assert(disabledFeed.includes("subreddit:popular"), "Disable this feed did not persist the last known route key.");

  await page.evaluate(`(() => {
    const input = document.getElementById("postLimit");
    input.value = "777";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("resetBtn").click();
  })()`);
  await sleep(700);

  const afterReset = await page.evaluate(`(() => ({
    limit: document.getElementById("postLimit").value,
    slider: document.getElementById("postLimitSlider").value,
    display: document.getElementById("valueDisplay").textContent
  }))()`);

  assert(afterReset.limit === "100", "Reset did not restore numeric input to 100.");
  assert(afterReset.slider === "100", "Reset did not restore slider to 100.");
  assert(afterReset.display === "100", "Reset did not restore display output to 100.");

  const screenshot = path.join(ARTIFACTS_DIR, "popup-ui.png");
  await captureScreenshot(page, screenshot);
  page.close();

  return { screenshot };
}

async function setExtensionStorage(extensionId, postLimit) {
  const page = await newPage(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.send("Runtime.enable");

  try {
    await page.waitFor("Page.loadEventFired", 10000);
  } catch {
    await sleep(1000);
  }

  await page.evaluate(`new Promise((resolve) => {
    chrome.storage.sync.set({
      postLimit: ${postLimit},
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
    }, resolve);
  })`);
  await page.evaluate(`new Promise((resolve) => {
    chrome.storage.local.clear(resolve);
  })`);
  const stored = await page.evaluate(`new Promise((resolve) => {
    chrome.storage.sync.get([
      "postLimit",
      "enabled",
      "lockoutMinutes",
      "resetAfterMinutes",
      "snoozeEnabled",
      "limitMode",
      "timeLimitMinutes",
      "pauseTimerWhenTabHidden",
      "subredditMode",
      "warningEnabled",
      "warningThresholdPercent"
    ], resolve);
  })`);
  page.close();

  assert(stored.postLimit === postLimit, `Storage setup failed: expected ${postLimit}, got ${stored.postLimit}.`);
  assert(stored.enabled === true, "Storage setup failed: expected enabled true.");
  assert(stored.lockoutMinutes === 30, "Storage setup failed: expected lockoutMinutes 30.");
  assert(stored.resetAfterMinutes === 30, "Storage setup failed: expected resetAfterMinutes 30.");
  assert(stored.snoozeEnabled === true, "Storage setup failed: expected snoozeEnabled true.");
  assert(stored.limitMode === "posts", "Storage setup failed: expected limitMode posts.");
  assert(stored.timeLimitMinutes === 30, "Storage setup failed: expected timeLimitMinutes 30.");
  assert(stored.pauseTimerWhenTabHidden === true, "Storage setup failed: expected pauseTimerWhenTabHidden true.");
  assert(stored.subredditMode === "all", "Storage setup failed: expected subredditMode all.");
  assert(stored.warningEnabled === true, "Storage setup failed: expected warningEnabled true.");
  assert(stored.warningThresholdPercent === 80, "Storage setup failed: expected warningThresholdPercent 80.");
}

async function testBlockerUi() {
  const page = await connectToFirstPage();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });

  await page.send("Page.navigate", { url: "https://old.reddit.com/" });
  try {
    await page.waitFor("Page.loadEventFired", 20000);
  } catch {
    await sleep(5000);
  }

  await sleep(3000);
  await injectSyntheticRedditFeed(page);
  await scrollUntilLimiterAppears(page);

  const overlay = await page.evaluate(`(() => {
    const overlay = document.getElementById("reddit-scroll-limiter-overlay");
    const dialog = overlay?.querySelector(".reddit-scroll-limiter-dialog");
    const primary = overlay?.querySelector("button");
    const overlayRect = overlay?.getBoundingClientRect();
    const dialogRect = dialog?.getBoundingClientRect();
    return {
      present: Boolean(overlay),
      warningPresent: Boolean(document.getElementById("reddit-scroll-limiter-warning")),
      text: overlay?.innerText || "",
      blocked: document.body.classList.contains("reddit-scroll-limiter-blocked"),
      activeText: document.activeElement?.textContent || "",
      viewport: {
        width: document.documentElement.clientWidth,
        height: window.innerHeight
      },
      overlayRect: overlayRect && {
        x: Math.round(overlayRect.x),
        y: Math.round(overlayRect.y),
        width: Math.round(overlayRect.width),
        height: Math.round(overlayRect.height)
      },
      dialogRect: dialogRect && {
        width: Math.round(dialogRect.width),
        height: Math.round(dialogRect.height)
      },
      buttons: Array.from(overlay?.querySelectorAll("button") || []).map((button) => button.textContent)
    };
  })()`);

  assert(overlay.present, "Blocker overlay did not appear.");
  assert(!overlay.warningPresent, "Warning toast remained visible after blocker appeared.");
  assert(overlay.blocked, "Blocker body class was not applied.");
  assert(overlay.text.includes("Time for a break"), "Blocker title is missing.");
  assert(overlay.text.includes("You have scrolled through 100 posts"), "Blocker count text is missing.");
  assert(overlay.text.includes("Reddit scrolling is paused until"), "Blocker countdown text is missing.");
  assert(overlay.activeText === "Back to viewed posts", "Primary blocker button was not focused.");
  assert(overlay.overlayRect.x === 0 && overlay.overlayRect.y === 0, "Overlay is not anchored to the viewport origin.");
  assert(overlay.overlayRect.width >= overlay.viewport.width - 2, `Overlay width does not cover the viewport: ${JSON.stringify(overlay)}.`);
  assert(overlay.overlayRect.height >= overlay.viewport.height - 2, `Overlay height does not cover the viewport: ${JSON.stringify(overlay)}.`);
  assert(overlay.dialogRect.width <= 440, "Blocker dialog is wider than intended.");
  assert(
    overlay.buttons.includes("Back to viewed posts") &&
    overlay.buttons.includes("Snooze 5 minutes") &&
    overlay.buttons.includes("Hide message"),
    "Blocker actions are missing."
  );

  const screenshot = path.join(ARTIFACTS_DIR, "blocker-ui.png");
  await captureScreenshot(page, screenshot);

  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27
  });
  await sleep(250);

  const hidden = await page.evaluate(`Boolean(document.getElementById("reddit-scroll-limiter-overlay")?.hidden)`);
  assert(hidden, "Escape did not hide the blocker message.");

  await page.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 600,
    y: 450,
    deltaY: 300,
    deltaX: 0
  });
  await sleep(500);

  const restored = await page.evaluate(`(() => {
    const overlay = document.getElementById("reddit-scroll-limiter-overlay");
    return Boolean(overlay) && !overlay.hidden;
  })()`);
  assert(restored, "Downward scroll did not restore blocker message after Escape.");

  await page.evaluate(`document.querySelector("#reddit-scroll-limiter-overlay button").click()`);
  await sleep(1200);

  const cleared = await page.evaluate(`(() => ({
    overlayPresent: Boolean(document.getElementById("reddit-scroll-limiter-overlay")),
    blocked: document.body.classList.contains("reddit-scroll-limiter-blocked"),
    scrollY: window.scrollY
  }))()`);

  assert(!cleared.overlayPresent, "Return button did not clear overlay.");
  assert(!cleared.blocked, "Return button did not clear blocked state.");

  page.close();
  return { screenshot };
}

async function captureScreenshot(page, filePath) {
  const result = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });

  fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
}

async function injectSyntheticRedditFeed(page) {
  await page.evaluate(`(() => {
    document.body.innerHTML = '<main id="rsl-test-feed" style="padding:20px;background:#f6f7f8;"></main>';
    const feed = document.getElementById("rsl-test-feed");

    for (let index = 1; index <= 112; index += 1) {
      const post = document.createElement("article");
      post.setAttribute("aria-label", "Test Reddit post " + index);
      post.style.cssText = "height:220px;margin:0 0 20px;padding:16px;background:white;border:1px solid #ddd;display:block;";
      post.innerHTML =
        '<h3>Test post ' + index + '</h3>' +
        '<a href="/r/test/comments/' + index.toString(36) + '/test_post_' + index + '">Comments</a>' +
        '<p>Smoke test content</p>';
      feed.appendChild(post);
    }
  })()`);

  await sleep(1200);
}

async function scrollUntilLimiterAppears(page) {
  await page.send("Runtime.evaluate", {
    expression: `new Promise((resolve) => {
      let y = 0;
      const timer = setInterval(() => {
        y += 260;
        window.scrollTo(0, y);
        if (document.getElementById("reddit-scroll-limiter-overlay") || y > document.documentElement.scrollHeight) {
          clearInterval(timer);
          setTimeout(resolve, 900);
        }
      }, 35);
    })`,
    awaitPromise: true
  });
}

function resolveBrowserPath() {
  if (process.env.RSL_BROWSER_PATH) {
    if (!fs.existsSync(process.env.RSL_BROWSER_PATH)) {
      throw new Error(`RSL_BROWSER_PATH does not exist: ${process.env.RSL_BROWSER_PATH}`);
    }

    return process.env.RSL_BROWSER_PATH;
  }

  const candidates = [
    "C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe",
    path.join(os.homedir(), ".cache", "chrome-for-testing", "chrome-win64", "chrome.exe"),
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) {
    return found;
  }

  throw new Error("No automation-friendly Chromium browser found. Set RSL_BROWSER_PATH.");
}

function launchBrowser(browserPath, profileDir) {
  return spawn(browserPath, [
    `--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`,
    `--user-data-dir=${profileDir}`,
    `--load-extension=${EXTENSION_ROOT.replace(/\\/g, "/")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--window-size=1200,900",
    "about:blank"
  ], { stdio: "ignore" });
}

async function connectToFirstPage() {
  const targets = await waitForJson(`http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/list`);
  const target = targets.find((candidate) => candidate.type === "page");
  assert(target, "No page target found.");
  return connect(target.webSocketDebuggerUrl);
}

async function newPage(url) {
  const endpoint = `http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { method: "PUT" });
  assert(response.ok, `Failed to create target for ${url}: ${response.status} ${response.statusText}`);
  const target = await response.json();
  return connect(target.webSocketDebuggerUrl);
}

async function waitForExtensionWorker() {
  const started = Date.now();

  while (Date.now() - started < START_TIMEOUT_MS) {
    const targets = await waitForJson(`http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/list`);
    const worker = targets.find((target) =>
      target.type === "service_worker" &&
      target.url.startsWith("chrome-extension://") &&
      target.url.endsWith("/background.js")
    );

    if (worker) {
      return worker;
    }

    await sleep(250);
  }

  throw new Error("The extension service worker did not load. Use Edge, Chromium, Chrome for Testing, or set RSL_BROWSER_PATH.");
}

function connect(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);

      if (message.error) {
        reject(new Error(JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }

      return;
    }

    for (const callback of listeners.get(message.method) || []) {
      callback(message.params);
    }
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          ws.send(JSON.stringify({ id, method, params }));

          return new Promise((resolveSend, rejectSend) => {
            pending.set(id, { resolve: resolveSend, reject: rejectSend });
          });
        },
        evaluate(expression) {
          return this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).then((result) => {
            if (result.exceptionDetails) {
              throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
            }

            return result.result.value;
          });
        },
        on(method, callback) {
          listeners.set(method, [...(listeners.get(method) || []), callback]);
        },
        waitFor(method, timeoutMs = 10000) {
          return new Promise((resolveEvent, rejectEvent) => {
            const timer = setTimeout(() => {
              const callbacks = listeners.get(method) || [];
              listeners.set(method, callbacks.filter((callback) => callback !== listener));
              rejectEvent(new Error(`Timed out waiting for ${method}`));
            }, timeoutMs);

            function listener(params) {
              clearTimeout(timer);
              const callbacks = listeners.get(method) || [];
              listeners.set(method, callbacks.filter((callback) => callback !== listener));
              resolveEvent(params);
            }

            listeners.set(method, [...(listeners.get(method) || []), listener]);
          });
        },
        close() {
          ws.close();
        }
      });
    });

    ws.addEventListener("error", reject);
  });
}

async function waitForJson(url, timeoutMs = 10000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
    } catch {}

    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function extractExtensionId(url) {
  const match = url.match(/^chrome-extension:\/\/([^/]+)\//);
  assert(match, `Could not extract extension ID from ${url}`);
  return match[1];
}

function randomPort() {
  return 9300 + Math.floor(Math.random() * 600);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
