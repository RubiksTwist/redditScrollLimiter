const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const REMOTE_DEBUGGING_PORT = Number(process.env.RSL_DEBUG_PORT || randomPort());
const CHROMIUM_START_TIMEOUT_MS = 15000;
const DEFAULT_POST_LIMIT = 100;

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  testRouteRuleMatching();

  const browserPath = resolveBrowserPath();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-runtime-smoke-"));
  const browser = launchBrowser(browserPath, profileDir);

  try {
    await waitForJson(`http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/version`, CHROMIUM_START_TIMEOUT_MS);
    const workerTarget = await waitForExtensionWorker();
    const extensionId = extractExtensionId(workerTarget.url);

    await setExtensionStorage(extensionId, DEFAULT_POST_LIMIT);
    await runContentScriptSmoke(extensionId);
    await runPopupSmoke(extensionId);

    console.log(JSON.stringify({
      ok: true,
      browserPath,
      extensionId,
      checks: [
        "extension service worker loaded",
        "content script initialized on www.reddit.com",
        "feed include/exclude route rules matched popular, home, and specific subreddits",
        "settings and local route state round-tripped",
        "popup loaded without inline-script CSP failure"
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

function testRouteRuleMatching() {
  const contentScriptPath = path.join(EXTENSION_ROOT, "content-scripts", "reddit-limiter.js");
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const bootstrapPattern = /\s+getSettingsAndState\(\(settings, state\) => \{\s+const limiter = new RedditScrollLimiter\(settings, state\);\s+limiter\.init\(\);\s+\}\);/;
  const testSource = source.replace(
    bootstrapPattern,
    "\n  window.__RSL_TEST_EXPORTS__ = { RedditScrollLimiter, getRouteInfo, getRouteRuleNames, normalizeSettings };"
  );

  assert(testSource !== source, "Could not prepare content-script route-rule test hooks.");

  const context = {
    window: {
      location: {
        href: "https://www.reddit.com/",
        pathname: "/"
      },
      scrollY: 0,
      addEventListener() {}
    },
    document: {
      addEventListener() {},
      documentElement: { classList: { add() {}, remove() {} } },
      body: { classList: { add() {}, remove() {} } }
    },
    console,
    Date,
    IntersectionObserver: function IntersectionObserver() {},
    MutationObserver: function MutationObserver() {}
  };

  require("node:vm").runInNewContext(testSource, context, {
    filename: contentScriptPath
  });

  const { RedditScrollLimiter, getRouteInfo, getRouteRuleNames } = context.window.__RSL_TEST_EXPORTS__;
  assert(typeof RedditScrollLimiter === "function", "Route-rule test hooks did not load limiter class.");

  const routeNames = (pathname) => getRouteRuleNames(getRouteInfo(pathname));
  assert(JSON.stringify(routeNames("/popular")) === JSON.stringify(["popular"]), "Popular route should only match popular.");
  assert(routeNames("/").includes("home") && !routeNames("/").includes("popular"), "Home route should not be treated as popular.");
  assert(JSON.stringify(routeNames("/r/technology")) === JSON.stringify(["technology"]), "Subreddit route should match only its subreddit name.");

  const isLimited = (pathname, settings) => {
    context.window.location.pathname = pathname;
    context.window.location.href = `https://www.reddit.com${pathname}`;
    const limiter = new RedditScrollLimiter(settings, {});
    limiter.currentRoute = getRouteInfo(pathname);
    return limiter.isCurrentRouteLimited();
  };

  assert(isLimited("/popular", {
    subredditMode: "only_listed",
    subredditAllowlist: ["popular"]
  }) === true, "Only-listed popular should limit /popular.");
  assert(isLimited("/", {
    subredditMode: "only_listed",
    subredditAllowlist: ["popular"]
  }) === false, "Only-listed popular should not limit home.");
  assert(isLimited("/r/mycommunity", {
    subredditMode: "only_listed",
    subredditAllowlist: ["popular"]
  }) === false, "Only-listed popular should not limit an unrelated subreddit.");
  assert(isLimited("/r/technology", {
    subredditMode: "only_listed",
    subredditAllowlist: ["technology"]
  }) === true, "Only-listed technology should limit r/technology.");
  assert(isLimited("/r/technology", {
    subredditMode: "exclude_listed",
    subredditBlocklist: ["technology"]
  }) === false, "Excluded technology should not limit r/technology.");
  assert(isLimited("/popular", {
    subredditMode: "exclude_listed",
    subredditBlocklist: ["technology"]
  }) === true, "Excluded technology should still limit /popular.");
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

  throw new Error(
    "No automation-friendly Chromium browser found. Install Chrome for Testing/Chromium, " +
    "or set RSL_BROWSER_PATH to msedge.exe/chrome.exe."
  );
}

function launchBrowser(browserPath, profileDir) {
  const extensionPath = EXTENSION_ROOT.replace(/\\/g, "/");
  const args = [
    `--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`,
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--window-size=1200,900",
    "about:blank"
  ];

  return spawn(browserPath, args, { stdio: "ignore" });
}

async function runContentScriptSmoke(extensionId) {
  const page = await connectToFirstPage();
  const runtimeErrors = [];

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  page.on("Runtime.exceptionThrown", (params) => {
    runtimeErrors.push(params.exceptionDetails?.text || "Runtime exception");
  });

  await page.send("Page.navigate", { url: "https://www.reddit.com/" });
  try {
    await page.waitFor("Page.loadEventFired", 20000);
  } catch {
    await sleep(5000);
  }

  await sleep(3000);
  await page.evaluate(`window.scrollTo(0, Math.min(600, document.documentElement.scrollHeight || 0))`);
  await sleep(1000);

  const pageResult = await page.evaluate(`(() => ({
    href: window.location.href,
    overlayPresent: Boolean(document.getElementById("reddit-scroll-limiter-overlay")),
    bodyBlocked: document.body.classList.contains("reddit-scroll-limiter-blocked")
  }))()`);

  page.close();

  const state = await getExtensionLocalState(extensionId);

  assert(pageResult.href.startsWith("https://www.reddit.com/"), `Expected Reddit page URL, got ${pageResult.href}.`);
  assert(pageResult.overlayPresent === false, "Runtime smoke should not force blocker UI without real Reddit posts.");
  assert(pageResult.bodyBlocked === false, "Runtime smoke should not block the page without a real limit trigger.");
  assert(state.lastKnownRoute?.key === "home", `Expected content script to persist home route, got ${state.lastKnownRoute?.key || "none"}.`);
  assert(state.lastKnownRoute?.href?.startsWith("https://www.reddit.com/"), "Expected persisted route href to be www.reddit.com.");
  assert(runtimeErrors.length === 0, `Runtime errors on Reddit page: ${runtimeErrors.join("; ")}`);
}

async function runPopupSmoke(extensionId) {
  const page = await newPage(`chrome-extension://${extensionId}/popup/popup.html`);
  const runtimeErrors = [];

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  page.on("Runtime.exceptionThrown", (params) => {
    runtimeErrors.push(params.exceptionDetails?.text || "Runtime exception");
  });

  try {
    await page.waitFor("Page.loadEventFired", 10000);
  } catch {
    await sleep(1000);
  }

  await sleep(500);
  const result = await page.evaluate(`(() => ({
    title: document.querySelector("h1")?.textContent || "",
    width: Math.round(document.body.getBoundingClientRect().width),
    limit: document.getElementById("postLimit")?.value,
    slider: document.getElementById("postLimitSlider")?.value,
    enabled: document.getElementById("enabled")?.checked,
    lockoutMinutes: document.getElementById("lockoutMinutes")?.value,
    resetAfterMinutes: document.getElementById("resetAfterMinutes")?.value,
    limitMode: document.getElementById("limitMode")?.value,
    timeLimitMinutes: document.getElementById("timeLimitMinutes")?.value,
    pauseTimerWhenTabHidden: document.getElementById("pauseTimerWhenTabHidden")?.checked,
    subredditMode: document.getElementById("subredditMode")?.value,
    warningEnabled: document.getElementById("warningEnabled")?.checked,
    warningThresholdPercent: document.getElementById("warningThresholdPercent")?.value,
    snoozeEnabled: document.getElementById("snoozeEnabled")?.checked,
    snoozePostCount: document.getElementById("snoozePostCount")?.value,
    snoozeMinutes: document.getElementById("snoozeMinutes")?.value,
    snoozeLimitPerSession: document.getElementById("snoozeLimitPerSession")?.value,
    inlineScripts: document.querySelectorAll("script:not([src])").length,
    inlineHandlers: Array.from(document.querySelectorAll("*")).some((node) =>
      Array.from(node.attributes).some((attribute) => /^on/i.test(attribute.name))
    )
  }))()`);

  page.close();

  assert(result.title === "Reddit Scroll Limiter", "Popup title did not render.");
  assert(result.width === 320, `Expected popup body width 320px, got ${result.width}px.`);
  assert(result.limit === "100", `Expected default popup limit 100, got ${result.limit}.`);
  assert(result.slider === "100", `Expected default slider value 100, got ${result.slider}.`);
  assert(result.enabled === true, "Expected popup enabled toggle to default to true.");
  assert(result.lockoutMinutes === "30", `Expected default lockout 30, got ${result.lockoutMinutes}.`);
  assert(result.resetAfterMinutes === "30", `Expected default reset window 30, got ${result.resetAfterMinutes}.`);
  assert(result.limitMode === "posts", `Expected default limit mode posts, got ${result.limitMode}.`);
  assert(result.timeLimitMinutes === "30", `Expected default time limit 30, got ${result.timeLimitMinutes}.`);
  assert(result.pauseTimerWhenTabHidden === true, "Expected pause-timer toggle to default true.");
  assert(result.subredditMode === "all", `Expected default subreddit mode all, got ${result.subredditMode}.`);
  assert(result.warningEnabled === true, "Expected warning toggle to default true.");
  assert(result.warningThresholdPercent === "80", `Expected warning threshold 80, got ${result.warningThresholdPercent}.`);
  assert(result.snoozeEnabled === true, "Expected snooze toggle to default to true.");
  assert(result.snoozePostCount === "5", `Expected default snooze post count 5, got ${result.snoozePostCount}.`);
  assert(result.snoozeMinutes === "5", `Expected default snooze minutes 5, got ${result.snoozeMinutes}.`);
  assert(result.snoozeLimitPerSession === "1", `Expected default snooze limit 1, got ${result.snoozeLimitPerSession}.`);
  assert(result.inlineScripts === 0, "Popup contains inline scripts.");
  assert(result.inlineHandlers === false, "Popup contains inline event handlers.");
  assert(runtimeErrors.length === 0, `Runtime errors on popup page: ${runtimeErrors.join("; ")}`);
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
      snoozePostCount: 5,
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
      "resetAfterMinutes",
      "lockoutMinutes",
      "snoozeEnabled",
      "snoozePostCount",
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
  assert(stored.resetAfterMinutes === 30, "Storage setup failed: expected resetAfterMinutes 30.");
  assert(stored.lockoutMinutes === 30, "Storage setup failed: expected lockoutMinutes 30.");
  assert(stored.snoozeEnabled === true, "Storage setup failed: expected snoozeEnabled true.");
  assert(stored.snoozePostCount === 5, "Storage setup failed: expected snoozePostCount 5.");
  assert(stored.limitMode === "posts", "Storage setup failed: expected limitMode posts.");
  assert(stored.timeLimitMinutes === 30, "Storage setup failed: expected timeLimitMinutes 30.");
  assert(stored.pauseTimerWhenTabHidden === true, "Storage setup failed: expected pauseTimerWhenTabHidden true.");
  assert(stored.subredditMode === "all", "Storage setup failed: expected subredditMode all.");
  assert(stored.warningEnabled === true, "Storage setup failed: expected warningEnabled true.");
  assert(stored.warningThresholdPercent === 80, "Storage setup failed: expected warningThresholdPercent 80.");
}

async function getExtensionLocalState(extensionId) {
  const page = await newPage(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.send("Runtime.enable");

  try {
    await page.waitFor("Page.loadEventFired", 10000);
  } catch {
    await sleep(1000);
  }

  const state = await page.evaluate(`new Promise((resolve) => {
    chrome.storage.local.get(["redditScrollLimiterState"], (items) => {
      resolve(items.redditScrollLimiterState || {});
    });
  })`);
  page.close();
  return state;
}

async function connectToFirstPage() {
  const targets = await waitForJson(`http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/list`);
  const target = targets.find((candidate) => candidate.type === "page");
  assert(target, "No page target found.");
  return connect(target.webSocketDebuggerUrl);
}

async function newPage(url) {
  const target = await createTarget(url);
  assert(target, `No page target found for ${url}.`);
  return connect(target.webSocketDebuggerUrl);
}

async function createTarget(url) {
  const endpoint = `http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { method: "PUT" });

  if (!response.ok) {
    throw new Error(`Failed to create target for ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function waitForExtensionWorker() {
  const started = Date.now();

  while (Date.now() - started < CHROMIUM_START_TIMEOUT_MS) {
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

  throw new Error(
    "The extension service worker did not load. Branded Google Chrome may ignore --load-extension; " +
    "use Edge, Chromium, Chrome for Testing, or set RSL_BROWSER_PATH."
  );
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
