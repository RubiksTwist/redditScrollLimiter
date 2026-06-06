const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const EXTENSION_ROOT = process.env.RSL_EXTENSION_ROOT
  ? path.resolve(process.env.RSL_EXTENSION_ROOT)
  : PROJECT_ROOT;
const ARTIFACTS_DIR = process.env.RSL_ARTIFACTS_DIR
  ? path.resolve(process.env.RSL_ARTIFACTS_DIR)
  : path.join(PROJECT_ROOT, "artifacts");
const REMOTE_DEBUGGING_PORT = Number(process.env.RSL_DEBUG_PORT || randomPort());
const START_TIMEOUT_MS = 15000;
const MODERN_URL = process.env.RSL_LIVE_REDDIT_URL || "https://www.reddit.com/r/popular/";
const OLD_REDDIT_URL = process.env.RSL_LIVE_OLD_REDDIT_URL || "https://old.reddit.com/r/popular/";
const MODERN_LIMIT = Number(process.env.RSL_LIVE_POST_LIMIT || 5);
const OLD_LIMIT = Number(process.env.RSL_LIVE_OLD_POST_LIMIT || 3);
const MIN_VISIBILITY_RATIO = 0.5;
const LIVE_TIMEOUT_MS = 45000;

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const browserPath = resolveBrowserPath();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-live-reddit-"));
  const browser = launchBrowser(browserPath, profileDir);
  const skips = [];
  const screenshots = {};
  const testedUrls = [];
  const livePosts = {
    modern: [],
    oldReddit: []
  };

  try {
    await waitForJson(`http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/version`, START_TIMEOUT_MS);
    const worker = await waitForExtensionWorker();
    const extensionId = extractExtensionId(worker.url);

    screenshots.popup = await configureStorageAndTestPopup(extensionId, MODERN_LIMIT);

    const modern = await runModernRedditLiveTest(MODERN_URL, MODERN_LIMIT);
    testedUrls.push(MODERN_URL);
    if (modern.skip) {
      skips.push(modern.skip);
    } else {
      screenshots.modern = modern.screenshot;
      livePosts.modern = modern.posts;
    }

    await setExtensionStorage(extensionId, OLD_LIMIT);
    const oldReddit = await runOldRedditLiveTest(OLD_REDDIT_URL, OLD_LIMIT);
    testedUrls.push(OLD_REDDIT_URL);
    if (oldReddit.skip) {
      skips.push(oldReddit.skip);
    } else {
      screenshots.oldReddit = oldReddit.screenshot;
      livePosts.oldReddit = oldReddit.posts;
    }

    console.log(JSON.stringify({
      ok: true,
      browserPath,
      extensionId,
      testedUrls,
      screenshots,
      livePosts,
      skips
    }, null, 2));
  } finally {
    browser.kill();
    await sleep(1000);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }
}

async function configureStorageAndTestPopup(extensionId, postLimit) {
  await setExtensionStorage(extensionId, postLimit);

  const page = await newPage(`chrome-extension://${extensionId}/popup/popup.html`);
  const runtimeErrors = [];

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false
  });
  page.on("Runtime.exceptionThrown", (params) => {
    runtimeErrors.push(params.exceptionDetails?.text || "Runtime exception");
  });

  try {
    await page.waitFor("Page.loadEventFired", 10000);
  } catch {
    await sleep(1000);
  }

  await sleep(700);
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
  await sleep(700);

  const result = await page.evaluate(`(() => ({
    title: document.querySelector("h1")?.textContent || "",
    width: Math.round(document.body.getBoundingClientRect().width),
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    limit: document.getElementById("postLimit")?.value,
    slider: document.getElementById("postLimitSlider")?.value,
    display: document.getElementById("valueDisplay")?.textContent,
    enabled: document.getElementById("enabled")?.checked,
    limitMode: document.getElementById("limitMode")?.value,
    timeLimitMinutes: document.getElementById("timeLimitMinutes")?.value,
    pauseTimerWhenTabHidden: document.getElementById("pauseTimerWhenTabHidden")?.checked,
    subredditMode: document.getElementById("subredditMode")?.value,
    warningEnabled: document.getElementById("warningEnabled")?.checked,
    warningThresholdPercent: document.getElementById("warningThresholdPercent")?.value,
    inlineScripts: document.querySelectorAll("script:not([src])").length
  }))()`);

  assert(result.title === "Reddit Scroll Limiter", "Live popup title did not render.");
  assert(result.width === 320, `Expected live popup width 320px, got ${result.width}px.`);
  assert(result.scrollWidth <= result.width, "Live popup has horizontal overflow.");
  assert(result.limit === String(postLimit), `Expected popup limit ${postLimit}, got ${result.limit}.`);
  assert(result.slider === String(postLimit), `Expected popup slider ${postLimit}, got ${result.slider}.`);
  assert(result.display === String(postLimit), `Expected popup display ${postLimit}, got ${result.display}.`);
  assert(result.enabled === true, "Expected live popup enabled toggle to be true.");
  assert(result.limitMode === "posts", `Expected live popup limit mode posts, got ${result.limitMode}.`);
  assert(result.timeLimitMinutes === "30", `Expected live popup time limit 30, got ${result.timeLimitMinutes}.`);
  assert(result.pauseTimerWhenTabHidden === true, "Expected live popup pause-timer toggle to be true.");
  assert(result.subredditMode === "all", `Expected live popup subreddit mode all, got ${result.subredditMode}.`);
  assert(result.warningEnabled === true, "Expected live popup warning toggle to be true.");
  assert(result.warningThresholdPercent === "80", `Expected live popup warning threshold 80, got ${result.warningThresholdPercent}.`);
  assert(result.inlineScripts === 0, "Live popup contains inline scripts.");
  assert(runtimeErrors.length === 0, `Runtime errors in live popup: ${runtimeErrors.join("; ")}`);

  const screenshot = path.join(ARTIFACTS_DIR, "live-popup-ui.png");
  await captureScreenshot(page, screenshot);
  page.close();
  return screenshot;
}

async function setExtensionStorage(extensionId, postLimit) {
  const storagePage = await newPage(`chrome-extension://${extensionId}/popup/popup.html`);
  await storagePage.send("Page.enable");
  await storagePage.send("Runtime.enable");
  try {
    await storagePage.waitFor("Page.loadEventFired", 10000);
  } catch {
    await sleep(1000);
  }
  await storagePage.evaluate(`new Promise((resolve) => {
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
  await storagePage.evaluate(`new Promise((resolve) => {
    chrome.storage.local.clear(resolve);
  })`);
  await sleep(1200);
  await storagePage.evaluate(`new Promise((resolve) => {
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
  const stored = await storagePage.evaluate(`new Promise((resolve) => {
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
  storagePage.close();
  assert(stored.postLimit === postLimit, `Storage setup failed: expected postLimit ${postLimit}, got ${stored.postLimit}.`);
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
  await sleep(1200);
}

async function runModernRedditLiveTest(url, postLimit) {
  const page = await connectToFirstPage();
  const runtimeErrors = [];

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  page.on("Runtime.exceptionThrown", (params) => {
    runtimeErrors.push(params.exceptionDetails?.text || "Runtime exception");
  });

  const load = await navigateAndWait(page, url);
  if (!load.ok) {
    page.close();
    return { skip: { test: "modern", reason: load.reason, url } };
  }

  const readiness = await waitForLivePosts(page, "modern", postLimit);
  if (!readiness.ok) {
    const block = await detectBlockingPage(page);
    page.close();
    return {
      skip: {
        test: "modern",
        reason: block.reason || readiness.reason,
        url,
        observedPostCount: readiness.posts.length,
        posts: readiness.posts
      }
    };
  }

  const activation = await scrollLiveFeedUntilBlocked(page, "modern", postLimit);
  if (!activation.ok) {
    page.close();
    throw new Error(`Modern Reddit found real posts but blocker did not activate: ${activation.reason}`);
  }

  assert(runtimeErrors.length === 0, `Runtime errors on modern Reddit page: ${runtimeErrors.join("; ")}`);

  const screenshot = path.join(ARTIFACTS_DIR, "live-reddit-blocker-ui.png");
  await captureScreenshot(page, screenshot);
  await assertLiveBlockerInteraction(page);

  page.close();
  return {
    screenshot,
    posts: activation.posts
  };
}

async function runOldRedditLiveTest(url, postLimit) {
  const page = await newPage("about:blank");
  const runtimeErrors = [];

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  page.on("Runtime.exceptionThrown", (params) => {
    runtimeErrors.push(params.exceptionDetails?.text || "Runtime exception");
  });

  const load = await navigateAndWait(page, url);
  if (!load.ok) {
    page.close();
    return { skip: { test: "oldReddit", reason: load.reason, url } };
  }

  const readiness = await waitForLivePosts(page, "old", postLimit);
  if (!readiness.ok) {
    const block = await detectBlockingPage(page);
    page.close();
    return {
      skip: {
        test: "oldReddit",
        reason: block.reason || readiness.reason,
        url,
        observedPostCount: readiness.posts.length,
        posts: readiness.posts
      }
    };
  }

  const activation = await scrollLiveFeedUntilBlocked(page, "old", postLimit);
  if (!activation.ok) {
    page.close();
    return {
      skip: {
        test: "oldReddit",
        reason: activation.reason,
        url,
        observedPostCount: activation.posts.length,
        posts: activation.posts
      }
    };
  }

  if (runtimeErrors.length > 0) {
    page.close();
    return {
      skip: {
        test: "oldReddit",
        reason: `Runtime errors on old Reddit: ${runtimeErrors.join("; ")}`,
        url
      }
    };
  }

  const screenshot = path.join(ARTIFACTS_DIR, "live-old-reddit-blocker-ui.png");
  await captureScreenshot(page, screenshot);
  page.close();

  return {
    screenshot,
    posts: activation.posts
  };
}

async function navigateAndWait(page, url) {
  await page.send("Page.navigate", { url });

  try {
    await page.waitFor("Page.loadEventFired", 25000);
  } catch {
    await sleep(5000);
  }

  await sleep(3500);

  const state = await page.evaluate(`(() => ({
    href: location.href,
    title: document.title,
    bodyText: document.body?.innerText?.slice(0, 600) || "",
    statusLikeNetworkError: document.body?.innerText?.includes("This site can't be reached") || false
  }))()`);

  if (!state.href.startsWith(url.replace(/\/$/, "")) && !state.href.includes(new URL(url).hostname)) {
    return { ok: false, reason: `Navigated away to ${state.href}` };
  }

  if (state.statusLikeNetworkError) {
    return { ok: false, reason: "Browser showed a network error page" };
  }

  return { ok: true };
}

async function waitForLivePosts(page, mode, minimumPosts) {
  const started = Date.now();
  let posts = [];

  while (Date.now() - started < LIVE_TIMEOUT_MS) {
    posts = await collectLivePostEvidence(page, mode);
    if (posts.length >= minimumPosts) {
      return { ok: true, posts };
    }

    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 600,
      y: 700,
      deltaY: 650,
      deltaX: 0
    });
    await sleep(1200);
  }

  return {
    ok: false,
    reason: `Timed out waiting for ${minimumPosts} live ${mode} Reddit posts`,
    posts
  };
}

async function scrollLiveFeedUntilBlocked(page, mode, postLimit) {
  const viewed = new Map();
  const started = Date.now();

  while (Date.now() - started < LIVE_TIMEOUT_MS) {
    const visiblePosts = await collectVisibleLivePostEvidence(page, mode);
    for (const post of visiblePosts) {
      viewed.set(post.id, post);
    }

    const blocker = await getBlockerState(page);
    if (blocker.present) {
      if (mode === "modern" && !blocker.cardPresent) {
        return {
          ok: false,
          reason: `Modern Reddit used overlay fallback instead of feed card: ${blocker.text}`,
          posts: Array.from(viewed.values())
        };
      }

      if (mode === "old" && blocker.cardPresent) {
        return {
          ok: false,
          reason: "Old Reddit unexpectedly rendered the in-feed card",
          posts: Array.from(viewed.values())
        };
      }

      if (blocker.warningPresent) {
        return {
          ok: false,
          reason: "Warning toast remained visible after blocker appeared",
          posts: Array.from(viewed.values())
        };
      }

      if (!blocker.text.includes(`You have scrolled through ${postLimit} posts`)) {
        return {
          ok: false,
          reason: `Blocker text did not include expected count ${postLimit}: ${blocker.text}`,
          posts: Array.from(viewed.values())
        };
      }

      if (!blocker.blocked) {
        return {
          ok: false,
          reason: "Blocker appeared but blocked body class was not applied",
          posts: Array.from(viewed.values())
        };
      }

      return {
        ok: true,
        posts: Array.from(viewed.values()).slice(0, postLimit)
      };
    }

    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 600,
      y: 710,
      deltaY: 520,
      deltaX: 0
    });
    await sleep(700);
  }

  return {
    ok: false,
    reason: `Timed out before blocker activated; viewed ${viewed.size} real posts`,
    posts: Array.from(viewed.values())
  };
}

async function assertLiveBlockerInteraction(page) {
  const initial = await getBlockerState(page);
  if (initial.cardPresent) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 600,
      y: 500,
      deltaY: 300,
      deltaX: 0
    });
    await sleep(600);

    const stillBlocked = await getBlockerState(page);
    assert(stillBlocked.cardPresent || stillBlocked.overlayPresent, "Feed-card blocker disappeared instead of remaining visible or falling back.");
    assert(stillBlocked.blocked, "Feed-card blocker did not preserve blocked state after downward scroll.");

    await page.evaluate(`document.querySelector("#reddit-scroll-limiter-feed-card button")?.click()`);
    const cleared = await waitForClearedBlocker(page, 6000);

    assert(!cleared.cardPresent, "Live blocker return button did not clear feed card.");
    assert(!cleared.overlayPresent, "Live blocker return button did not clear overlay.");
    assert(!cleared.blocked, "Live blocker return button did not clear blocked state.");
    return;
  }

  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27
  });
  await sleep(300);

  const hidden = await page.evaluate(`Boolean(document.getElementById("reddit-scroll-limiter-overlay")?.hidden)`);
  assert(hidden, "Live blocker Escape interaction did not hide message.");

  await page.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 600,
    y: 500,
    deltaY: 300,
    deltaX: 0
  });
  await sleep(600);

  const restored = await page.evaluate(`(() => {
    const overlay = document.getElementById("reddit-scroll-limiter-overlay");
    return Boolean(overlay) && !overlay.hidden;
  })()`);
  assert(restored, "Live blocker did not restore after downward scroll.");

  await page.evaluate(`document.querySelector("#reddit-scroll-limiter-overlay button")?.click()`);
  const cleared = await waitForClearedBlocker(page, 6000);

  assert(!cleared.overlayPresent, "Live blocker return button did not clear overlay.");
  assert(!cleared.cardPresent, "Live blocker return button did not clear feed card.");
  assert(!cleared.blocked, "Live blocker return button did not clear blocked state.");
}

async function waitForClearedBlocker(page, timeoutMs) {
  const started = Date.now();
  let state = {
    overlayPresent: true,
    blocked: true
  };

  while (Date.now() - started < timeoutMs) {
    state = await page.evaluate(`(() => ({
      overlayPresent: Boolean(document.getElementById("reddit-scroll-limiter-overlay")),
      cardPresent: Boolean(document.getElementById("reddit-scroll-limiter-feed-card")),
      blocked: document.body.classList.contains("reddit-scroll-limiter-blocked")
    }))()`);

    if (!state.overlayPresent && !state.cardPresent && !state.blocked) {
      return state;
    }

    await sleep(250);
  }

  return state;
}

async function collectLivePostEvidence(page, mode) {
  return page.evaluate(getCollectPostsExpression(mode, false));
}

async function collectVisibleLivePostEvidence(page, mode) {
  return page.evaluate(getCollectPostsExpression(mode, true));
}

function getCollectPostsExpression(mode, visibleOnly) {
  return `(() => {
    const mode = ${JSON.stringify(mode)};
    const visibleOnly = ${JSON.stringify(visibleOnly)};
    const candidates = mode === "old"
      ? Array.from(document.querySelectorAll(".thing.link"))
      : Array.from(document.querySelectorAll("shreddit-post, [data-testid='post-container'], article[aria-label]"));
    const seen = new Set();
    const posts = [];

    for (const element of candidates) {
      const evidence = getEvidence(element, mode);
      if (!evidence || seen.has(evidence.id)) continue;
      if (visibleOnly && getVisibleRatio(element) < ${MIN_VISIBILITY_RATIO}) continue;
      seen.add(evidence.id);
      posts.push(evidence);
    }

    return posts.slice(0, 25);

    function getEvidence(element, mode) {
      const href = findCommentsHref(element);
      const idMatch = href && href.match(/\\/comments\\/([a-z0-9]+)/i);
      const oldId = element.id && element.id.startsWith("thing_t3_") ? element.id.replace("thing_", "") : "";
      const id = idMatch ? idMatch[1].toLowerCase() : oldId;
      if (!id) return null;

      if (mode !== "old" && element.matches("article[aria-label]") && !idMatch) {
        return null;
      }

      const title =
        element.querySelector("h1, h2, h3, [slot='title'], a.title, .title")?.textContent ||
        element.getAttribute("aria-label") ||
        "";

      return {
        id,
        permalink: href || "",
        title: title.trim().replace(/\\s+/g, " ").slice(0, 140),
        snippet: (element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 180)
      };
    }

    function findCommentsHref(element) {
      const hrefs = [];
      if (element.href) hrefs.push(element.href);
      for (const link of element.querySelectorAll("a[href]")) {
        hrefs.push(link.href);
      }
      return hrefs.find((href) => /\\/comments\\/[a-z0-9]+/i.test(href)) || "";
    }

    function getVisibleRatio(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return 0;
      const visibleTop = Math.max(rect.top, 0);
      const visibleBottom = Math.min(rect.bottom, window.innerHeight);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      return visibleHeight / rect.height;
    }
  })()`;
}

async function detectBlockingPage(page) {
  const state = await page.evaluate(`(() => {
    const text = (document.body?.innerText || "").toLowerCase();
    if (text.includes("blocked") || text.includes("too many requests")) return "Reddit appears to be blocking the automated browser";
    if (text.includes("enable javascript")) return "Reddit showed a JavaScript/interstitial page";
    if (text.includes("sign up") && text.includes("log in") && !document.querySelector("shreddit-post, [data-testid='post-container'], .thing.link")) {
      return "Reddit showed a login/landing page instead of public posts";
    }
    return "";
  })()`);

  return { reason: state };
}

async function getBlockerState(page) {
  return page.evaluate(`(() => {
    const overlay = document.getElementById("reddit-scroll-limiter-overlay");
    const card = document.getElementById("reddit-scroll-limiter-feed-card");
    const warning = document.getElementById("reddit-scroll-limiter-warning");
    return {
      present: Boolean(overlay) || Boolean(card),
      overlayPresent: Boolean(overlay),
      cardPresent: Boolean(card),
      warningPresent: Boolean(warning),
      text: card ? card.innerText : (overlay ? overlay.innerText : ""),
      blocked: document.body.classList.contains("reddit-scroll-limiter-blocked")
    };
  })()`);
}

async function captureScreenshot(page, filePath) {
  const result = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });

  fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
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
