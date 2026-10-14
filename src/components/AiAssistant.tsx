import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Check, RotateCcw, Search, SquarePen, X } from 'lucide-react'
import { NovaOrb, type OrbState } from '@/components/NovaOrb'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  AssistantError,
  isTypedUserMessage,
  loadChat,
  messageText,
  saveChat,
  sendStep,
  toolLabel,
  type ChatBlock,
  type ChatMessage,
  type PendingAction,
} from '@/lib/aiAssistant'

/** Server steps per user action before we stop and let the person decide. */
const MAX_STEPS = 12

/**
 * The connector's read tools are exactly these names (see
 * netlify/functions/lib/mcp/tools — everything else changes data). Used only
 * to decide how a past tool call is drawn; the server decides what needs
 * approval.
 */
const isReadTool = (name: string) => name === 'whoami' || /^(list|get|summarize)_/.test(name)

type Decision = 'approve' | 'reject'

interface ToolOutcome {
  isError: boolean
  text: string
}

type Item =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | { kind: 'lookups'; key: string; names: string[] }
  | { kind: 'action'; key: string; use: ChatBlock; outcome?: ToolOutcome }

function outcomeText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join(' ')
  return ''
}

/** Turn the raw conversation into what the panel draws. */
function toItems(messages: ChatMessage[]): Item[] {
  const outcomes = new Map<string, ToolOutcome>()
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        outcomes.set(b.tool_use_id, { isError: b.is_error === true, text: outcomeText(b.content) })
      }
    }
  }
  const items: Item[] = []
  messages.forEach((m, mi) => {
    if (m.role === 'user') {
      if (isTypedUserMessage(m)) items.push({ kind: 'user', key: `u${mi}`, text: messageText(m) })
      return
    }
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content } as ChatBlock] : m.content
    blocks.forEach((b, bi) => {
      const key = `a${mi}-${bi}`
      if (b.type === 'text' && b.text?.trim() && b.text.trim() !== '…') {
        items.push({ kind: 'assistant', key, text: b.text })
      } else if (b.type === 'tool_use' && b.name && b.id) {
        if (isReadTool(b.name)) {
          const prev = items[items.length - 1]
          if (prev?.kind === 'lookups') prev.names.push(b.name)
          else items.push({ kind: 'lookups', key, names: [b.name] })
        } else {
          items.push({ kind: 'action', key, use: b, outcome: outcomes.get(b.id) })
        }
      }
    })
  })
  return items
}

/** Does the conversation need another server step before it can take new input? */
function needsResume(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1]
  if (!last) return false
  if (last.role === 'user') return true
  return typeof last.content !== 'string' && last.content.some((b) => b.type === 'tool_use')
}

// ---------------------------------------------------------------------------
// Rendering the assistant's text: a small, safe subset of Markdown (bold,
// inline code, lists, tables, headings). Built as React elements — never
// injected as HTML — so nothing in the data can run as markup.
// ---------------------------------------------------------------------------

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} className="rounded bg-[var(--surface-2)] px-1 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      )
    }
    return <Fragment key={i}>{part}</Fragment>
  })
}

function RichText({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n')
  const out: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim())
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells)
        i++
      }
      const [head, ...body] = rows
      out.push(
        <div key={`t${i}`} className="my-2 overflow-x-auto rounded-xl border border-[var(--line)]">
          <table className="w-full text-left text-xs">
            {head && (
              <thead>
                <tr>{head.map((c, ci) => <th key={ci} className="px-2.5 py-1.5">{inline(c)}</th>)}</tr>
              </thead>
            )}
            <tbody className="divide-y divide-[var(--line)]">
              {body.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci} className="px-2.5 py-1.5">{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line)
      const itemsInList: string[] = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        itemsInList.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))
        i++
      }
      const List = ordered ? 'ol' : 'ul'
      out.push(
        <List key={`l${i}`} className={cn('my-1.5 space-y-1 pl-5', ordered ? 'list-decimal' : 'list-disc')}>
          {itemsInList.map((t, ti) => <li key={ti}>{inline(t)}</li>)}
        </List>,
      )
      continue
    }
    if (/^#{1,6}\s+/.test(line)) {
      out.push(<p key={`h${i}`} className="mt-2 font-semibold text-foreground">{inline(line.replace(/^#{1,6}\s+/, ''))}</p>)
      i++
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^\s*(\||[-*•]\s|\d+[.)]\s|#{1,6}\s)/.test(lines[i])) {
      para.push(lines[i])
      i++
    }
    out.push(<p key={`p${i}`} className="my-1.5">{inline(para.join(' '))}</p>)
  }
  return <div className="text-sm leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0">{out}</div>
}

// ---------------------------------------------------------------------------

function fieldLabel(key: string): string {
  const words = key.replace(/_id$/, '').replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function fieldValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  const json = JSON.stringify(value)
  return json.length > 160 ? json.slice(0, 157) + '…' : json
}

function ActionCard({
  title,
  input,
  state,
  outcome,
  decision,
  disabled,
  onDecide,
}: {
  title: string
  input: Record<string, unknown>
  state: 'pending' | 'done' | 'cancelled' | 'failed' | 'waiting'
  outcome?: ToolOutcome
  decision?: Decision
  disabled: boolean
  onDecide?: (d: Decision) => void
}) {
  const fields = Object.entries(input).filter(([, v]) => v !== null && v !== undefined && v !== '')
  return (
    <div
      className={cn(
        'rounded-2xl border p-3.5',
        state === 'pending' ? 'border-brand/40 bg-brand/[.06]' : 'border-[var(--line)] bg-[var(--surface)]',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="ps-label">{state === 'pending' ? 'Needs your approval' : 'Action'}</p>
        {state === 'done' && <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ps-green"><Check className="h-3.5 w-3.5" aria-hidden /> Done</span>}
        {state === 'cancelled' && <span className="font-mono text-[11px] text-muted-foreground">Cancelled</span>}
        {state === 'failed' && <span className="font-mono text-[11px] text-red-600 dark:text-red-400">Didn't work</span>}
      </div>
      <p className="mt-1 text-sm font-semibold">{title}</p>
      {fields.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {fields.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted-foreground">{fieldLabel(k)}</dt>
              <dd className="break-words font-mono tabular-nums">{fieldValue(v)}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {state === 'failed' && outcome?.text && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{outcome.text}</p>}
      {state === 'pending' && onDecide && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={disabled || !!decision} onClick={() => onDecide('approve')}>
            {decision === 'approve' ? 'Approved' : 'Approve'}
          </Button>
          <Button size="sm" variant="outline" disabled={disabled || !!decision} onClick={() => onDecide('reject')}>
            {decision === 'reject' ? 'Cancelled' : 'Cancel'}
          </Button>
        </div>
      )}
    </div>
  )
}

export function AiAssistant() {
  const { user, isAdmin, can, refreshAfterExternalChange } = useStore()
  const userId = user?.id ?? ''
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>(() => (userId ? loadChat(userId) : []))
  const [pending, setPending] = useState<PendingAction[]>([])
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Turns the orb green for a moment after an approved action goes through.
  const [justCompleted, setJustCompleted] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // A different account on this device gets its own chat.
  useEffect(() => {
    setMessages(userId ? loadChat(userId) : [])
    setPending([])
    setDecisions({})
    setError(null)
  }, [userId])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, pending, busy, error, open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const commit = useCallback(
    (next: ChatMessage[]) => {
      setMessages(next)
      if (userId) saveChat(userId, next)
    },
    [userId],
  )

  /** Run server steps until Claude answers or an action needs approval. */
  const drive = useCallback(
    async (start: ChatMessage[], firstDecisions?: Record<string, Decision>) => {
      setBusy(true)
      setError(null)
      setNotice(null)
      setPending([])
      let msgs = start
      let dec = firstDecisions
      const changedData = !!firstDecisions && Object.values(firstDecisions).includes('approve')
      try {
        for (let i = 0; i < MAX_STEPS; i++) {
          const res = await sendStep(msgs, dec)
          dec = undefined
          msgs = res.messages
          commit(msgs)
          if (res.status === 'approval') {
            setDecisions({})
            setPending(res.pending)
            return
          }
          if (res.status === 'done') {
            if (res.notice) setNotice(res.notice)
            return
          }
        }
        setNotice('I paused after several steps. Press Continue to keep going.')
      } catch (e) {
        setError(e instanceof AssistantError ? e.message : 'Something went wrong. Try again.')
      } finally {
        setBusy(false)
        if (changedData) {
          void refreshAfterExternalChange()
          setJustCompleted(true)
          window.setTimeout(() => setJustCompleted(false), 2200)
        }
      }
    },
    [commit, refreshAfterExternalChange],
  )

  const send = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || busy || pending.length) return
    setDraft('')
    const next = [...messages, { role: 'user' as const, content: trimmed }]
    commit(next)
    void drive(next)
  }

  const decide = (id: string, d: Decision) => {
    const next = { ...decisions, [id]: d }
    setDecisions(next)
    if (pending.every((p) => next[p.id])) void drive(messages, next)
  }

  const newChat = () => {
    if (busy) return
    commit([])
    setPending([])
    setDecisions({})
    setError(null)
    setNotice(null)
    inputRef.current?.focus()
  }

  const items = useMemo(() => toItems(messages), [messages])
  const pendingById = useMemo(() => new Map(pending.map((p) => [p.id, p])), [pending])
  const canResume = !busy && !pending.length && needsResume(messages)

  const suggestions = useMemo(() => {
    const base = ['How many hours did I work this week?', "What's on my task board?", 'Start a break']
    if (isAdmin || can('entries.view_all')) base.unshift("Who's on the clock right now?")
    if (isAdmin || can('reports.view')) base.push("Summarize last week's hours by worker")
    return base.slice(0, 4)
  }, [isAdmin, can])

  const orbState: OrbState = busy
    ? 'thinking'
    : error
      ? 'error'
      : pending.length
        ? 'listening'
        : justCompleted
          ? 'complete'
          : 'idle'

  if (!user) return null

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open Nova AI"
          title="Ask Nova AI"
          className="fixed right-4 z-40 flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-[#05070c] shadow-[0_12px_36px_-10px_rgba(255,122,26,.55)] transition-transform duration-300 ease-ps hover:scale-105 active:scale-95 lg:bottom-6 lg:right-6"
          style={{ bottom: 'calc(5rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <NovaOrb size={60} state={busy ? 'thinking' : pending.length ? 'listening' : 'idle'} />
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-label="Nova AI"
          className="ps-modal fixed inset-0 z-50 flex flex-col overflow-hidden lg:inset-auto lg:bottom-6 lg:right-6 lg:h-[min(680px,calc(100vh-3rem))] lg:w-[420px] lg:rounded-3xl"
        >
          <header className="pt-safe flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-[#05070c]">
              <NovaOrb size={44} state={orbState} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-tight">Nova AI</p>
              <p className="ps-label text-[10px]">PipelineSync AI</p>
            </div>
            <Button variant="ghost" size="iconSm" onClick={newChat} disabled={busy || messages.length === 0} aria-label="New chat" title="New chat">
              <SquarePen className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="iconSm" onClick={() => setOpen(false)} aria-label="Close Nova AI">
              <X className="h-4 w-4" />
            </Button>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
            {items.length === 0 && !busy && (
              <div className="space-y-4 pt-2 text-center">
                <NovaOrb size={148} state={orbState} className="mx-auto" />
                <p className="text-base font-semibold">Hi, I'm Nova. What can I help with?</p>
                <p className="mx-auto max-w-[30ch] text-sm text-muted-foreground">
                  Ask about your hours, tasks or pay, or ask me to make a change. I'll always check with you before
                  changing anything.
                </p>
                <div className="flex flex-col items-stretch gap-2 pt-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-left text-sm transition-colors hover:border-[var(--line-2)] hover:bg-[var(--surface-2)]"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {items.map((item) => {
              if (item.kind === 'user') {
                return (
                  <div key={item.key} className="flex justify-end">
                    <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand/15 px-3.5 py-2 text-sm">{item.text}</p>
                  </div>
                )
              }
              if (item.kind === 'assistant') {
                return (
                  <div key={item.key} className="max-w-[95%]">
                    <RichText text={item.text} />
                  </div>
                )
              }
              if (item.kind === 'lookups') {
                const names = [...new Set(item.names)].map((n) => toolLabel(n).toLowerCase())
                return (
                  <p key={item.key} className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                    <Search className="h-3 w-3 shrink-0" aria-hidden /> Looked up {names.join(', ')}
                  </p>
                )
              }
              const id = item.use.id as string
              const live = pendingById.get(id)
              const state = live
                ? 'pending'
                : !item.outcome
                  ? 'waiting'
                  : !item.outcome.isError
                    ? 'done'
                    : item.outcome.text.startsWith('The user declined')
                      ? 'cancelled'
                      : 'failed'
              return (
                <ActionCard
                  key={item.key}
                  title={live?.title ?? toolLabel(item.use.name as string)}
                  input={(item.use.input ?? {}) as Record<string, unknown>}
                  state={state}
                  outcome={item.outcome}
                  decision={decisions[id]}
                  disabled={busy}
                  onDecide={live ? (d) => decide(id, d) : undefined}
                />
              )
            })}

            {busy && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <NovaOrb size={22} state="thinking" /> Working on it…
              </p>
            )}
            {notice && <p className="rounded-xl bg-[var(--surface-2)] px-3 py-2 text-xs text-muted-foreground">{notice}</p>}
            {error && (
              <p role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {error}
              </p>
            )}
            {canResume && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void drive(messages)}>
                <RotateCcw className="h-3.5 w-3.5" /> Continue
              </Button>
            )}
          </div>

          <form
            className="pb-safe border-t border-[var(--line)] p-3"
            onSubmit={(e) => {
              e.preventDefault()
              send(draft)
            }}
          >
            {pending.length > 0 && (
              <p className="mb-2 text-xs text-muted-foreground">Approve or cancel the action above to continue.</p>
            )}
            <div className="flex items-end gap-2">
              <label htmlFor="ai-assistant-input" className="sr-only">
                Message Nova AI
              </label>
              <textarea
                id="ai-assistant-input"
                ref={inputRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send(draft)
                  }
                }}
                placeholder={pending.length ? 'Waiting for your approval…' : 'Ask about your time, tasks or pay…'}
                disabled={busy || pending.length > 0}
                className="ps-field max-h-32 min-h-[44px] flex-1 resize-none px-3 py-2.5 text-sm"
              />
              <Button
                type="submit"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={busy || pending.length > 0 || !draft.trim()}
                aria-label="Send"
              >
                <ArrowUp className="h-5 w-5" />
              </Button>
            </div>
            <p className="mt-1.5 text-center text-[10.5px] text-muted-foreground">
              AI can make mistakes. Check before you approve a change.
            </p>
          </form>
        </section>
      )}
    </>
  )
}
