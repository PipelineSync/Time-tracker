# Work Tracker

A modern, mobile-first web app for tracking workers' time, notes, hourly rates, and earnings.

Built with **React + TypeScript + Tailwind CSS + shadcn/ui components + Supabase** (auth & database). It runs on free-tier hosting and works **out of the box in demo mode** (no setup needed) using browser-local storage.

**One codebase, every device.** The same bundle is also an **installable PWA** (iPhone home screen, Android, desktop Chrome/Edge — offline-capable), **native iOS & Android apps** (Capacitor, in `ios/` + `android/`) and **native Windows / macOS / Linux desktop apps** (Tauri, in `src-tauri/`), with GitHub Actions workflows that build and sign all of them. See **[docs/APPS.md](docs/APPS.md)**.

---

## Features

### Roles
The app has two roles with clearly separated permissions:

| | Admin | Worker |
|---|---|---|
| Default account | `admin` / `admin.pipelinesync` | Created by the admin |
| Create worker accounts | ✅ | ❌ |
| Set / edit hourly rates | ✅ (admin-only) | ❌ (read-only) |
| Add/edit/delete workers | ✅ | ❌ |
| Manual entries & editing | ✅ | ❌ |
| Time in | ❌ (adds time manually) | ✅ |
| Break / Pause / Resume | ✅ | ✅ |
| Time out | ✅ | ✅ |
| View own time | ✅ (all) | ✅ (own only) |
| Dashboard / Reports / Settings | ✅ | ❌ |
| Notes / chat on entries | ✅ (reply) | ✅ (add notes) |
| Team chat (Chat section) | ✅ (post as Admin) | ✅ (post as themselves) |
| See all members of the chat | ✅ | ✅ (same roster, admin included) |
| Emoji & stickers in the chat | ✅ | ✅ |
| React to a chat message with emoji | ✅ | ✅ |
| Settle & reset time → payments | ✅ | ❌ |
| Payments view | ✅ (all, full control) | ✅ (own, read-only) |
| Change own password | ✅ | ✅ |
| Reset other accounts' passwords | ✅ | ❌ (own only) |

Workers **clock in, take breaks, and clock out** — their rate is set by the admin and shown read-only. **Any number of workers can be on the clock at the same time**; the admin sees all of them live, including who is currently on a break. The admin has **no start-timer**; instead the admin **adds time to workers** via manual entries (Time Entries → Manual entry, or Dashboard → Add time).

### Pages
- **Dashboard** *(admin)* — today's & this week's hours and earnings, a live **"On the clock now"** panel listing **every** worker currently clocked in (with a **Working** / **On break** badge, time worked and break time, updated every second), per-worker summary, recent entries, "Add time"
- **Workers** *(admin)* — add/edit/delete workers, create each worker's login account, set hourly rate & active/inactive status. Each worker card shows their **live clock status** (Working / On break, with elapsed time) while they are on the clock, and the **hours & earnings still to pay** — only the time that has *not* been settled yet, so both drop back to zero the moment you **Settle & reset** (what has already been settled stays visible underneath as context, and the full lifetime totals live in Time Entries and Reports). **Deleting a worker also permanently disables their login account** (the Supabase Auth user is removed server-side, and any open session of theirs is signed out) — they can no longer sign in.
- **Clock In / Out** *(worker)* — big clock-in button, then break/pause/resume and clock-out; survives a page refresh. At clock-out the worker can attach an **optional note** that is saved on the time entry (the admin's clock-out notification flags that a note was added).
- **Manual entry** *(admin)* — date, start/end time, break, project, notes, auto-calculated hours & earnings (this is how the admin adds time to workers)
- **Time Entries** — table on desktop / cards on mobile, filters (including **settled / unsettled**), sorting; admin can edit/delete/duplicate, workers see their own. Entries that a settlement paid for carry a **Settled** badge and stay here as history; the summary line also shows the **unsettled** earnings still waiting to be paid out
- **Notes / chat on entries** — every entry has a conversation thread: workers add notes, the admin replies (and vice versa), both sides are notified
- **Chat** *(admin & worker, right before Settings in the navigation)* — one shared **team room** for the whole workspace. Every message is shown with the sender's **profile picture, name and role** (the admin appears as **Admin**; a worker's role is their position, e.g. *Foreman*, falling back to *Worker*), plus a time stamp and day separators. A **See all members** button opens the roster — **the admin first, then every worker**, with each member's picture, role and whether their account is active; workers get the same roster including the admin, even though the rest of their access is limited to their own records. New messages arrive on their own (the room refreshes while the tab is open), Enter sends, Shift+Enter adds a line. The composer has an **emoji picker** for both roles — searchable, grouped, with the emoji you used recently floated to the top — and a **sticker** tab (see `src/assets/chat-stickers/`). A **sticker message is stored as plain text** (`[sticker:slug]`), so it needs no upload, no new column, and still reads as "Mike: [Side eye cat]" in a notification. Any message can be **reacted to** with emoji (the smile icon beside it): one tap adds, tapping the same emoji again takes it back, and reactions never send a notification
- **Reports** *(admin)* — today/week/month/custom range, totals & averages, charts, **CSV export**
- **Settings** *(admin)* — business name, currency, timezone, default rate, theme, export & delete all data
- **Settings → Profile** *(worker)* — workers upload their own **profile picture** from their account settings. The picture is saved to their worker profile and shows up **for the admin** next to their name on the Workers page, the Dashboard, the "On the clock now" panel, and in every **Chat** message — not just a bare name.
- **Settings → Payment methods** *(worker)* — each worker chooses how they can be paid: **Cash**, **QR Code**, or both. Enabling **QR Code** requires uploading their QR code image (a screenshot/photo of their GCash, Maya, banking-app, etc. QR — the image is automatically downscaled before saving). The methods and QR image are saved on the worker's profile.
- **Payments** — the admin turns a worker's unsettled time & earnings into a **settlement**: a **Reset & settle** action on a worker creates an **unpaid** payment for the time that has not been settled yet. **Time entries are never deleted by a settlement** — the entries it paid for are marked **Settled** (their hours, notes and comments all stay in Time Entries), so the next settlement only covers time worked since. An entry only disappears when the admin **deletes it by hand**. The admin then drives the status **unpaid → pending → paid** (with a "Back to unpaid" option) and can delete payments. When the admin clicks **Mark paid**, a dialog shows the **payment methods that worker accepts** (Cash / QR Code, with the QR image ready to scan) and the admin **picks the method they are paying with**; it is stored on the payment (`payments.payment_method`, see `supabase/payment-paid-method.sql`) and shown in the **Paid via** column of the history. The **worker** sees their own payments **read-only**, with no edit controls, and their own enabled methods and QR code at the top of the page.
- **Auth** — sign in with admin or worker credentials. Only the admin can create worker login accounts.
- **Change password** — available from the account menu (top-right) for both roles: enter your current password and a new one. Admins can also **reset a worker's password** from the Workers page. In demo mode the new password is set directly; with Supabase, a password reset link is emailed to the worker (the anon key cannot set another user's password).

### Notifications
A notification bell (with an unread badge) appears for both roles. The admin is notified when a worker **clocks in**, **starts a break**, **comes back from a break**, **clocks out**, or **adds a note**. Workers are notified when the **admin replies to a note**, **adds time** for them, creates a **payment**, or changes a **payment status**. Clicking a notification opens the related entry.

**Team chat messages notify everyone else in the room** — never the sender. A new message raises a **toast** (unless you are already in the Chat section), bumps the **bell badge**, and shows an unread count **on the Chat item** in the sidebar / bottom navigation. The notification reads *"John Smith: On site now."* (long messages are clipped) and clicking it opens the Chat section.

All entries **snapshot the hourly rate** at record time, so historical earnings don't change when a worker's rate changes later. Sessions that cross midnight are handled correctly.

### Performance (why many tabs at once don't slow it down)
The app is built so a workspace of several users on phones **and** laptops, all open at the same time, stays fast on a free Supabase plan:

- **Incremental entry sync** — every 15 s a visible tab re-fetches only the entries *changed* since its last sync (usually zero rows), not the whole history. The newest-entries window (≈1,200 for the admin, ≈300 for a worker) re-loads on refocus (at most once per 90 s) and every 5 minutes, which is also when entries deleted on another device get reconciled. Per-tab bandwidth therefore stays flat as the workspace's history grows.
- **Bounded lists** — the notification bell fetches the 20 most recent notifications (its badge is an indexed `COUNT` query, so the exact unread number is free), payments show the 100 most recent, and the team chat the 500 most recent.
- **Load older, on demand** — the Time Entries page renders 200 rows at a time with a *Show more* button, and Reports shows a *Load older entries* button when you pick a custom range that starts before the oldest loaded entry (one tap pulls in the pages the range needs).
- **Hidden tabs don't poll** — polling pauses while a tab is in the background or the device sleeps.

**No database migration is required for any of this** — the delta sync uses the existing `created_at` / `updated_at` columns, and the unread badge uses the `notifications_user_unread_idx` index that `supabase/perf-rls-and-indexes.sql` already creates. If your `time_entries` table ever grows into the tens of thousands of rows, `supabase/perf-entries-sync-indexes.sql` (optional, safe to re-run) adds two small indexes so the delta query keeps using them.

---

## Chrome extension for workers

Workers do not have to open the app to punch in. There is a **Chrome extension** in
[`extension/`](extension/README.md) that does nothing but **clock in**, **start/end a break** and
**clock out** from the toolbar — and writes straight to this same Supabase database, so the
"On the clock now" panel, the notification bell, Time Entries and Reports all update live.

- **No schema changes needed.** The RLS policies in `supabase/schema.sql` already let a signed-in
  worker insert their own `active_timers` row, update it for breaks, insert their own `time_entries`
  and notify the workspace owner. For databases created before those policies existed,
  [`supabase/chrome-extension.sql`](supabase/chrome-extension.sql) checks every requirement and
  repairs whatever is missing.
- **Worker accounts only.** Signing in with the admin account is refused — the admin adds time
  through manual entries.
- **Each install is pointed at your workspace once**, from the extension's Options page (Supabase
  Project URL + publishable key). No rebuild per workspace, and no service-role key anywhere.

Build it with `cd extension && npm install && npm run build`, then **Load unpacked** → `extension/dist`.
Setup, security notes and troubleshooting are in **[extension/README.md](extension/README.md)**.

---

## 1. Install dependencies

```bash
cd time-tracker
npm install
```

Requires Node 18+.

---

## 2. Run locally (demo mode — no backend needed)

```bash
npm run dev
```

Open `http://localhost:5173`. Without Supabase credentials the app uses **browser-local storage** as the database. A single admin is auto-created on first run.

**Demo credentials**
- Admin: `admin` / `admin.pipelinesync` — the admin workspace is auto-seeded with sample workers, entries and a short team-chat conversation on first login.
- Sample workers: `john@example.com`, `sarah@example.com`, `mike@example.com` — password `worker123`.

Log in as admin to manage workers, set rates, and create worker accounts. Log in as a sample worker to see the limited clock-in/out experience.

> Demo-mode data lives in your browser. It's perfect for evaluating the UI and role model. Use Supabase (below) for real, cross-device, production data.

---

## 3. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**. Pick a name and region.
2. Wait for the project to provision.

---

## 4. Run the database schema

In the Supabase dashboard, open **SQL Editor** → **New query**, paste the entire contents of `supabase/schema.sql`, and click **Run**.

This creates the `workers`, `time_entries`, `active_timers`, `settings`, and `payments` tables with foreign keys, indexes, **Row Level Security policies**, and triggers that auto-set `user_id` and `updated_at`.

> **Upgrading an existing database?** Run `supabase/fix-multiple-active-workers.sql` once — it makes the timer uniqueness rule *one per worker* (older databases allowed only one clocked-in worker per workspace, so the admin dashboard could only ever show a single worker) and allows the new `break_start` / `break_end` notification types.
>
> **For the team chat**, run `supabase/chat-messages.sql` once. It creates the `chat_messages` table with RLS (so the admin and every worker of the workspace read the same room), plus two SECURITY DEFINER functions: `post_chat_message()` (stamps the author's name, role and profile picture from the signed-in user, so nobody can post as somebody else) and `workspace_members()` (the "See all members" roster, which a worker cannot build from the raw tables because RLS limits them to their own rows). Fresh installs get this automatically from `schema.sql`.

> If your database predates the worker-login fix, also run `supabase/fix-deleted-worker-login.sql` once. It adds the `profiles_delete` policy and permanently removes the leftover logins of workers that were deleted before the fix (so those workers can no longer sign in).
>
> To let workers upload their **own profile picture** from their account settings, run `supabase/worker-profile-picture.sql` once. It adds a SECURITY DEFINER RPC (`update_own_avatar`) so a worker can change only the avatar on their own worker row (they still can't edit their hourly rate, status, or other admin-managed fields). Fresh installs get this automatically from `schema.sql`.
>
> For **settlements that keep time entries**, run `supabase/settle-keeps-entries.sql` once. It adds `time_entries.settled_at`, the column "Settle & reset" stamps instead of deleting the entries it paid for (without it the app still keeps the entries, but falls back to the previous payment's `period_end` as the paid-up-to boundary). Fresh installs get this automatically from `schema.sql`.
>
> For **emoji reactions on chat messages**, run `supabase/chat-reactions.sql` once (after `chat-messages.sql`). It creates `chat_reactions` — one row per (message, member, emoji), so a member can react with several emoji but never twice with the same one — with RLS so the whole workspace reads the same reactions, plus the SECURITY DEFINER functions `list_chat_reactions()` and `toggle_chat_reaction(message_id, emoji)`, which stamp the reactor from `auth.uid()` and refuse messages from another workspace. Without it the chat still loads (there is simply nothing to show); reacting explains which migration to run. Fresh installs get this automatically from `schema.sql`.

> For **chat message notifications**, run `supabase/chat-notifications.sql` once (after `chat-messages.sql`). It allows `'chat'` as a notification type and adds the SECURITY DEFINER function `notify_chat_message()`, which writes a notification for every member of the workspace except the author — something a worker cannot do directly, because RLS only lets them notify themselves and the admin. Fresh installs get this automatically from `schema.sql`.

---

## 5. Configure environment variables

1. In Supabase, go to **Settings → API**.
2. Copy the **Project URL** and **Publishable key** from Supabase **Settings → API Keys**.
3. Create a `.env` file in `time-tracker/`:

```bash
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR-SB-PUBLISHABLE-KEY
```

The app also accepts the legacy `VITE_SUPABASE_ANON_KEY` as a fallback. **Never** put a Supabase Secret/service-role key in any `VITE_*` variable or frontend source. Supabase documents publishable keys as browser-safe with RLS enabled; secret keys are backend-only and bypass RLS.

4. Restart the dev server.

---

## 6. Configure authentication & roles

1. In Supabase go to **Authentication → Providers** and confirm **Email** is enabled.
2. To allow password reset emails, configure **Authentication → URL Configuration** with your site URL and confirm the **Redirect URLs**.
3. Create the **admin account**: in Supabase **Authentication → Users → Add user → Create new user**, enter a **real email address** (for example `admin@yourcompany.com` — a bare username like `admin` is **not** valid and can never sign in), set a password, and turn on **Auto Confirm User**. Then in the SQL editor insert their profile as admin (replace the email with the one you used):
   ```sql
   insert into public.profiles (user_id, role)
   select id, 'admin' from auth.users where email = 'admin@yourcompany.com'
   on conflict (user_id) do nothing;
   ```
   > Note: the demo login `admin` / `admin.pipelinesync` only exists in **demo mode** (no Supabase). In a Supabase-connected build, only real accounts created in Supabase Auth (or by the admin in-app) can sign in.
4. Worker accounts are created **by the admin inside the app** (Workers → Add worker → set login email & password). In the deployed Netlify build, this uses a protected Netlify Function so the server-only Supabase secret is never exposed to the browser. The function verifies the signed-in user's admin profile before creating the Auth account.
5. **Forgot-password emails** use Supabase's built-in email service (rate-limited to a few per hour — fine for admin recovery, add custom SMTP for heavier use). Make sure **Authentication → URL Configuration → Site URL** points to your deployed site so reset links open the right place.

---

## 7. Enable Row Level Security

This is already handled by `supabase/schema.sql` (it runs `alter table ... enable row level security` and creates role-based policies). To verify:

```sql
select relname, relrowsecurity
from pg_class
where relname in ('workers','time_entries','active_timers','settings','payments','profiles','chat_messages');
```

The RLS model:
- The **admin** owns the workspace (all rows carry the admin's `user_id`).
- **Workers** can read their own worker profile, their own time entries, and their own **payments** (read-only), and can manage only their own clock-in timer (`worker_id = current_worker_id()`).
- **Only the admin** can create/edit workers, set hourly rates, add manual entries, change settings, and create/update/delete **payments** (`is_admin()`).
- The `user_id` column is auto-filled from `auth.uid()` by triggers; the `profiles` table maps auth users to `admin`/`worker` roles.

---

## 8. Build & deploy

Build for production:

```bash
npm run build
# outputs to dist/
```

### Deploy to Netlify (free)

This repository already includes `netlify.toml` with `npm run build`, `dist`, Node.js 22, a React Router SPA rewrite, and Netlify Functions for privileged worker account operations.

1. Push the project to GitHub.
2. In Netlify, choose **Add new project → Import an existing project** and select the repo.
3. Confirm Netlify is using the settings from `netlify.toml`: build `npm run build`, publish `dist`.
4. In Netlify **Project configuration → Environment variables**, add:
   - `VITE_SUPABASE_URL` = your Supabase Project URL
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = your Supabase Publishable key
   - `SUPABASE_SECRET_KEY` = your Supabase Secret key (**server-only**)
5. Redeploy after saving variables. Netlify exposes environment variables to Functions at runtime; build variables are also available to the site build.
6. In Supabase **Authentication → URL Configuration**, set the deployed Netlify URL as the **Site URL** and add it to the allowed redirect URLs. Add your custom HTTPS domain too when you connect one.

#### Supabase keep-alive (anti-sleep)

Free-tier Supabase projects are **paused after ~7 days of no API/database activity**, which takes the app offline until you restore the project from the Supabase dashboard. This repo ships a Netlify **scheduled function** (`netlify/functions/supabase-keepalive.ts`, scheduled via `netlify.toml`) that pings the project **once a day** — both the database (PostgREST) and the Auth service — so the inactivity clock is always reset and the project never sleeps.

- **No setup needed** — it reuses the `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` variables from step 4 and goes live automatically on your next Netlify deploy.
- You can verify each run in **Netlify → Logs → supabase-keepalive**, or trigger it manually at `/.netlify/functions/supabase-keepalive`.
- If you deploy somewhere without scheduled functions (e.g. Vercel free tier), point any external cron service (cron-job.org, GitHub Actions, UptimeRobot) at `https://YOUR-PROJECT.supabase.co/rest/v1/settings?select=id&limit=1` with your publishable key in the `apikey` header, once a day.

### Deploy to Vercel (free)

1. Import the repo on Vercel.
2. Framework preset: **Vite**. Build: `npm run build`, output `dist`.
3. Add the two env vars, then deploy.

---

## 9. Ship it as phone + desktop apps

The web build is already an **installable PWA**: on iPhone open it in Safari →
**Share → Add to Home Screen**; on Android/desktop Chrome·Edge accept the
install prompt. The app gets its own icon, a full-screen window and an
offline-capable shell. Inside the app, **Settings → “Get the app”** detects the
platform and walks the user through it (or fires the install prompt directly).

For store-grade builds, the repository contains ready-made native projects:

```bash
npm run apps:sync           # build dist/ + copy into ios/ & android/
npm run apps:ios:open       # Xcode        → archive → App Store / TestFlight
npm run apps:android:open   # Android Studio → signed .aab for the Play Store
npm run apps:desktop:dev    # Tauri desktop window with hot reload
npm run apps:desktop:build  # .msi/.exe (Windows), .dmg/.app (macOS), AppImage/deb
npm run apps:icons          # regenerate every icon/splash from assets/
```

Tagging a release (`git tag v1.1.0 && git push origin v1.1.0`) makes GitHub
Actions build **all** installers: Android `.apk`/`.aab`, an iOS archive (`.ipa`
when signing secrets are configured) and a draft GitHub Release with the
Windows/macOS/Linux desktop bundles. The workflow definitions ship in
`ci/workflows/`; run `./scripts/apps/enable-ci.sh` once (from an account with
the GitHub *Workflows* permission) to activate them. Full instructions, signing
setup and the secrets table live in **[docs/APPS.md](docs/APPS.md)**.

---

## Project structure

```
time-tracker/
├─ supabase/schema.sql          # Database tables, RLS, triggers (incl. team chat)
├─ supabase/chat-messages.sql   # One-time migration for the team chat on existing databases
├─ supabase/chat-notifications.sql      # One-time migration: notifications for chat messages
├─ supabase/chat-reactions.sql  # One-time migration: emoji reactions on chat messages
├─ supabase/settle-keeps-entries.sql    # One-time migration: settlements keep time entries
├─ src/
│  ├─ lib/                      # types, utils, stats, backend (local + supabase), store, theme, chat helpers
│  │                          # + emoji.ts (chat emoji catalogue) & stickers.ts (sticker pack registry)
│  │                          # + platform.ts (shell detection), native.ts (Capacitor bootstrap), useInstallPrompt.ts
│  ├─ components/               # shared UI + app components (shadcn-style), incl. AvatarBubble + ChatMembersDialog + EmojiPicker
│  │                          # + InstallAppCard.tsx (Settings → “Get the app”)
│  ├─ assets/chat-stickers/     # Drop an image in here and it becomes a chat sticker (see its README)
│  ├─ pages/                    # Dashboard, Tracker, Entries, Workers, Reports, Chat, Settings, Auth
│  ├─ App.tsx                   # Routing + auth gate (HashRouter inside native shells)
│  └─ main.tsx                  # mounts app, registers the PWA service worker (browser shells only)
├─ extension/                   # Chrome extension (worker clock in / break / clock out) — see extension/README.md
│  ├─ src/lib/api.ts            # the only place the extension writes to Supabase
│  └─ scripts/                  # mock Supabase + verifiers (npm run verify, verify:build, verify:chrome)
├─ ios/                         # Capacitor iOS project (Xcode) — App Store / TestFlight
├─ android/                     # Capacitor Android project (Gradle) — Play Store
├─ src-tauri/                   # Tauri desktop shell — Windows / macOS / Linux installers
├─ assets/                      # icon + splash sources every platform is generated from
├─ public/pwa/                  # PWA manifest icons (192/512/maskable/apple-touch)
├─ scripts/apps/                # generate-native-assets.sh (re-renders iOS/Android icons & splashes)
├─ capacitor.config.ts          # appId, splash/status-bar theming, WebView scheme
├─ .github/workflows/           # web.yml, mobile.yml, desktop.yml release pipelines
├─ docs/APPS.md                 # web/PWA/iOS/Android/desktop build + signing guide
├─ .env.example
└─ README.md
```

---

## Security notes

- Supabase **publishable/anon key only** in the frontend; Secret/service_role is never exposed.
- **Row Level Security** enforces per-user data isolation.
- `user_id` is set server-side via triggers, never trusted from the client.
- **Calculated values** (`total_minutes`, `earnings`) are recomputed in the backend/local layer where possible, and stored on the entry so history is stable.
- Input is trimmed and validated before writing.
- **Team chat** is one shared room per workspace: `chat_messages` rows are owned by the workspace admin and readable by every member of that workspace. `post_chat_message()` resolves the author (name, role, profile picture) from `auth.uid()` rather than from the request, so a worker cannot post as the admin or as another teammate; the client-side 2000-character limit mirrors the table's `check` constraint.

---

## Support

- Demo mode: works with zero configuration.
- Production: pair with a Supabase project using the steps above.
