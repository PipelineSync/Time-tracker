/**
 * The connector's sign-in + consent page.
 *
 * A self-contained HTML document: no build step, no external requests, no
 * analytics. It has to render correctly inside whatever browser Claude opens
 * (Safari on iOS, Chrome desktop, the desktop app's web view), so it is plain
 * CSS with a dark-mode media query and nothing clever.
 *
 * The consent copy matters as much as the styling: this is the one moment a
 * real person decides whether Claude may touch their workspace, so it spells
 * out exactly what the connector can read and change.
 */

interface PendingRequest {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  codeChallengeMethod: string
}

interface PageOptions {
  pending?: PendingRequest
  error?: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function hiddenFields(pending: PendingRequest): string {
  const fields: [string, string][] = [
    ['client_id', pending.clientId],
    ['redirect_uri', pending.redirectUri],
    ['state', pending.state],
    ['code_challenge', pending.codeChallenge],
    ['code_challenge_method', pending.codeChallengeMethod],
  ]
  return fields
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`)
    .join('\n      ')
}

export function page(options: PageOptions): string {
  const { pending, error } = options
  const brand = '#06245B' // PipelineSync navy — matches the app and PWA theme.

  const body = pending
    ? `
      <form method="post" action="" class="form">
        ${hiddenFields(pending)}
        <label class="field">
          <span>Work Tracker email</span>
          <input type="email" name="email" autocomplete="username" required autofocus
                 placeholder="you@example.com" />
        </label>
        <label class="field">
          <span>Password</span>
          <input type="password" name="password" autocomplete="current-password" required
                 placeholder="••••••••" />
        </label>
        <button type="submit" class="button">Sign in and connect</button>
      </form>`
    : `<p class="muted">This link is incomplete. Remove the connector in Claude and add it again.</p>`

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="referrer" content="no-referrer" />
    <title>Connect Claude to Work Tracker</title>
    <style>
      :root {
        --navy: ${brand};
        --bg: #f4f6fb;
        --card: #ffffff;
        --text: #10202f;
        --muted: #5a6b7d;
        --border: #dde3ec;
        --danger-bg: #fdf0f0;
        --danger: #a12a2a;
        --danger-border: #f0c8c8;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0b1524;
          --card: #12203a;
          --text: #eaf0f8;
          --muted: #9aabc0;
          --border: #24344f;
          --danger-bg: #34191b;
          --danger: #ffb3b3;
          --danger-border: #5d2a2a;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 24px 16px calc(24px + env(safe-area-inset-bottom));
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 15px;
        line-height: 1.5;
      }
      .card {
        width: 100%;
        max-width: 420px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 28px;
        box-shadow: 0 10px 30px rgba(6, 36, 91, 0.08);
      }
      .mark {
        width: 40px; height: 40px; border-radius: 10px;
        background: var(--navy); color: #fff;
        display: flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 18px; margin-bottom: 16px;
      }
      h1 { margin: 0 0 6px; font-size: 19px; line-height: 1.3; }
      .sub { margin: 0 0 20px; color: var(--muted); font-size: 14px; }
      .alert {
        background: var(--danger-bg); color: var(--danger);
        border: 1px solid var(--danger-border);
        border-radius: 8px; padding: 10px 12px; font-size: 14px; margin-bottom: 16px;
      }
      .form { display: grid; gap: 14px; }
      .field { display: grid; gap: 6px; }
      .field span { font-size: 13px; font-weight: 600; }
      input {
        width: 100%; padding: 11px 12px; font-size: 15px; font-family: inherit;
        color: var(--text); background: transparent;
        border: 1px solid var(--border); border-radius: 9px;
      }
      input:focus { outline: 2px solid var(--navy); outline-offset: 1px; }
      .button {
        margin-top: 4px; padding: 12px 16px; width: 100%;
        background: var(--navy); color: #fff; border: 0; border-radius: 9px;
        font-size: 15px; font-weight: 600; font-family: inherit; cursor: pointer;
      }
      .button:hover { filter: brightness(1.12); }
      .scope {
        margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--border);
        font-size: 13px; color: var(--muted);
      }
      .scope h2 { margin: 0 0 8px; font-size: 13px; color: var(--text); }
      .scope ul { margin: 0; padding-left: 18px; }
      .scope li { margin-bottom: 3px; }
      .foot { margin-top: 18px; font-size: 12px; color: var(--muted); }
      .muted { color: var(--muted); }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="mark" aria-hidden="true">W</div>
      <h1>Connect Claude to Work Tracker</h1>
      <p class="sub">Sign in with your Work Tracker account. Claude will only ever see what this account is allowed to see.</p>

      ${error ? `<div class="alert" role="alert">${escapeHtml(error)}</div>` : ''}

      ${body}

      <div class="scope">
        <h2>Once connected, Claude can:</h2>
        <ul>
          <li>Read your hours, tasks, payments, invoices and support tickets</li>
          <li>Add or edit time entries, tasks, invoices and notes</li>
          <li>Clock you in and out, and settle time into payments</li>
        </ul>
        <p class="foot">
          Your password is checked by Work Tracker and never shared with Claude.
          You can disconnect at any time from Claude's connector settings.
        </p>
      </div>
    </main>
  </body>
</html>`
}
