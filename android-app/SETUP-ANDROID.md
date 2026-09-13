# Publishing Raylight to Google Play

This is the easier of the two stores to automate: Android's whole toolchain
(Gradle, the Android SDK, a JDK) runs on a plain Linux machine, so this
entire pipeline uses a standard `ubuntu-latest` GitHub Actions runner - no
Mac, no rented cloud machine, ever, at any point. The real bottleneck here
isn't tooling, it's Google's mandatory testing window - read step 4 before
you assume this ships today.

## 1. Create a Google Play Developer account

- Go to https://play.google.com/console/signup and pay the one-time $25 fee
  (no renewal, unlike Apple's $99/year).
- You'll need to verify your identity with a government-issued photo ID.
  Budget a few hours to two business days for this to clear.

## 2. Generate a signing keystore

This is the Android equivalent of the iOS signing certificate, and unlike
iOS it needs no special machine - any computer with a JDK installed (which
is most dev machines, and definitely this GitHub Actions runner) can
generate one:

```
keytool -genkeypair -v -keystore raylight-release.keystore -alias raylight \
  -keyalg RSA -keysize 2048 -validity 10000
```

It'll prompt for a keystore password and some identity fields (name,
org, etc. - these appear on the certificate, not in the app itself). Keep
`raylight-release.keystore` somewhere safe and back it up. **If you lose
it, you cannot update your app on Play ever again** - Google does not
recover this for you.

Base64-encode it for the GitHub secret:
- Mac/Linux: `base64 -i raylight-release.keystore | tr -d '\n'`
- Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("raylight-release.keystore"))`

## 3. Create the app listing and a Play Developer API service account

- In Play Console: Create app -> name it "Raylight", package name
  `com.raylight.birdmonitor` (matches `capacitor.config.json` - change both
  together if you want something else).
- Play Console -> Setup -> API access -> Create a new service account (this
  walks you to Google Cloud Console to create one, then links it back).
  Grant it the "Release manager" permission in Play Console so it can
  upload builds via the API.
- Download that service account's JSON key file. Paste its full raw content
  (it's plain JSON, no encoding needed) into the `PLAY_SERVICE_ACCOUNT_JSON`
  secret below.

## 4. The mandatory testing window (read this before you plan a launch date)

Google requires personal developer accounts created after November 2023 to
run a **closed test with at least 12 testers for 14 consecutive days**
before the app can go to production, followed by a short review. Realistic
timeline from account creation to a public listing: **two to four weeks**,
not same-day. Plan your $1.99/$2.99 launch date around this - there's no
way to skip it.

Practical path: recruit 12 people (classmates, other rangers, whoever will
actually install a test build) via a Play Console "closed testing" opt-in
link, have them install and open the app for those 14 days, then Google
allows a request for production access.

## 5. Set the GitHub Actions repository secrets

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64 output from step 2 |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore password you set in step 2 |
| `ANDROID_KEY_ALIAS` | `raylight` (or whatever `-alias` you used) |
| `ANDROID_KEY_PASSWORD` | Usually the same as the keystore password unless you set a separate one |
| `PLAY_SERVICE_ACCOUNT_JSON` | The full raw JSON content from step 3 |

## 6. Run the pipeline

- Repo's Actions tab -> "Android Build & Release" -> "Run workflow" -> pick
  a track (start with `internal`, the fastest to iterate on with no review
  wait) -> Run.
- First run generates the native `android/` project and commits it back to
  your repo (needs the `contents: write` permission already set in the
  workflow), same pattern as the iOS pipeline.
- Later runs reuse that project. Once you've got your 12 testers through
  the 14-day closed track, re-run with track set to `production`.
- You can also push a tag matching `android-v*` to trigger a build, but (same
  as iOS) run it manually on a branch at least once first so the native
  project has somewhere to be committed to.

## 7. Set the price

Google's Publishing API does not support setting a paid app's base price
programmatically - this one step stays manual, in Play Console under your
app -> Monetize -> Pricing. Pick $1.99 or $2.99 there; Play automatically
computes local pricing in other currencies from whichever tier you choose.
This is a plain "pay once to download" listing - no in-app purchase code
needed anywhere in the app for this.

## What's verified vs. what isn't

Capacitor's version (8.5.2) and the `r0adkll/upload-google-play` action's
version (v1.1.5) were confirmed against their live registry/releases, not
assumed. The `patch-build-gradle.js` signing patch was tested against a
realistic sample of Capacitor's generated `build.gradle` structure and
produces syntactically correct, idempotent output. What has **not** been
tested is a real `./gradlew bundleRelease` run or a real Play Console
upload - this sandbox has no Android SDK and no Google Play account to test
against. If Capacitor's Android template has changed since this was
written, `patch-build-gradle.js` is designed to fail loudly with a clear
error rather than silently write a broken file - if that happens, the error
tells you which anchor it couldn't find so you can patch the one line by
hand.
