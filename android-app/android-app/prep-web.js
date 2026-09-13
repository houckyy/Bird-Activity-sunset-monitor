// Same idea as ios-app/prep-web.js: copies the real web app from the repo
// root into this wrapper's www/ folder, which is what Capacitor's webDir
// points at. Kept as an explicit copy rather than pointing webDir straight
// at the repo root so Capacitor never recurses into android-app/ itself.
//
// This app is entirely client-side and calls Open-Meteo directly from the
// device, so nothing here needs to change for the Android build - the exact
// same app.js/index.html/style.css that run on the web run inside the
// native wrapper unmodified.
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const WWW_DIR = path.join(__dirname, "www");
const FILES_TO_COPY = ["index.html", "app.js", "style.css", "suncalc-lite.js", "manifest.json"];
const DIRS_TO_COPY = ["assets"];
// sw.js is left out on purpose - Capacitor serves the app from an
// "https://localhost" scheme on Android (not a real network origin), and the
// service worker's own `location.protocol !== "file:"` guard is really
// there to distinguish "served over the web" from "opened as a raw file",
// which doesn't map cleanly onto Capacitor's scheme; the app already
// treats a missing/inactive service worker as a no-op, not an error.

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
