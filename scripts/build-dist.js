const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");
const INCLUDE = [
  "manifest.json",
  "background.js",
  "content-scripts",
  "popup",
  "images"
];

assertInsideProject(DIST_ROOT);
fs.rmSync(DIST_ROOT, { recursive: true, force: true });
fs.mkdirSync(DIST_ROOT, { recursive: true });

for (const item of INCLUDE) {
  const from = path.join(PROJECT_ROOT, item);
  const to = path.join(DIST_ROOT, item);

  if (!fs.existsSync(from)) {
    throw new Error(`Missing release asset: ${item}`);
  }

  copyRecursive(from, to);
}

console.log(JSON.stringify({
  ok: true,
  dist: DIST_ROOT,
  included: INCLUDE
}, null, 2));

function copyRecursive(from, to) {
  const stat = fs.statSync(from);

  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const child of fs.readdirSync(from)) {
      copyRecursive(path.join(from, child), path.join(to, child));
    }
    return;
  }

  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function assertInsideProject(target) {
  const relative = path.relative(PROJECT_ROOT, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside project: ${target}`);
  }
}
