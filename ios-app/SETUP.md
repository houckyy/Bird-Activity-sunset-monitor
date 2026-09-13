# Publishing Raylight to the App Store without owning a Mac

This folder wraps the web app in a native iOS shell (via Capacitor) and
builds/signs/uploads it entirely on GitHub's cloud Mac runners. You never
need to own a Mac. You do need an Apple Developer Program account, because
that is Apple's requirement, not a technical limitation of this pipeline.

Do these steps in order. Steps 1-4 are one-time setup. Step 5 is the one
step that benefits from real Mac/Xcode access, and you only ever do it
once. Everything after that is fully automated.

## 1. Enroll in the Apple Developer Program

- Go to https://developer.apple.com/programs/enroll/ and enroll (individual
  or organization). Costs $99/year, renews annually.
- This is a web form. No Mac needed for enrollment itself.
- Approval can take anywhere from a few hours to a few days.

## 2. Register your App ID (bundle identifier)

- In the Apple Developer portal: Certificates, Identifiers & Profiles ->
  Identifiers -> the "+" button -> App IDs -> App.
- Bundle ID must be unique across all of the App Store. This project uses
  the placeholder `com.raylight.birdmonitor` in `capacitor.config.json` and
  `fastlane/Appfile`. Either register that exact string, or pick your own
  and update both files to match.
- Also create the app record itself in App Store Connect
  (https://appstoreconnect.apple.com) -> Apps -> "+" -> New App, using the
  same bundle ID.
- Note your Team ID while you're in the Developer portal: Membership ->
  Team ID. You'll need it for a secret below.

## 3. Generate an App Store Connect API key

This lets the CI pipeline authenticate to Apple without ever typing your
Apple ID password or handling a 2FA prompt in an automated job.

- App Store Connect -> Users and Access -> Integrations -> App Store
  Connect API -> "+" to generate a new key.
- Give it the "App Manager" role (or higher).
- Note the Key ID and Issuer ID shown on that page.
- Download the `.p8` private key file **immediately** - Apple only lets
  you download it once, ever. If you lose it, you have to revoke it and
  generate a new one.
- Base64-encode the `.p8` file's contents (this is what goes into the
  `ASC_PRIVATE_KEY` secret below, since GitHub secrets are plain text
  fields and the raw key has newlines):
  - Mac/Linux: `base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d '\n'`
  - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXXXXXXXX.p8"))`
  - Or just paste the file into any online base64 encoder if you'd rather
    not use a terminal for this. Copy the output, no line breaks.

## 4. Create a private certificates repo for fastlane match

fastlane's `match` tool stores your signing certificate and provisioning
profile encrypted in a separate git repo, so CI can fetch them without a
human clicking through Xcode's signing UI.

- On GitHub, create a new **empty, private** repository, e.g.
  `raylight-ios-certificates`. Do not put any code in it - match manages
  its contents entirely.
- Note its URL (e.g. `https://github.com/yourname/raylight-ios-certificates.git`).
  This goes into the `MATCH_GIT_URL` secret below.
- Pick a strong password to encrypt the contents of that repo. This goes
  into the `MATCH_PASSWORD` secret below. Store it somewhere safe (a
  password manager) - you'll need it again if you ever run `match` by hand.

## 5. Run `fastlane match appstore` once, from any machine with Xcode

This is the one genuinely interactive step, and you only ever do it once
per app (or again later if a certificate expires, which is roughly once a
year). Options, roughly cheapest/easiest first:

- Borrow a friend's Mac, or a campus computer lab Mac, for 15 minutes.
- Rent one by the hour: MacinCloud or MacStadium both offer short-term
  cloud Mac rentals for exactly this kind of one-off task.
- If you truly cannot get any Mac access even temporarily, fastlane match
  also supports a non-interactive "readonly: false" bootstrap from CI using
  the App Store Connect API key alone - see
  https://docs.fastlane.tools/actions/match/ for that path. It's more
  fiddly to set up correctly, which is why the default here assumes the
  one-time-Mac route.

On that machine, with Xcode installed:

```
gem install fastlane
cd ios-app
export MATCH_GIT_URL="https://github.com/yourname/raylight-ios-certificates.git"
export MATCH_PASSWORD="the password you picked above"
fastlane match appstore
```

This generates and stores the certificate and provisioning profile in your
certificates repo. From then on, every GitHub Actions run just reads them
(the pipeline's `match` calls all use `readonly: true` - CI never generates
new certificates on its own, which avoids Apple's per-account certificate
limits getting eaten by every CI run).

## 6. Set the GitHub Actions repository secrets

In your GitHub repo: Settings -> Secrets and variables -> Actions -> New
repository secret. Add each of these:

| Secret | Value |
|---|---|
| `APP_BUNDLE_ID` | Your bundle ID, e.g. `com.raylight.birdmonitor` |
| `APPLE_ID_EMAIL` | The email of the Apple ID that owns the Developer account |
| `APPLE_TEAM_ID` | Team ID from Developer portal -> Membership |
| `APP_STORE_CONNECT_TEAM_ID` | Usually the same as above; only differs if your Apple ID belongs to multiple App Store Connect teams |
| `ASC_KEY_ID` | Key ID from step 3 |
| `ASC_ISSUER_ID` | Issuer ID from step 3 |
| `ASC_PRIVATE_KEY` | The base64-encoded `.p8` contents from step 3 |
| `MATCH_GIT_URL` | The certificates repo URL from step 4 |
| `MATCH_PASSWORD` | The password from step 4 |

## 7. Run the pipeline

- Go to your repo's Actions tab -> "iOS Build & Release" -> "Run workflow"
  -> pick your main branch -> Run.
- First run: this generates the native `ios/` project folder via Capacitor
  and commits it back to your repo (that's why the workflow needs
  `contents: write` permission). Every later run reuses that same folder
  instead of regenerating it.
- The workflow then signs, builds, and uploads a build to TestFlight.
- After the run finishes, check App Store Connect -> TestFlight. Apple
  takes some time (minutes to a few hours) to finish processing a new
  build before it's installable.
- Once you've tested a build via TestFlight and are ready for a public
  release, use the "Submit for Review" flow inside App Store Connect
  itself (that part is a manual App Store Connect step regardless of how
  the build was produced - it involves screenshots, description,
  age rating, etc., which this pipeline intentionally doesn't automate).

You can also trigger a run by pushing a tag matching `ios-v*` (e.g.
`git tag ios-v1.0.0 && git push origin ios-v1.0.0`), but the very first run
must be a manual "Run workflow" dispatch on a branch, since a tag checkout
has no branch to commit the generated `ios/` folder back to.

## Important: this pipeline has not been run end-to-end

Every fact this pipeline is built on was individually verified before
writing it: Capacitor's current published version, GitHub's current macOS
runner image and the Xcode version it ships, and the fastlane API surface
used here all came from live documentation/registry lookups, not
assumptions. Two real bugs were caught and fixed during review (a
`[skip ci]` commit flag that would have silently skipped unrelated
workflows in this repo, and a tag-push detached-HEAD state that would have
broken the git push step).

What it has **not** had is a live end-to-end run. This sandbox has no
macOS, no Xcode, no Apple Developer account, and its network access to the
npm registry is blocked, so `npx cap add ios`, the actual Xcode build, and
the App Store Connect upload could not be executed and confirmed here the
way the Scriptable widget's math was (that one was verified by direct code
execution and comparison). Treat this as a carefully-written first draft:
work through steps 1-7 for real, and expect to debug one or two small
issues on the first real run - most likely something version-specific in
CocoaPods or the generated Xcode project, which are exactly the kind of
thing that only surfaces on a real runner.
