# PipelineSync on every device — web, iPhone, Android, Windows, macOS

One React codebase ships as **five installable apps**. There is no second
codebase to maintain: the native shells are thin wrappers around the same
production web bundle (`dist/`).

| Target | Technology | What the user gets | Built by |
|---|---|---|---|
| Web (any browser) | Vite + React | the site, responsive, mobile-first | `npm run build` → Netlify |
| Installable PWA — iPhone / iPad | Safari “Add to Home Screen” | home-screen icon, full-screen, offline shell | same web build |
| Installable PWA — Android / desktop Chrome·Edge | `beforeinstallprompt` | app icon + own window, offline shell | same web build |
| Native iPhone / iPad app | **Capacitor 8** (`ios/`) | App Store / TestFlight `.ipa` | `mobile.yml` or Xcode |
| Native Android app | **Capacitor 8** (`android/`) | Play Store `.aab` / side-load `.apk` | `mobile.yml` or Android Studio |
| Desktop Windows / macOS / Linux | **Tauri 2** (`src-tauri/`) | `.msi`/`.exe`, `.dmg`/`.app`, AppImage/deb | `desktop.yml` or `npm run apps:desktop:build` |

Everything below assumes you are at the repository root.

```bash
npm install          # once
npm run dev          # web dev server on :5173
```

---

## 1. Web + PWA (no toolchain needed — works today)

Deploy the site as usual (`netlify.toml` is already configured). The build
emits a **web manifest**, a **service worker** and precached assets, so:

* **iPhone / iPad** — open the site in Safari → **Share** → **Add to Home
  Screen** → *Add*. PipelineSync gets its own icon (the navy mark), launches
  full-screen with no Safari chrome, keeps the last session, and its shell
  works offline.
* **Android** — Chrome shows the install prompt automatically; or
  **⋮ menu → Install app**.
* **Windows / macOS / Linux** — Chrome/Edge show an install icon in the
  address bar (**Menu → Install PipelineSync…**). The app then opens in its
  own window with a task-bar / Dock icon.
* Inside the app, **Settings → “Get the app”** detects the current platform
  and either triggers the install prompt or shows the exact steps for that
  OS.

Offline behaviour: the app shell, pages and fonts are precached, so an
installed app opens and renders with no network. Live data (Supabase) is
deliberately **never** cached — responses are scoped per signed-in user by
Row Level Security, and a URL-keyed cache could leak one account’s data to
another on a shared device. Without Supabase configured, the app runs in its
on-device demo mode, which is fully offline.

### Testing the PWA locally

```bash
npm run build
npm run preview          # serves dist/ on :4173 with the service worker active
```

Open the preview over HTTPS (or localhost), then use the browser’s
*Install app* / *Add to Home Screen*. The service worker is **disabled in
`npm run dev`** on purpose so hot-reload stays predictable.

---

## 2. Native iPhone / Android apps (Capacitor)

The `ios/` and `android/` projects are **committed** so CI can sign and ship
them without regenerating anything.

### Day-to-day workflow

```bash
npm run build             # 1. build dist/
npx cap sync              # 2. copy dist/ + plugins into ios/ and android/
npm run apps:ios:open     # 3a. Xcode      (macOS only)
npm run apps:android:open # 3b. Android Studio
```

Or run straight onto a connected device / simulator:

```bash
npm run apps:ios:run
npm run apps:android:run
```

Behaviour inside the native shells (handled automatically by
`src/lib/platform.ts` + `src/lib/native.ts`):

* **Hash routing** — native webviews resolve `/entries` to a file that does
  not exist in the bundle, so the app switches to `HashRouter` there. The
  hosted web app keeps clean `BrowserRouter` URLs.
* **No service worker** — stores already deliver updates; a SW would serve a
  stale build after an app-store update.
* Navy **status bar** with light content, WebView painted under the notch,
  layout padded with `env(safe-area-inset-*)`.
* Android **hardware back** = router back; on the root screen it minimises.
* Soft keyboard **resizes** the WebView instead of covering inputs.
* Navy **splash screen** that React dismisses once mounted.

### 2a. Android build (any OS)

Debug APK, no signing needed:

```bash
npm run apps:android:apk        # → android/app/build/outputs/apk/debug/app-debug.apk
```

Signed release for the Play Store:

```bash
# 1. one-time keystore (keep the password somewhere safe — Play needs it forever)
keytool -genkey -v -keystore android/release.keystore -alias pipelinesync \
  -keyalg RSA -keysize 2048 -validity 10000

# 2. android/key.properties  (git-ignored)
cat > android/key.properties <<EOF
storeFile=../release.keystore
storePassword=YOUR_STORE_PASSWORD
keyAlias=pipelinesync
keyPassword=YOUR_KEY_PASSWORD
EOF

# 3. build the upload bundle
npm run apps:android:aab        # → android/app/build/outputs/bundle/release/app-release.aab
```

`android/app/build.gradle` picks up `key.properties` automatically when it
exists and signs the release build; without it the release stays unsigned.
Upload the `.aab` in **Play Console → Production testing**, with:

* Package name: `com.pipelinesync.worktracker`
* App signing: let Google manage the key (recommended).

### 2b. iPhone build (requires macOS + Xcode + Apple Developer account)

```bash
npm run apps:ios:open
```

In Xcode:

1. Select the **App** target → *Signing & Capabilities* → choose your
   **Team** (Apple Developer account, $99/yr) and a bundle id
   (`com.pipelinesync.worktracker` or your own).
2. First run on a device: *Product → Destination* → your iPhone, then
   **Run** (the device must trust your developer certificate).
3. Release: *Product → Archive* → **Distribute App** → App Store Connect →
   upload. Then add the build to TestFlight / a release in App Store Connect.

Command-line equivalent (used by CI):

```bash
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -archivePath build/App.xcarchive archive
xcodebuild -exportArchive -archivePath build/App.xcarchive \
  -exportPath build/ipa -exportOptionsPlist ExportOptions.plist
```

---

## 3. Desktop apps (Tauri 2) — Windows, macOS, Linux

Tauri wraps `dist/` in the OS webview (WebView2 on Windows, WKWebView on
macOS), producing genuinely small installers (~5–10 MB).

### Local build (on the OS you are shipping to)

Prerequisites: Node 22, Rust stable.
Windows: *Microsoft C++ Build Tools* + *WebView2* (preinstalled on Win 10/11).
macOS: Xcode Command Line Tools. Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev
librsvg2-dev libsoup-3.0-dev libayatana-appindicator3-dev`.

```bash
npm run apps:desktop:dev      # hot-reload desktop window against vite dev
npm run apps:desktop:build    # release installers
```

Outputs land in `src-tauri/target/release/bundle/`:

| OS | Artifacts |
|---|---|
| Windows | `msi/PipelineSync Work Tracker_1.0.0_x64.msi`, `nsis/...-setup.exe` |
| macOS | `dmg/PipelineSync Work Tracker_1.0.0_aarch64.dmg` (+ `macos/*.app.tar.gz`) |
| Linux | `appimage/*.AppImage`, `deb/*.deb` |

Distribute the macOS `.dmg` outside the App Store? Sign + notarise it (see
the secrets table below) or users get a Gatekeeper warning.

The desktop window is a single instance: launching a second copy focuses the
running window instead of opening another one
(`tauri-plugin-single-instance`).

---

## 4. CI — signed builds without a build machine

Three workflows ship everything on GitHub-hosted runners:

| Workflow | Trigger | Produces |
|---|---|---|
| `.github/workflows/web.yml` | push to `main`, PRs, manual | `web-dist` artifact; optional Netlify deploy |
| `.github/workflows/mobile.yml` | tag `v*`, manual | Android `.apk`/`.aab`; iOS `.xcarchive` (+ `.ipa` when signing secrets exist) |
| `.github/workflows/desktop.yml` | tag `v*`, manual | draft GitHub Release with `.msi` `.exe` `.dmg` `.app.tar.gz` `.AppImage` `.deb` |

Release flow:

```bash
git tag v1.1.0 && git push origin v1.1.0
# → mobile + desktop workflows run; open GitHub → Releases → publish the draft
```

### Repository secrets / variables

| Name | Used by | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | all | bake the real backend into every shell; omit for demo-mode builds |
| `NETLIFY_AUTH_TOKEN` (secret) + `NETLIFY_SITE_ID` (variable) | web | optional direct deploy from CI |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | mobile | signed `.aab`/`.apk` in CI (`base64 -i release.keystore`) |
| `IOS_CERTIFICATE_P12_BASE64`, `IOS_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `IOS_PROVISIONING_PROFILE_NAME`, `IOS_DEVELOPMENT_TEAM` | mobile | signed `.ipa` export in CI |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | desktop | sign + notarise the macOS `.dmg`/`.app` |

Without any of the signing secrets the workflows still produce **unsigned**
artifacts (debug APK, unsigned archive, unsigned installers) so every push is
testable end-to-end.

---

## 5. Branding & icons

All icons and splash screens derive from three sources in `assets/`:

```
assets/icon-only.png        1024×1024 opaque app icon  (Core Navy, reversed mark)
assets/icon-foreground.png  1024×1024 transparent mark (Android adaptive layer)
assets/splash.png           2732×2732 launch screen
```

Regenerate every platform’s icon set after changing them:

```bash
npm run apps:icons
# = tauri icon (desktop .ico/.icns/StoreLogo…) + scripts/apps/generate-native-assets.sh (iOS/Android)
```

The script re-renders each placeholder at the exact size the native projects
expect, so it survives Capacitor upgrades. Tauri’s desktop icons are already
committed under `src-tauri/icons/`; PWA icons live in `public/pwa/`.

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Installed PWA shows an old version | The SW auto-updates on navigation; close all tabs/windows and reopen, or bump the deploy. |
| iPhone “Add to Home Screen” missing | iOS requires **Safari** (not an in-app browser) and a served `manifest.webmanifest` over HTTPS. |
| Native app shows demo data | `VITE_SUPABASE_*` were not set **at build time**; rebuild with them (`npm run build` then `npx cap sync`). |
| Blank screen after deep-linking in a native build | Should not happen (hash routing). If you see it, you are viewing the *web* build inside a WebView that blocks history — check `isNativeShell()` in `src/lib/platform.ts`. |
| Android build fails on `key.properties` | The file references a keystore path that does not exist; delete both to go back to unsigned builds. |
| macOS says the app is damaged / unverified | The `.dmg` is unsigned. Sign + notarise via the `APPLE_*` secrets, or right-click → Open for ad-hoc testing. |
| Windows installer warns “unknown publisher” | Code-sign the `.msi`/`.exe` with an EV/OV certificate (set `tauri.conf.json → bundle.windows.certificateThumbprint` or sign post-build with `signtool`). |
| `xcodebuild` can’t find scheme `App` | Run `npx cap sync ios` once so `CapApp-SPM` resolves, then reopen Xcode. |
