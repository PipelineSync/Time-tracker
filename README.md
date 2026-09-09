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
| Notes on entries | ✅ (reply) | ✅ (add notes) |
| Settle & reset time → payments | ✅ | ❌ |
| Payments view | ✅ (all, full control) | ✅ (own, read-only) |
| Add tasks (kanban board) | ✅ (for any worker) | ✅ (own only) |
| View / move tasks | ✅ (all workers' boards) | ✅ (own only) |
| Change own password | ✅ | ✅ |
| Reset other accounts' passwords | ✅ | ❌ (own only) |

The table above is the **default**. Every ✅ in the Admin column can be **handed to an individual worker** — see **Per-worker access** below.

Workers **clock in, take breaks, and clock out** — their rate is set by the admin and shown read-only. **Any number of workers can be on the clock at the same time**; the admin sees all of them live, including who is currently on a break. The admin has **no start-timer**; instead the admin **adds time to workers** via manual entries (Time Entries → Manual entry, or Dashboard → Add time).

### Per-worker access
A worker does not have to be *only* a worker. When the admin adds someone (**Workers → Add worker**, or **Edit** on an existing card) the form has an **Access** section: tick which of the admin's capabilities that person gets. Nothing is ticked by default, so an ordinary worker is exactly as before — their own time, their own board.

The usual combinations below can be set by ticking the boxes (a matching combination is named in the collapsed summary):

| Level | What they get |
|---|---|
| **Worker** | Nothing extra. Their own time and their own tasks. *(default)* |
| **Supervisor** | Dashboard, the team list, everyone's time (read-only) and full control of **everyone's board**. No money. |
| **Manager** | Supervisor + manual time entries, payments, finance (read-only), reports and the client list. |
| **Full access** | Everything, including worker accounts and business settings. |

The individual capabilities are **View** / **Manage** pairs per area:

| Area | View | Manage |
|---|---|---|
| Dashboard | `dashboard.view` — the team overview | — |
| Workers | `workers.view` — the team list & rates | `workers.manage` — add/edit/delete workers, reset their passwords |
| Time entries | `entries.view_all` — everyone's time | `entries.manage` — add/edit/delete any entry |
| Tasks | `tasks.view_all` — everyone's board | `tasks.manage_all` — assign, move, edit and delete anyone's cards |
| Payments & settlements *(inside Finance → Payroll)* | `payments.view_all` — the team's payments | `payments.manage` — settle, mark paid, delete |
| Finance | `finance.view` — the subscriptions / payroll / due-dates ledger | `finance.manage` — add, edit, mark paid, delete finance lines |
| Reports | `reports.view` — charts + CSV export | — |
| Clients | — | `clients.manage` — add, rename, retire clients |
| Settings | — | `settings.manage` — business details, currency, default rate, Slack |

Granting **any** team-wide view (dashboard, time, tasks, payments, finance or reports) also lets that worker read the **worker list** — rows about other people are meaningless without the names — while the **Workers page** itself only appears with `workers.view`.

What a grant changes: the **navigation** gains that destination (and "My Time"/"My Tasks" become the team-wide "Time Entries"/"Tasks"), the **route** starts resolving, and the matching buttons appear. Nothing else about the person changes — a granted worker still clocks in and out like everyone else, and only the admin can wipe the workspace or load sample data.

It is enforced in three places, not just the UI: the **app** hides what you cannot do, both **backends** refuse the call, and on Supabase the **Row Level Security policies check the same keys** (`public.has_permission('…')`), so a granted worker's rows really are readable and an ungranted one's request is rejected by the database itself. Changing someone's access takes effect on their next data sync — no sign-out needed. Note that `workers.manage` is the powerful one: like the admin, whoever can edit workers can also change what other workers may do. See `supabase/worker-permissions.sql`.

### Pages
- **Dashboard** *(admin)* — today's & this week's hours and earnings, a live **"On the clock now"** panel listing **every** worker currently clocked in (with a **Working** / **On break** badge, time worked and break time, updated every second), per-worker summary, recent entries, "Add time"
- **Workers** *(admin)* — add/edit/delete workers, create each worker's login account, set hourly rate, **Project Scope**, active/inactive status, and the **Access** they get (see *Per-worker access*). The **Project Scope** describes the work a person is assigned to and is shown on their profile; the **client** each shift is booked to is picked at clock-in from the master list (see **Clients**). Each worker card shows their **live clock status** (Working / On break, with elapsed time) while they are on the clock, and the **hours & earnings still to pay** — only the time that has *not* been settled yet, so both drop back to zero the moment you **Settle & reset** (what has already been settled stays visible underneath as context, and the full lifetime totals live in Time Entries and Reports). **Deleting a worker also permanently disables their login account** (the Supabase Auth user is removed server-side, and any open session of theirs is signed out) — they can no longer sign in.
- **Clock In / Out** *(worker)* — big clock-in button, then break/pause/resume and clock-out; survives a page refresh. Clocking in **requires choosing a client** — every shift has to be booked to one — and the dropdown is pre-filled with the client from the worker's last shift (or the only active one), so the common case is still one tap. The "Clock In" button stays disabled until a client is picked, and if the workspace has no active clients the worker is told to ask the admin to add one before they can clock in. The client rides along on the running timer and lands on the **time entry** at clock-out, which is what makes the per-client reporting work. At clock-out the worker can attach an **optional note** that is saved on the time entry (the admin's clock-out notification flags that a note was added).
- **Manual entry** *(admin)* — date, start/end time, break, project, notes, auto-calculated hours & earnings (this is how the admin adds time to workers)
- **Time Entries** — table on desktop / cards on mobile, filters (**client**, worker, date range, **settled / unsettled**), sorting; each row shows the **client** it was booked to (entries logged before clients existed keep their old free-text scope); admin can edit/delete/duplicate, workers see their own. Entries that a settlement paid for carry a **Settled** badge and stay here as history; the summary line also shows the **unsettled** earnings still waiting to be paid out
- **Notes / chat on entries** — every entry has a conversation thread: workers add notes, the admin replies (and vice versa), both sides are notified
- **Reports** *(admin)* — today/week/month/custom range, totals & averages, charts (including **Hours by client**, drawn in each client's colour, plus an *Hours & earnings per client* breakdown), **CSV export** (the detailed rows carry the client)
- **Settings** *(admin)* — business name, currency, timezone, default rate, theme, export & delete all data
- **Settings → Profile** *(worker)* — workers upload their own **profile picture** from their account settings. The picture is saved to their worker profile and shows up **for the admin** next to their name on the Workers page, the Dashboard and the "On the clock now" panel — not just a bare name.
- **Settings → Payment methods** *(worker)* — each worker chooses how they can be paid: **Cash**, **QR Code**, or both. Enabling **QR Code** requires uploading their QR code image (a screenshot/photo of their GCash, Maya, banking-app, etc. QR — the image is automatically downscaled before saving). The methods and QR image are saved on the worker's profile.
- **Payments & settlements** *(lives in **Finance → Payroll** — the standalone section was folded into it, old `/payments` links redirect there)* — the admin turns a worker's unsettled time & earnings into a **settlement**: a **Reset & settle** action on a worker creates an **unpaid** payment for the time that has not been settled yet. **Time entries are never deleted by a settlement** — the entries it paid for are marked **Settled** (their hours, notes and comments all stay in Time Entries), so the next settlement only covers time worked since. An entry only disappears when the admin **deletes it by hand**. The admin then drives the status **unpaid → pending → paid** (with a "Back to unpaid" option) and can delete payments. When the admin clicks **Mark paid**, a dialog shows the **payment methods that worker accepts** (Cash / QR Code, with the QR image ready to scan) and the admin **picks the method they are paying with**; it is stored on the payment (`payments.payment_method`, see `supabase/payment-paid-method.sql`) and shown in the **Paid via** column of the history. The **worker** sees their own payments **read-only**, with no edit controls, and their own enabled methods and QR code at the top. Every worker gets a **Payroll** nav item that opens this view (it becomes the full **Finance** item once the admin grants Finance access) — their own rows only; seeing the *team's* payments still needs `payments.view_all`.
- **Finance** *(admin-only, per-worker access off by default)* — the business ledger in its own section: **subscriptions** (recurring services like Adobe or QuickBooks — name, amount, **monthly/yearly cycle**, next bill date; "Billed" rolls the date one cycle forward, and a paused subscription stops showing up), **worker payroll** (a run per worker per month — the amount is **pre-filled from what their tracked time earned** that month, editable, with a pay day that gets flagged when it passes) and **due dates** (a unified agenda of every open line — overdue first, red, then upcoming — plus one-off **bills** like rent or tax with their deadlines). Marking a payroll run or bill **paid** stamps it, and below the payroll runs the **Payroll** tab hosts the **Payments & settlements** panel (the former standalone Payments section — settle flow, status and mark-paid untouched). Everything is **read-only** for a worker granted `finance.view`; adding, editing or marking paid needs `finance.manage`. Workers without any Finance access still reach this tab via their **Payroll** nav item and see only their own payments there. See `supabase/finance.sql`.
- **Clients** *(admin-managed, used by both roles)* — a **master list of every client** the team works for, opened from **Tasks → Clients**. The admin adds a client (name + one of eight **colour tags**), renames or re-colours it, and can **mark it inactive at any time**. Only **active** clients appear in the dropdowns when assigning a task or clocking in; an inactive client stays on the work it already labels (board, entries, reports) so history never loses its name. A client can only be **deleted while nothing uses it** — otherwise the app points you at *mark inactive* instead. Workers can **read** the list (they need it for their filters) but never change it. See `supabase/clients.sql`.
- **Tasks** *(both roles)* — a **kanban board** with five stages: **To Do → In Progress → Waiting → Approval → Completed**, laid out as a **row of lanes** (it scrolls sideways one lane at a time on a phone). **Drag and drop** a card between lanes to change its stage (a drop indicator shows exactly where it will land, cards keep their manual order inside a lane, and dragging to the edge scrolls the row). On phones — or with a keyboard — the **‹ ›** buttons on each card move it one stage at a time instead of dragging. Every task belongs to a **client** and has a title, optional details, a **priority** (Low / Medium / High) and an optional **due date** (overdue cards are flagged in red). Each card shows its client's colour badge.
  - **Both roles** get a **client filter** and a **priority filter** over the board.
  - **Workers** can add tasks, but only ever for **themselves**, and they only ever see, move, edit, and delete **their own** tasks.
  - The **admin** can add a task for **any** worker and sees **every** worker's cards on one board (each card names its owner), and additionally gets a **worker filter** and a **stage filter** (with a *Clear filters* button) to narrow the board down to one person, one stage, or both. When the admin assigns a task, the worker gets a notification.
  - Access is enforced in the backend *and* at the database level with Row Level Security — see `supabase/tasks.sql`.
- **Auth** — sign in with admin or worker credentials. Only the admin can create worker login accounts.
- **Change password** — available from the account menu (top-right) for both roles: enter your current password and a new one. Admins can also **reset a worker's password** from the Workers page. In demo mode the new password is set directly; with Supabase, a password reset link is emailed to the worker (the anon key cannot set another user's password).

### Christmas theme 🎄
The app ships with a **seasonal Christmas skin**, on by default:
- **Logo wearing a Santa hat** — an SVG hat is tilted over the "S" of the PipelineSync mark (`src/components/SantaHat.tsx`). It is positioned and scaled as a fraction of the logo's *height*, with per-variant offsets measured from the two logo files, so it sits correctly on the light and dark lockups at every size (sidebar, mobile header, sign-in card).
- **Festive palette** — a Christmas-red primary, evergreen accents and a warm-snow background replace the brand blues, in both light and dark mode. Only the semantic theme tokens are re-pointed, so every component picks it up with no component-level changes. **All text pairings were contrast-checked and meet WCAG AA** (the dark-mode button red was darkened to 46% lightness specifically to clear 4.5:1).
- **Falling snow** — a semi-transparent snowfall layer (`src/components/Snowfall.tsx`). It is deliberately unobtrusive: it sits at `z-index: -1` **behind all content**, is `pointer-events-none` (never swallows a click), uses small low-opacity flakes (12–38%), and freezes for anyone with `prefers-reduced-motion`. **Text readability is unaffected.**

To ship the normal brand skin instead, build with `VITE_CHRISTMAS_THEME=off` — that removes the hat, the palette and the snow in one switch (`src/lib/christmas.ts`).

### Notifications
A notification bell (with an unread badge) appears for both roles. The admin is notified when a worker **clocks in**, **starts a break**, **comes back from a break**, **clocks out**, or **adds a note**. Workers are notified when the **admin replies to a note**, **adds time** for them, creates a **payment**, or changes a **payment status**. Clicking a notification opens the related entry.


All entries **snapshot the hourly rate** at record time, so historical earnings don't change when a worker's rate changes later. Sessions that cross midnight are handled correctly.

### Slack notifications
Every workspace event can also be mirrored into a **Slack channel** automatically: when someone **clocks in**, **clocks out**, **starts a break**, **comes back from a break**, or when a payment is **marked paid** (amount, worker, period and payment method included). Each event type can be toggled on/off in **Settings → Slack**, and a **Send test message** button verifies the setup end to end.

Setup (Supabase-connected deploys):

1. Run `supabase/slack-notifications.sql` once in the Supabase SQL editor (fresh installs running `schema.sql` already have the table). It creates the admin-only `slack_settings` row that stores your webhook URL and per-event toggles — workers can never read the webhook URL because RLS restricts the table to the admin.
2. In Slack: **Create an app → From scratch** → pick your workspace → enable **Incoming Webhooks** → **Add New Webhook to Workspace** → choose the channel → copy the `https://hooks.slack.com/services/…` URL.
3. Paste the URL in **Settings → Slack**, pick the events you want, **Save**, then **Send test message**.
4. Optional deploy-level fallback: set `SLACK_WEBHOOK_URL` in the Netlify environment variables. The saved URL in Settings wins when both exist. (In **demo mode** there is no server, so the browser posts straight to the webhook URL configured in Settings.)

Messages are posted server-side by the `slack-notify` Netlify Function, which rebuilds each message from the database (worker name, project, hours, earnings, currency, business timezone) — so a client can never forge names or amounts, and a slow/broken Slack hookup can never block clocking in or out.

### Performance & egress (why many tabs at once don't slow it down)
The app is built to stay inside Supabase's and Netlify's free-tier bandwidth even with a whole team signed in at once.

**Data sync (Supabase egress)**
- Every visible tab keeps a **bounded window** of the database in memory (1200 newest entries for the admin, 300 for a worker) — per-tab load stays flat as history grows.
- The 15 s background poll fetches only what changed: entries sync as a **delta** (`since` the last sync), and the unread badge is a **HEAD count** that ships no rows at all.
- Heavy-but-rarely-changing lists — **workers, payments, settings, tasks and the notification dropdown** — are skipped on "light" ticks and refresh roughly **once a minute** instead of every 15 s. Anything you change yourself refreshes immediately, so this is invisible in use.
- Queries name their **columns explicitly** rather than `select('*')`, so the workspace-owner `user_id` (identical on every row, never displayed) never goes over the wire.
- Background refreshes never stack: focus/visibility events fire in bursts, and a refresh already in flight suppresses the rest.

**Static assets (CDN egress)**
- `public/_headers` marks the fingerprinted `/assets/*` build output **`immutable` for a year**, so returning visitors re-download nothing; `index.html` and `sw.js` always revalidate so deploys still land instantly.
- Brand images are served at the size they are actually displayed (the logo was a 1052×216 PNG rendered at 28 px) — the brand folder went from **310 KB to 37 KB**.
- **Recharts (~110 KB gzipped) is admin-only**, so it is pinned to its own `charts-*` chunk that (a) nobody but an admin ever downloads, (b) keeps a stable URL across deploys, and (c) is **excluded from the PWA precache** — otherwise every worker's phone would download the chart library on every deploy. It is cached at runtime on first use instead. The PWA install dropped from **1510 KB to 844 KB**.

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
- Admin: `admin` / `admin.pipelinesync` — the admin workspace is auto-seeded with sample workers and entries on first login.
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

This creates the `workers`, `time_entries`, `active_timers`, `settings`, `payments`, and `tasks` tables with foreign keys, indexes, **Row Level Security policies**, and triggers that auto-set `user_id` and `updated_at`.

> **Upgrading an existing database?** Run `supabase/fix-multiple-active-workers.sql` once — it makes the timer uniqueness rule *one per worker* (older databases allowed only one clocked-in worker per workspace, so the admin dashboard could only ever show a single worker) and allows the new `break_start` / `break_end` notification types.
>

> If your database predates the worker-login fix, also run `supabase/fix-deleted-worker-login.sql` once. It adds the `profiles_delete` policy and permanently removes the leftover logins of workers that were deleted before the fix (so those workers can no longer sign in).
>
> To let workers upload their **own profile picture** from their account settings, run `supabase/worker-profile-picture.sql` once. It adds a SECURITY DEFINER RPC (`update_own_avatar`) so a worker can change only the avatar on their own worker row (they still can't edit their hourly rate, status, or other admin-managed fields). Fresh installs get this automatically from `schema.sql`.
>
> For **settlements that keep time entries**, run `supabase/settle-keeps-entries.sql` once. It adds `time_entries.settled_at`, the column "Settle & reset" stamps instead of deleting the entries it paid for (without it the app still keeps the entries, but falls back to the previous payment's `period_end` as the paid-up-to boundary). Fresh installs get this automatically from `schema.sql`.
>


> For **Clients**, run **`supabase/clients.sql`** once. It creates the `clients` table (name, colour tag, active/inactive) with RLS policies that let the **admin manage the list** while **workers may only read it**, adds `client_id` to `tasks`, `time_entries` and `active_timers`, and **backfills** every existing task/entry to an **"Unassigned"** client so nothing is left untagged. Fresh installs get the table from `schema.sql`. Safe to re-run. Until it is applied the app still runs — it just reports an empty client list and leaves work untagged.
>
> **Shortcut:** if you have an existing database that predates both the Clients feature and per-worker access, **`supabase/RUN-THIS-clients-and-permissions.sql`** is a single copy-paste bundle of the two migrations below, in the right order, with verification queries at the end.
>
> For the **Finance** section, run **`supabase/finance.sql`** once. It creates the `finance_items` ledger (subscriptions, per-worker monthly payroll and one-off bills, all with due dates) with RLS that keeps it **admin-only**: a worker can read it only with `finance.view` and write only with `finance.manage`, both off by default. If the per-worker-permissions migration below has not been applied yet, the table is simply locked to the admin; re-run this file after it. Fresh installs get everything from `schema.sql`. Safe to re-run. Until it is applied the app still runs — the Finance section just reports an empty ledger. On an **existing** database this migration also widens the `workers` permission allow-list: run it **before granting the Finance tick boxes** on the Workers page, otherwise saving reports that the Finance access was skipped (everything else still saves).
>
> For **per-worker access** (letting the admin grant individual admin capabilities to individual workers), run **`supabase/worker-permissions.sql`** once. It adds `workers.permissions` (a validated `text[]`), the `public.has_permission(text)` helper, and widens the RLS policies on workers, time entries, timers, payments, tasks, clients, settings and entry comments with one extra "…or I hold this capability" branch each. Fresh installs get it from `schema.sql`. Safe to re-run. Until it is applied the app still runs — everyone keeps the classic admin/worker split, and saving the Access tick boxes reports that the migration is needed.
>
> For the **Tasks** kanban board, run **`supabase/RUN-THIS-tasks.sql`** once (a copy-paste-ready version of `supabase/tasks.sql`, with a verification query at the end). It creates the `tasks` table (stage, priority, due date, board position) with RLS policies that let a **worker see and manage only their own cards** while the **admin has access to every worker's tasks**. Fresh installs get this automatically from `schema.sql`. It is safe to re-run: if you applied an earlier version with only three stages, re-running it widens the stage constraint to include **Waiting** and **Approval**.
>
> For **Slack notifications** (clock in / out, breaks, payments posted to a Slack channel), run `supabase/slack-notifications.sql` once. It creates the admin-only `slack_settings` table (webhook URL + per-event toggles). Then connect the webhook in **Settings → Slack** — see the *Slack notifications* section under Features. Fresh installs get this automatically from `schema.sql`.

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
where relname in ('workers','time_entries','active_timers','settings','payments','profiles');
```

The RLS model:
- The **admin** owns the workspace (all rows carry the admin's `user_id`).
- **Workers** can read their own worker profile, their own time entries, and their own **payments** (read-only), and can manage only their own clock-in timer (`worker_id = current_worker_id()`).
- **Only the admin** can create/edit workers, set hourly rates, add manual entries, change settings, and create/update/delete **payments** (`is_admin()`) — **unless** the admin granted that capability to a specific worker, which the policies check with `has_permission('…')` against the `workers.permissions` array (see `supabase/worker-permissions.sql`).
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
├─ supabase/schema.sql          # Database tables, RLS, triggers
├─ supabase/settle-keeps-entries.sql    # One-time migration: settlements keep time entries
├─ supabase/tasks.sql           # One-time migration: Tasks kanban board (+ per-role RLS)
├─ supabase/finance.sql         # One-time migration: Finance ledger (subs, payroll, due dates)
├─ supabase/clients.sql         # One-time migration: Clients master list + client_id backfill
├─ supabase/worker-permissions.sql      # One-time migration: per-worker admin capabilities (+ RLS)
├─ supabase/RUN-THIS-clients-and-permissions.sql   # Copy-paste bundle of the two migrations above
├─ src/
│  ├─ lib/                      # types, utils, stats, backend (local + supabase), store, theme
│  │                          # + platform.ts (shell detection), native.ts (Capacitor bootstrap), useInstallPrompt.ts
│  ├─ components/               # shared UI + app components (shadcn-style), incl. AvatarBubble
│  │                          # + PaymentsPanel.tsx (Finance → Payroll) + InstallAppCard.tsx (Settings → “Get the app”)
│  ├─ pages/                    # Dashboard, Tracker, Entries, Tasks, Workers, Reports, Settings, Finance, Auth
│  ├─ App.tsx                   # Routing + auth gate (HashRouter inside native shells)
│  └─ main.tsx                  # mounts app, registers the PWA service worker (browser shells only)
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

---

## Support

- Demo mode: works with zero configuration.
- Production: pair with a Supabase project using the steps above.
