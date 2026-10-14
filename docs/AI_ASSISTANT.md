# AI assistant (in-app chat)

A chat button in the corner of the app. Anyone signed in can ask about their own
work — *"how many hours did I work this week?"*, *"what's overdue on my board?"* —
or ask for a change — *"start a break"*, *"add a task to write the Q4 report, due
Friday"* — and the assistant does it through the same tools as the
[Claude Connector](MCP_CONNECTOR.md).

```
Browser widget ──(your session token)──▶ /ai-chat (Netlify Function) ──▶ Claude API
                                               │
                                               └─ runs the connector's tools as YOU,
                                                  so Row Level Security decides what
                                                  it can see and change
```

## What it can and can't do

- **Only what the signed-in person can do in the app.** Every tool runs on a
  Supabase client authenticated with that person's own session. A worker's
  assistant sees their own time, tasks and pay plus whatever the admin granted
  them (the same permission keys as the app); it cannot read or change anyone
  else's data, however it is asked. The admin's assistant has the admin's reach.
- **Every change needs approval.** Reads run immediately. Any tool that changes
  data (clocking in/out, breaks, entries, tasks, invoices, payments, finance,
  meetings, tickets) shows an **Approve / Cancel** card with exactly what will
  be sent. Nothing changes until the person presses Approve; Cancel tells the
  model the action was declined.
- **A permission it lacks is refused by the tool,** with the name of the
  missing permission — the same refusal the connector gives.

## Setup

1. **Anthropic API key.** In Netlify → *Site configuration → Environment
   variables*, add `ANTHROPIC_API_KEY` (from console.anthropic.com). It is a
   server-only variable — **never** prefix it with `VITE_`. Redeploy.
2. **Database column (optional but recommended).** Run
   `supabase/RUN-THIS-ai-assistant.sql` in the Supabase SQL editor. It adds the
   workspace on/off switch. Without it the assistant still works; the admin just
   can't switch it off.
3. That's it. The chat button appears for everyone after the next deploy.

The assistant needs the real (Supabase) backend; in demo mode the button is
hidden.

## Turning it off

**Settings → Appearance → AI assistant** (admin). Off hides the button for the
whole team, and the `/ai-chat` endpoint refuses every request — it never calls
Claude while switched off.

## Model and cost

- Model: **Claude Sonnet 5.5** (`claude-sonnet-5-5`), effort `low` for quick
  chat-style answers. Change `AI_MODEL` / `EFFORT` in
  `netlify/functions/lib/ai/assistant.ts`.
- Billed to your Anthropic account per message. The instructions and tool list
  are prompt-cached, so follow-up messages are cheaper.
- **Refusal fallback is on** (`fallbacks: "default"`): if Claude's safety
  classifier declines a request, the API retries it on Anthropic's recommended
  fallback model instead of failing. Remove the `betas` / `fallbacks` lines in
  `assistant.ts` to turn that off.
- There is no per-person usage cap yet. If you need one, add it to
  `netlify/functions/ai-chat.ts`.

## Privacy

- **Chat history is saved per device**, in that browser's local storage, per
  account (`wt_ai_chat:<user id>`). It is never stored on the server. The
  *New chat* button clears it.
- Each message sends the conversation, plus the tool results the assistant
  looked up, to the Anthropic API to produce the answer.

## How it works

- `netlify/functions/ai-chat.ts` — the endpoint: checks the session, the
  workspace switch and the key, then runs one step.
- `netlify/functions/lib/ai/assistant.ts` — one step of the tool-use loop. Each
  request does one unit of work (run the pending tools, or ask Claude for the
  next turn), which keeps every call inside Netlify's function time limit; the
  browser repeats until Claude answers or an approval is needed.
- `src/components/AiAssistant.tsx` / `src/lib/aiAssistant.ts` — the widget and
  its client.
- The conversation is sent back exactly as Claude returned it (Claude Sonnet 5.5
  requires its reasoning blocks to be replayed unchanged). When a conversation
  grows long, the oldest turns are dropped along with all reasoning blocks.

**Prompt injection.** Text inside records (a task title, a note, a ticket) could
try to instruct the model. The system prompt tells it to treat record text as
data, and — more importantly — no change can happen without the person pressing
Approve on a card that shows exactly what will be sent.

## Tests

`npm run verify:ai-assistant` runs the real endpoint and tools against the fake
Supabase from the connector tests and a scripted fake Claude API. It checks
that reads are limited to the person's own rows, that writes wait for approval
(and Cancel or a missing decision never writes), that a missing permission is
refused, and that the switch, a missing key and a bad session are refused.
