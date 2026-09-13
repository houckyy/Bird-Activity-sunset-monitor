// `npx cap add android` generates android/app/build.gradle with no release
// signing configured at all (a debug-signed build can't be uploaded to Play
// Console). Rather than hand-edit that generated file and hope nobody
// regenerates over it, this script patches it once, idempotently, right
// after generation, and its result gets committed back to the repo the same
// way the rest of the native project does - so this only ever actually
// changes anything on the very first run.
//
// Fails loudly and does nothing silent: if the generated file doesn't look
// the way this script expects (Capacitor's Android template changed), it
// throws with a clear message instead of writing something broken, since a
// mangled build.gradle is a much worse debugging session than a failed CI
// step with a clear reason.
const fs = require("fs");
const path = require("path");

const GRADLE_PATH = path.join(__dirname, "android", "app", "build.gradle");
const MARKER = "// RAYLIGHT_SIGNING_PATCH";

if (!fs.existsSync(GRADLE_PATH)) {
  throw new Error(`patch-build-gradle: ${GRADLE_PATH} not found - run "npx cap add android" first.`);
}

let gradle = fs.readFileSync(GRADLE_PATH, "utf8");

if (gradle.includes(MARKER)) {
  console.log("patch-build-gradle: already patched, nothing to do.");
  process.exit(0);
}

// 1. Load keystore.properties (written by CI from secrets, .gitignored,
//    never committed) right after the existing apply-plugin lines.
const loaderBlock = `${MARKER}
def keystorePropertiesFile = rootProject.file("keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}
`;

const applyPluginAnchor = /apply plugin: ['"]com\.android\.application['"]\s*\n/;
if (!applyPluginAnchor.test(gradle)) {
  throw new Error("patch-build-gradle: could not find \"apply plugin: 'com.android.application'\" line - Capacitor's Android template may have changed. Patch android/app/build.gradle by hand (see SETUP-ANDROID.md).");
}
gradle = gradle.replace(applyPluginAnchor, (m) => m + loaderBlock);

// 2. Add a release signingConfig, reading from keystore.properties if
//    present - build stays debug-signed (and buildable) with it absent, so
//    local/manual builds without secrets don't break.
const signingConfigBlock = `    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                storeFile file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
            }
        }
    }
`;
const androidBlockAnchor = /android\s*\{\n/;
if (!androidBlockAnchor.test(gradle)) {
  throw new Error("patch-build-gradle: could not find the top-level \"android {\" block - patch by hand (see SETUP-ANDROID.md).");
}
gradle = gradle.replace(androidBlockAnchor, (m) => m + signingConfigBlock);

// 3. Point the release build type at that signing config, and let the
//    version code come from CI (GitHub Actions run number) so every Play
//    Console upload gets a strictly increasing versionCode automatically,
//    while local builds without the env var still default sanely to 1.
gradle = gradle.replace(
  /versionCode\s+\d+/,
  'versionCode (System.getenv("ANDROID_VERSION_CODE") ?: "1").toInteger()'
);

const releaseTypeAnchor = /release\s*\{\n(\s*)minifyEnabled/;
if (!releaseTypeAnchor.test(gradle)) {
  throw new Error("patch-build-gradle: could not find the \"release { minifyEnabled ... }\" build type - patch by hand (see SETUP-ANDROID.md) to add \"signingConfig signingConfigs.release\".");
}
gradle = gradle.replace(releaseTypeAnchor, (m, indent) => {
  return m.replace("minifyEnabled", `signingConfig signingConfigs.release\n${indent}minifyEnabled`);
});

fs.writeFileSync(GRADLE_PATH, gradle, "utf8");
console.log("patch-build-gradle: signing config added to android/app/build.gradle.");
