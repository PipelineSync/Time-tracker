# Work Tracker

A modern, mobile-first web app for tracking workers' time, notes, hourly rates, and earnings.

Built with **React + TypeScript + Tailwind CSS + shadcn/ui components + Supabase** (auth & database). It runs on free-tier hosting and works **out of the box in demo mode** (no setup needed) using browser-local storage.

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
| Settle & reset time → payments | ✅ | ❌ |
| Payments view | ✅ (all, full control) | ✅ (own, read-only) |
| Change own password | ✅ | ✅ |
| Reset other accounts' passwords | ✅ | ❌ (own only) |

Workers **clock in, take breaks, and clock out** — their rate is set by the admin and shown read-only. The admin has **no start-timer**; instead the admin **adds time to workers** via manual entries (Time Entries → Manual entry, or Dashboard → Add time).

### Pages
- **Dashboard** *(admin)* — today's & this week's hours and earnings, active-worker banner, per-worker summary, recent entries, "Add time"
- **Workers** *(admin)* — add/edit/delete workers, create each worker's login account, set hourly rate & active/inactive status
- **Clock In / Out** *(worker)* — big clock-in button, then break/pause/resume and clock-out; survives a page refresh
- **Manual entry** *(admin)* — date, start/end time, break, project, notes, auto-calculated hours & earnings (this is how the admin adds time to workers)
- **Time Entries** — table on desktop / cards on mobile, filters, sorting; admin can edit/delete/duplicate, workers see their own
- **Notes / chat** — every entry has a conversation thread: workers add notes, the admin replies (and vice versa), both sides are notified
- **Reports** *(admin)* — today/week/month/custom range, totals & averages, charts, **CSV export**
- **Settings** *(admin)* — business name, currency, timezone, default rate, theme, export & delete all data
- **Payments** — the admin turns a worker's tracked time & earnings into a **settlement**: a **Reset & settle** action on a worker creates an **unpaid** payment and zeroes that worker's tracked time. The admin then drives the status **unpaid → pending → paid** (with a "Back to unpaid" option) and can delete payments. The **worker** sees their own payments **read-only**, with no edit controls.
- **Auth** — sign in with admin or worker credentials. Only the admin can create worker login accounts.
- **Change password** — available from the account menu (top-right) for both roles: enter your current password and a new one. Admins can also **reset a worker's password** from the Workers page. In demo mode the new password is set directly; with Supabase, a password reset link is emailed to the worker (the anon key cannot set another user's password).

### Notifications
A notification bell (with an unread badge) appears for both roles. The admin is notified when a worker **clocks in**, **clocks out**, or **adds a note**. Workers are notified when the **admin replies to a note**, **adds time** for them, creates a **payment**, or changes a **payment status**. Clicking a notification opens the related entry.

All entries **snapshot the hourly rate** at record time, so historical earnings don't change when a worker's rate changes later. Sessions that cross midnight are handled correctly.

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

This creates the `workers`, `time_entries`, `active_timers`, `settings`, and `payments` tables with foreign keys, indexes, **Row Level Security policies**, and triggers that auto-set `user_id` and `updated_at`.

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

### Deploy to Vercel (free)

1. Import the repo on Vercel.
2. Framework preset: **Vite**. Build: `npm run build`, output `dist`.
3. Add the two env vars, then deploy.

---

## Project structure

```
time-tracker/
├─ supabase/schema.sql          # Database tables, RLS, triggers
├─ src/
│  ├─ lib/                      # types, utils, stats, backend (local + supabase), store, theme
│  ├─ components/               # shared UI + app components (shadcn-style)
│  ├─ pages/                    # Dashboard, Tracker, Entries, Workers, Reports, Settings, Auth
│  ├─ App.tsx                   # Routing + auth gate
│  └─ main.tsx
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
