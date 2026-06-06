const { spawnSync } = require("node:child_process");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, "artifacts", "release");
const REMOTE_DEBUGGING_PORT = Number(process.env.RSL_DEBUG_PORT || randomPort());
const START_TIMEOUT_MS = 15000;
const ALLOWED_TOP_LEVEL = new Set([
  "manifest.json",
  "background.js",
  "content-scripts",
  "popup",
  "images"
]);
const FORBIDDEN_PATTERNS = [
  "__redditScrollLimiter",
  "console.log",
  "debugger",
  "rsl-test-feed",
  "Test Reddit post",
  "artifacts/",
  "artifacts\\"
];

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  validateDistShape();
  validateManifestPolicy();
  validatePrivacyDoc();
  validateNoReleaseResidue();
  validateIcons();
  await validateDefaultInstallState();
  runPackagedLiveTest();

  console.log(JSON.stringify({
    ok: true,
    dist: DIST_ROOT,
    checks: [
      "dist contains only store-loadable extension assets",
      "manifest permissions and content script hosts are constrained",
      "privacy policy exists and matches local-only storage behavior",
      "packaged JavaScript has no debug/test residue",
      "icons exist and match manifest dimensions",
      "default install state is restored when storage is empty",
      "packaged dist passes live Reddit validation"
    ],
    notes: [
      "Placeholder icons are still development assets; replace them before store submission unless explicitly approved."
    ]
  }, null, 2));
}

function validateDistShape() {
  assert(fs.existsSync(DIST_ROOT), "dist/ does not exist. Run npm run build:dist first.");

  const topLevel = fs.readdirSync(DIST_ROOT);
  for (const item of topLevel) {
    assert(ALLOWED_TOP_LEVEL.has(item), `Unexpected top-level release item in dist/: ${item}`);
  }

  for (const item of ALLOWED_TOP_LEVEL) {
    assert(fs.existsSync(path.join(DIST_ROOT, item)), `Missing required release item in dist/: ${item}`);
  }

  const forbidden = [
    "scripts",
    "artifacts",
    "TESTING.md",
    "PRIVACY.md",
    "package.json",
    "chromium-reddit-scroll-limiter-guide.md"
  ];

  for (const item of forbidden) {
    assert(!fs.existsSync(path.join(DIST_ROOT, item)), `Forbidden release item found in dist/: ${item}`);
  }
}

function validateManifestPolicy() {
  const manifest = readJson(path.join(DIST_ROOT, "manifest.json"));

  assert(manifest.manifest_version === 3, "Manifest must use MV3.");
  assert(JSON.stringify(manifest.permissions || []) === JSON.stringify(["storage"]), "Manifest permissions must be exactly ['storage'].");
  assert(!manifest.host_permissions, "Manifest should not use host_permissions for this MVP.");
  assert(manifest.background?.service_worker === "background.js", "Manifest must reference background.js service worker.");

  const scripts = manifest.content_scripts || [];
  assert(scripts.length === 1, "Expected exactly one content_scripts entry.");
  const matches = scripts[0].matches || [];
  const expectedMatches = [
    "https://reddit.com/*",
    "https://www.reddit.com/*",
    "https://old.reddit.com/*",
    "https://new.reddit.com/*",
    "https://sh.reddit.com/*"
  ];
  assert(JSON.stringify(matches) === JSON.stringify(expectedMatches), "Unexpected content script match list.");

  const manifestText = fs.readFileSync(path.join(DIST_ROOT, "manifest.json"), "utf8");
  assert(!/https?:\/\/(?!reddit\.com|www\.reddit\.com|old\.reddit\.com|new\.reddit\.com|sh\.reddit\.com)/.test(manifestText), "Manifest contains unexpected remote URL.");
}

function validatePrivacyDoc() {
  const privacyPath = path.join(PROJECT_ROOT, "PRIVACY.md");
  assert(fs.existsSync(privacyPath), "PRIVACY.md is missing.");
  const text = fs.readFileSync(privacyPath, "utf8");
  assert(text.includes("chrome.storage.sync"), "PRIVACY.md must mention chrome.storage.sync.");
  assert(/does not collect|does not transmit/i.test(text), "PRIVACY.md must state no data collection/transmission.");
}

function validateNoReleaseResidue() {
  for (const file of listFiles(DIST_ROOT)) {
    const relative = path.relative(DIST_ROOT, file);
    if (!/\.(js|json|html|css)$/i.test(file)) {
      continue;
    }

    const text = fs.readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert(!text.includes(pattern), `Forbidden release residue "${pattern}" found in ${relative}.`);
    }

    if (/\b(src|href)=["']https?:\/\//i.test(text)) {
      throw new Error(`Remote script/style URL found in ${relative}.`);
    }
  }
}

function validateIcons() {
  const manifest = readJson(path.join(DIST_ROOT, "manifest.json"));
  const iconRefs = new Map();

  for (const [size, file] of Object.entries(manifest.icons || {})) {
    iconRefs.set(Number(size), file);
  }

  for (const [size, file] of Object.entries(manifest.action?.default_icon || {})) {
    iconRefs.set(Number(size), file);
  }

  for (const size of [16, 48, 128]) {
    const file = iconRefs.get(size);
    assert(file, `Manifest is missing ${size}px icon reference.`);
    const iconPath = path.join(DIST_ROOT, file);
    assert(fs.existsSync(iconPath), `Icon file does not exist: ${file}`);
    const dimensions = readPngDimensions(iconPath);
    assert(dimensions.width === size && dimensions.height === size, `Icon ${file} is ${dimensions.width}x${dimensions.height}, expected ${size}x${size}.`);
  }
}

async function validateDefaultInstallState() {
  const browserPath = resolveBrowserPath();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-release-defaults-"));
  const browser = launchBrowser(browserPath, profileDir, DIST_ROOT);

  try {
    await waitForJson(`http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/version`, START_TIMEOUT_MS);
    const worker = await waitForExtensionWorker();
    const extensionId = extractExtensionId(worker.url);
    const setupPage = await newPage(`chrome-extension://${extensionId}/popup/popup.html`);
    await setupPage.send("Runtime.enable");
    try {
      await setupPage.waitFor("Page.loadEventFired", 10000);
    } catch {
      await sleep(1000);
    }
    await setupPage.evaluate(`new Promise((resolve) => chrome.storage.sync.clear(resolve))`);
    setupPage.close();

    const page = await newPage(`chrome-extension://${extensionId}/popup/popup.html`);

    await page.send("Runtime.enable");
    try {
      await page.waitFor("Page.loadEventFired", 10000);
    } catch {
      await sleep(1000);
    }
    await sleep(1200);

    const defaults = await page.evaluate(`(() => ({
      postLimit: document.getElementById("postLimit")?.value,
      slider: document.getElementById("postLimitSlider")?.value,
      display: document.getElementById("valueDisplay")?.textContent,
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
      snoozeMinutes: document.getElementById("snoozeMinutes")?.value,
      snoozeLimitPerSession: document.getElementById("snoozeLimitPerSession")?.value
    }))()`);
    page.close();

    assert(defaults.postLimit === "100", `Default postLimit should be 100, got ${defaults.postLimit}.`);
    assert(defaults.slider === "100", `Default slider should be 100, got ${defaults.slider}.`);
    assert(defaults.display === "100", `Default display should be 100, got ${defaults.display}.`);
    assert(defaults.enabled === true, "Default enabled state should be true.");
    assert(defaults.lockoutMinutes === "30", `Default lockoutMinutes should be 30, got ${defaults.lockoutMinutes}.`);
    assert(defaults.resetAfterMinutes === "30", `Default resetAfterMinutes should be 30, got ${defaults.resetAfterMinutes}.`);
    assert(defaults.limitMode === "posts", `Default limitMode should be posts, got ${defaults.limitMode}.`);
    assert(defaults.timeLimitMinutes === "30", `Default timeLimitMinutes should be 30, got ${defaults.timeLimitMinutes}.`);
    assert(defaults.pauseTimerWhenTabHidden === true, "Default pauseTimerWhenTabHidden state should be true.");
    assert(defaults.subredditMode === "all", `Default subredditMode should be all, got ${defaults.subredditMode}.`);
    assert(defaults.warningEnabled === true, "Default warningEnabled state should be true.");
    assert(defaults.warningThresholdPercent === "80", `Default warningThresholdPercent should be 80, got ${defaults.warningThresholdPercent}.`);
    assert(defaults.snoozeEnabled === true, "Default snoozeEnabled should be true.");
    assert(defaults.snoozeMinutes === "5", `Default snoozeMinutes should be 5, got ${defaults.snoozeMinutes}.`);
    assert(defaults.snoozeLimitPerSession === "1", `Default snoozeLimitPerSession should be 1, got ${defaults.snoozeLimitPerSession}.`);
  } finally {
    browser.kill();
    await sleep(1000);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }
}

function runPackagedLiveTest() {
  const env = {
    ...process.env,
    RSL_EXTENSION_ROOT: DIST_ROOT,
    RSL_ARTIFACTS_DIR: ARTIFACTS_DIR
  };
  delete env.RSL_DEBUG_PORT;

  const result = spawnSync(process.execPath, [path.join(PROJECT_ROOT, "scripts", "live-reddit-test.js")], {
    cwd: PROJECT_ROOT,
    env,
    encoding: "utf8",
    timeout: 180000
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  assert(result.status === 0, `Packaged live Reddit validation failed with exit code ${result.status}.`);
}

function resolveBrowserPath() {
  if (process.env.RSL_BROWSER_PATH) {
    assert(fs.existsSync(process.env.RSL_BROWSER_PATH), `RSL_BROWSER_PATH does not exist: ${process.env.RSL_BROWSER_PATH}`);
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
  assert(found, "No automation-friendly Chromium browser found.");
  return found;
}

function launchBrowser(browserPath, profileDir, extensionRoot) {
  return spawn(browserPath, [
    `--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`,
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionRoot.replace(/\\/g, "/")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--window-size=1200,900",
    "about:blank"
  ], { stdio: "ignore" });
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

  throw new Error("The packaged extension service worker did not load.");
}

async function newPage(url) {
  const endpoint = `http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { method: "PUT" });
  assert(response.ok, `Failed to create target for ${url}: ${response.status} ${response.statusText}`);
  const target = await response.json();
  return connect(target.webSocketDebuggerUrl);
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

function listFiles(root) {
  const results = [];

  for (const item of fs.readdirSync(root)) {
    const file = path.join(root, item);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      results.push(...listFiles(file));
    } else {
      results.push(file);
    }
  }

  return results;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readPngDimensions(file) {
  const buffer = fs.readFileSync(file);
  assert(buffer.toString("ascii", 1, 4) === "PNG", `Not a PNG file: ${file}`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
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
