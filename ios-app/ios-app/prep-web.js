// Copies the actual web app (which lives at the repo root, where GitHub
// Pages also serves it from) into this wrapper's www/ folder, which is what
// Capacitor's webDir points at. Kept as an explicit copy step rather than
// pointing webDir straight at the repo root, so Capacitor never tries to
// recurse into this ios-app/ folder itself while syncing.
//
// IMPORTANT: this app is entirely client-side and calls Open-Meteo directly
// from the device, so no server changes are needed for the iOS build - the
// exact same app.js/index.html/style.css that run on the web run inside the
// native wrapper unmodified.
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const WWW_DIR = path.join(__dirname, "www");
const FILES_TO_COPY = ["index.html", "app.js", "style.css", "suncalc-lite.js", "manifest.json"];
const DIRS_TO_COPY = ["assets"];
// sw.js (the service worker) is intentionally left out - it registers itself
// only when `location.protocol !== "file:"`, and Capacitor serves the app
// from a "capacitor://" scheme, not http(s), so the service worker would
// never activate anyway; the app already treats that as a no-op, not an error.

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(WWW_DIR, { recursive: true, force: true });
fs.mkdirSync(WWW_DIR, { recursive: true });

for (const file of FILES_TO_COPY) {
  const src = path.join(REPO_ROOT, file);
  if (!fs.existsSync(src)) {
    console.warn(`prep-web: expected file not found, skipping: ${file}`);
    continue;
  }
  copyRecursive(src, path.join(WWW_DIR, file));
}
for (const dir of DIRS_TO_COPY) {
  const src = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(src)) {
    console.warn(`prep-web: expected directory not found, skipping: ${dir}`);
    continue;
  }
  copyRecursive(src, path.join(WWW_DIR, dir));
}

console.log(`prep-web: copied web app into ${WWW_DIR}`);
