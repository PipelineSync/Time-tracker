# Work Tracker — Chrome extension (for workers)

A tiny toolbar extension that does exactly three things: **clock in**, **start/end a break** and **clock out**. No dashboard, no reports, no admin screens.

It writes to the **same Supabase database as the web app**, so the moment a worker clocks in from the browser toolbar:

- the admin sees them under **On the clock now** (with a Working / On break badge),
- the admin gets the usual **clock-in / break / clock-out notification** in the bell,
- the finished shift appears in **Time Entries** and **Reports** like any other entry.

Nothing needs to be added to your database — the existing tables and Row Level Security policies already allow it.

---

## Try it

```bash
cd extension
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension/dist` folder.
3. Click the extension icon → **Options**, and paste:
   - **Supabase Project URL** — Supabase → *Project Settings → API → Project URL*
   - **Publishable key** — the `sb_publishable_…` key (older projects: the `anon public` key)
4. Click **Save & test**. Chrome will ask for permission to talk to that one address — allow it.
5. Back in the popup, sign in with the worker email and password the admin created.

Pin the extension to the toolbar and it is one click away all day.

> **Never paste the service-role key here.** It bypasses Row Level Security. Only the
> publishable (anon) key belongs in a browser extension.

Post a copy of the extension (and the two values to paste) in your team chat, or ship the
packaged build to everyone at once:

```bash
npm run zip     # → releases/work-tracker-extension.zip
```

Upload that zip to the Chrome Web Store, or have workers load it unpacked.

---

## Using it

| State | What you see | Buttons |
| --- | --- | --- |
| Clocked out | `00:00:00`, status **Clocked out** | **Clock in** (optional project / note first) |
| Working | Live timer, status **Working** | **Start break** · **Clock out** |
| On break | Timer frozen, break counter running, status **On break** | **End break** · **Clock out** |

Clock out asks for confirmation and shows what is about to be saved (hours, breaks, earnings), with an optional note for the admin — the same note the web app asks for.

Closing the popup never loses a shift. The timer is always recomputed from the clock-in timestamp stored in the database, so you can close the popup, restart the browser or switch devices mid-shift.

---

## How it fits the data model

| Action | What the extension writes |
| --- | --- |
| Clock in | `insert` into `active_timers` (rate snapshotted from the worker row), then a `time_in` notification for the admin |
| Start break | `update` the timer: `paused = true`, `pause_start = now`, then a `break_start` notification |
| End break | `update` the timer: `paused = false`, and the elapsed break is added to `total_pause_ms`, then a `break_end` notification |
| Clock out | `insert` into `time_entries` (worked minutes, break minutes, earnings, notes), `delete` the timer row, then a `time_out` notification |

This is the same sequence `src/lib/supabaseDb.ts` performs in the web app, including the rounding (`Math.round(ms / 60000)`) and the notification wording, so both clients produce identical rows.

A worker session is only allowed to do any of this by the RLS policies that `supabase/schema.sql` already created:

- `active_timers_insert_worker` — a worker may insert a timer for their own worker id
- `active_timers_update` / `active_timers_delete` — their own timer only
- `time_entries_insert` — their own entries only
- `notifications_insert` — a worker may post to the workspace owner

The `set_user_id()` trigger still stamps every row with the workspace admin, which is why the admin dashboard, Time Entries and Reports pick the punches up with no changes.

Admins cannot use the extension: signing in with the admin account shows *"The Chrome extension is for worker accounts"*, because the admin adds time through manual entries rather than a timer.

---

## Security notes

- **Publishable key + RLS only.** The extension never holds a service-role key, so a worker can only ever read and write their own rows.
- **Scoped host permission.** The manifest declares `optional_host_permissions` and requests access to the single Supabase origin when the workspace is saved — the extension never asks for "all websites".
- **No remote code.** Everything is bundled at build time; the MV3 content security policy forbids the rest.
- **Session in `chrome.storage.local`.** Signing in once is enough; the token refreshes automatically and is cleared by **Sign out** or **Disconnect** in Options.

---

## Development

```bash
cd extension
npm install
npm run dev            # rebuild on change, then reload the extension in chrome://extensions
npm run build          # typecheck + production build into extension/dist
npm run zip            # package dist/ into releases/work-tracker-extension.zip
```

Checks:

```bash
npm run verify         # end-to-end clock flow against a mock Supabase (no network needed)
npm run verify:build   # validates the built package: manifest, assets, CSP safety, icons
npm run verify:chrome  # drives the real popup in headless Chrome (needs: npm i -D puppeteer)
```

`npm run verify` boots `scripts/mock-supabase.mjs` — a miniature GoTrue + PostgREST stand-in — and drives the real `src/lib` modules through a full shift: sign in, clock in, take a 30-minute break, come back, clock out. It asserts the hours, the break deduction, the earnings, the notes and the admin notifications.

### Layout

```
extension/
├── popup.html · options.html     Vite entry points (become the popup and the options page)
├── public/
│   ├── manifest.json             MV3 manifest
│   └── icons/                    generated from ../assets/icon-only.png
├── src/
│   ├── lib/
│   │   ├── api.ts                clock in / break / clock out — the only place that writes
│   │   ├── config.ts             workspace settings in chrome.storage
│   │   ├── supabase.ts           one client per workspace, session kept in chrome.storage
│   │   ├── format.ts             timer and money formatting
│   │   └── types.ts              the slice of the database the extension touches
│   ├── popup/                    the toolbar UI
│   ├── options/                  setup screen
│   └── styles/base.css           shared tokens (light + dark)
├── scripts/                      mock Supabase, verifiers, zip helper
└── vite.config.ts
```

---

## Troubleshooting

| Message | Fix |
| --- | --- |
| *Connect your workspace* | Open **Options** and add the Project URL and publishable key. |
| *Supabase rejected that key* | You pasted the service-role key, or the wrong key. Use the **publishable** key. |
| *Could not reach Supabase* | Check the Project URL (no trailing path) and the connection. |
| *Wrong email or password* | Same credentials as the web app. The admin can reset the password from the Workers page. |
| *Your account is not linked to a worker profile* | The admin deleted and recreated the worker record; ask them to re-link the login. |
| *The Chrome extension is for worker accounts* | Signed in with the admin account — use the web app instead. |
| *Your workspace rejected that* | The database is missing the policies; re-run `supabase/schema.sql` in the SQL editor. |
