/**
 * The copy behind the little **"?"** button.
 *
 * Deliberately plain data, no React: the *answers* are the part that has to
 * stay true to what the app actually does (break time really is subtracted,
 * settling really never deletes entries, a grant really is enforced by the
 * database), so they live here where they can be read, diffed and checked on
 * their own (`scripts/verify-faq-local.ts`). `FaqButton` only renders them.
 *
 * Two audiences, because the two roles ask different questions:
 *  - `worker` — the person clocking in (the Clock In / Out screen)
 *  - `admin`  — the workspace owner (the Dashboard)
 *
 * `FaqButton` picks the audience for the *signed-in account* unless a screen
 * pins it (the tracker is a worker screen by definition, so it always asks for
 * the worker answers).
 */
export type FaqAudience = 'worker' | 'admin'

export interface FaqItem {
  /** Stable key — used for the open/closed state, so it must be unique. */
  id: string
  question: string
  answer: string
}

export interface FaqSection {
  title: string
  items: FaqItem[]
}

/** The audience-specific list the dialog shows, in order. */
export const FAQ_SECTIONS: Record<FaqAudience, FaqSection[]> = {
  worker: [
    {
      title: 'Clocking in & out',
      items: [
        {
          id: 'worker-clock-in',
          question: 'How do I clock in?',
          answer:
            'Tap Clock In and pick the client you are working for — every shift has to be booked to one, which is what makes the per-client reporting work. Your shift keeps running if you refresh the page or close the app, so you never lose time by leaving it open.',
        },
        {
          id: 'worker-breaks',
          question: 'How do breaks work?',
          answer:
            'Tap Break / Pause when you step away and Resume when you are back. The clock keeps running while you are on break, but break time is taken out of your shift — only worked time counts towards your hours and earnings.',
        },
        {
          id: 'worker-forgot',
          question: 'I forgot to clock out. What now?',
          answer:
            'Tell your administrator as soon as you can — they can correct the shift, or add the correct time for you, from Time Entries. If you clock in again, the app resumes the unfinished shift instead of starting a second one.',
        },
        {
          id: 'worker-switch-client',
          question: 'Can I switch client in the middle of a shift?',
          answer:
            'Yes. Tap Switch client while the clock is running. The shift keeps its original start time and only the time after the switch is booked to the new client.',
        },
        {
          id: 'worker-cannot-clock-in',
          question: 'Why is the Clock In button disabled?',
          answer:
            'The workspace has no active clients yet — your administrator adds them under Tasks → Clients, and you can clock in as soon as at least one is active. If the button is greyed out and time entries are empty, your login may also not be linked to a worker profile: ask your administrator.',
        },
      ],
    },
    {
      title: 'Your time & pay',
      items: [
        {
          id: 'worker-my-hours',
          question: 'Where do I see my hours?',
          answer:
            'My Time lists every recorded shift with its client, length and earnings. Entries your administrator has already paid for carry a Settled badge; anything without one is time still waiting to be paid out.',
        },
        {
          id: 'worker-payments',
          question: 'Where do I see my payments?',
          answer:
            'In Payroll — every payment your administrator created, with its status (unpaid, pending, paid) and, once it is paid, the method and the reference number.',
        },
        {
          id: 'worker-payment-methods',
          question: 'How do I tell you where to send my pay?',
          answer:
            'Open Settings → Payment methods and choose Cash, QR Code or both. If you pick QR Code, upload an image of your QR code (a screenshot of your GCash, Maya or banking app works) so it is ready to scan when you get paid.',
        },
        {
          id: 'worker-rate-changed',
          question: 'Why did my earnings change?',
          answer:
            'Your hourly rate is set by your administrator. Every entry keeps the rate that applied when the time was worked, so past shifts do not change when your rate does — only new time uses the new rate.',
        },
      ],
    },
    {
      title: 'Your account',
      items: [
        {
          id: 'worker-password',
          question: 'How do I change my password?',
          answer:
            'Account menu (top-right) → Change password. You will need your current password; if you have forgotten it, your administrator can reset it for you from the Workers page.',
        },
        {
          id: 'worker-avatar',
          question: 'How do I add a profile picture?',
          answer:
            'Settings → Profile. Your picture shows up next to your name for your administrator — on the Workers page, the Dashboard and the "On the clock now" panel — instead of just your initials.',
        },
        {
          id: 'worker-notepad',
          question: 'Is anything I write private?',
          answer:
            'Your Notepad is private — nobody else can read it. Notes and comments you add on a time entry are different: those are shared with your administrator on purpose, so the two of you can sort out a shift in the entry’s conversation thread.',
        },
      ],
    },
  ],

  admin: [
    {
      title: 'Workers & access',
      items: [
        {
          id: 'admin-add-worker',
          question: 'How do I add a worker?',
          answer:
            'Workers → Add worker: name, hourly rate and project scope. You create their login (email and password) on the same screen, and can reset that password later without deleting their history.',
        },
        {
          id: 'admin-grant-access',
          question: 'How do I give a worker access to the admin screens?',
          answer:
            'Workers → edit → Access. Granted screens appear in that worker’s nav under "Access Granted" on their next sync — no sign-out needed. The access is real, not just hidden buttons: both backends and the database policies check the same permissions.',
        },
        {
          id: 'admin-worker-cannot-sign-in',
          question: 'A worker cannot sign in.',
          answer:
            'Reset their password from the Workers page (with Supabase, a reset email goes out — the anon key cannot set another account’s password) and check the worker still exists. Deleting a worker permanently disables their login.',
        },
      ],
    },
    {
      title: 'Time & entries',
      items: [
        {
          id: 'admin-add-time',
          question: 'How do I add time someone forgot to log?',
          answer:
            'Time Entries → Add time (the Dashboard has an "Add time" button too): date, start and end time, and break. Hours and earnings are calculated with the worker’s rate at that moment, so historical totals stay correct.',
        },
        {
          id: 'admin-whos-working',
          question: 'How do I see who is working right now?',
          answer:
            'The Dashboard’s "On the clock now" panel lists everyone who is clocked in, with a Working / On break badge, updated live. The Chime pill in that panel plays a sound when the team’s clock moves — it is per device and off by default.',
        },
        {
          id: 'admin-fix-shift',
          question: 'A timer was left running — how do I fix it?',
          answer:
            'Open the entry in Time Entries and correct the start, end or break time (or delete it). A worker who clocks in again simply resumes their unfinished shift, so nothing is double-counted while it waits.',
        },
        {
          id: 'admin-clients',
          question: 'Where do clients come from?',
          answer:
            'Tasks → Clients is the master list — a name and a colour tag per client. Only active clients appear in the clock-in and task dropdowns; mark a client inactive instead of deleting it so past work keeps its label.',
        },
      ],
    },
    {
      title: 'Payroll, finance & reports',
      items: [
        {
          id: 'admin-pay-worker',
          question: 'How do I pay a worker?',
          answer:
            'Finance → Payroll → Reset & settle turns a worker’s unsettled time into an unpaid payment, then Mark paid picks the method (Cash or QR Code, with an optional reference number). Settling never deletes time — the entries are marked Settled and stay in Time Entries as history.',
        },
        {
          id: 'admin-subscriptions',
          question: 'Where do subscriptions, bills and due dates live?',
          answer:
            'Finance: recurring subscriptions (monthly or yearly, and you can limit how many bills a subscription runs for), one-off bills with deadlines, and the unified due-dates agenda of everything still open. Marking a bill or payroll run paid stamps it.',
        },
        {
          id: 'admin-reports',
          question: 'How do reports and CSV export work?',
          answer:
            'Reports has today / week / month / custom ranges, totals and averages, charts and a CSV export of the detailed rows. A worker you grant Reports sees the whole team’s numbers — grant it only if that is intended.',
        },
        {
          id: 'admin-settings',
          question: 'How do I change the currency, business name or notifications?',
          answer:
            'Settings holds the business name, currency, timezone, default rate, appearance and the Slack mirror (with a Send test message button). Individual workers’ rates live on the Workers page.',
        },
      ],
    },
  ],
}

/** Dialog heading per audience. */
export const FAQ_TITLE: Record<FaqAudience, string> = {
  worker: 'FAQs',
  admin: 'FAQs',
}

/** One-line intro under the heading, so the dialog says who it is written for. */
export const FAQ_INTRO: Record<FaqAudience, string> = {
  worker: 'Quick answers about clocking in, breaks, your time and your pay.',
  admin: 'Quick answers about workers, access, time, payroll and reports.',
}

/** Closing line — the honest fallback when the list does not cover it. */
export const FAQ_FOOTER: Record<FaqAudience, string> = {
  worker: 'Still stuck? Ask your administrator — they manage workers, rates, clients and payouts.',
  admin: 'Still stuck? The README documents every screen, and each backend has a schema file in supabase/.',
}
