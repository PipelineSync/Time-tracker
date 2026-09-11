import { useMemo, useState } from 'react'
import { Pencil, Pin, PinOff, Plus, Search, StickyNote, Trash2 } from 'lucide-react'
import { useStore } from '@/lib/store'
import type { Note } from '@/lib/types'
import { NoteColorStyles } from '@/lib/types'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { NoteFormDialog } from '@/components/NoteFormDialog'
import { cn, formatDateTime } from '@/lib/utils'

/** How a note is named in aria labels: its title, or the start of its body. */
function nameOf(note: Note): string {
  return note.title || note.body.slice(0, 40) || 'note'
}

/**
 * The Notepad: every account's own private scratchpad. The admin and each
 * worker have their separate notepads; the backend only ever returns the
 * signed-in user's notes, so what you see here is yours alone. Pinned notes
 * float to the top; everything else sorts newest edit first. Search filters
 * title and body as you type.
 */
export function NotepadPage() {
  const { notes, dataLoading, updateNote, deleteNote } = useStore()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Note | null>(null)
  const [deleting, setDeleting] = useState<Note | null>(null)
  const [query, setQuery] = useState('')

  // Search narrows both the pinned and the unpinned group by title or body.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return notes
    return notes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
  }, [notes, query])

  const pinned = filtered.filter((n) => n.pinned)
  const others = filtered.filter((n) => !n.pinned)
  // Group labels only make sense when there are two groups to tell apart.
  const showLabels = pinned.length > 0 && others.length > 0

  function openNew() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(note: Note) {
    setEditing(note)
    setFormOpen(true)
  }

  function renderCard(note: Note) {
    const color = NoteColorStyles[note.color]
    return (
      <div
        key={note.id}
        role="button"
        tabIndex={0}
        aria-label={`Edit "${nameOf(note)}"`}
        onClick={() => openEdit(note)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openEdit(note)
          }
        }}
        className={cn(
          'group mb-3 break-inside-avoid cursor-pointer rounded-xl border bg-card p-3 shadow-sm transition hover:shadow-md',
          color.card,
        )}
      >
        <div className="flex items-start justify-between gap-2">
          {note.title ? (
            <p className="min-w-0 flex-1 break-words text-sm font-semibold">{note.title}</p>
          ) : (
            <span className="flex-1" aria-hidden />
          )}
          {/* Card tools: revealed on hover for mouse users, always there on
              touch (same pattern as the invoicing board's action row). */}
          <div
            className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={note.pinned ? `Unpin "${nameOf(note)}"` : `Pin "${nameOf(note)}"`}
              aria-pressed={note.pinned}
              onClick={() => void updateNote(note.id, { pinned: !note.pinned })}
            >
              {note.pinned ? <Pin className="h-3.5 w-3.5 fill-current" /> : <PinOff className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={`Edit "${nameOf(note)}"`}
              onClick={() => openEdit(note)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              aria-label={`Delete "${nameOf(note)}"`}
              onClick={() => setDeleting(note)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {note.body && (
          <p className={cn('break-words text-sm text-muted-foreground line-clamp-6 whitespace-pre-line', note.title && 'mt-1')}>
            {note.body}
          </p>
        )}

        <p className="mt-2 text-[11px] text-muted-foreground/70">
          {note.created_at !== note.updated_at ? `Edited ${formatDateTime(note.updated_at)}` : formatDateTime(note.created_at)}
        </p>
      </div>
    )
  }

  function renderGrid(group: Note[]) {
    // CSS columns give the staggered sticky-note wall without any measuring;
    // `break-inside-avoid` keeps a card whole across the column breaks.
    return <div className="columns-1 gap-3 sm:columns-2 xl:columns-3 2xl:columns-4">{group.map(renderCard)}</div>
  }

  const showSkeleton = dataLoading && notes.length === 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notepad"
        description="Your private scratchpad — only you can see these notes. Pinned notes stay on top."
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes…"
            aria-label="Search notes"
            className="w-[200px] pl-8"
          />
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" /> New note
        </Button>
      </PageHeader>

      {showSkeleton ? (
        <div className="columns-1 gap-3 sm:columns-2 xl:columns-3 2xl:columns-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className={cn('mb-3 break-inside-avoid rounded-xl', i % 3 === 0 ? 'h-40' : 'h-28')} />
          ))}
        </div>
      ) : notes.length === 0 ? (
        <EmptyState
          icon={StickyNote}
          title="No notes yet"
          description="Jot anything down — reminders, ideas, links. Your notepad is private: nobody else can read it."
          action={<Button onClick={openNew}><Plus className="mr-2 h-4 w-4" /> New note</Button>}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No notes match your search"
          description={`Nothing in your notepad mentions "${query.trim()}".`}
          action={<Button variant="outline" onClick={() => setQuery('')}>Clear search</Button>}
        />
      ) : (
        <>
          {pinned.length > 0 && (
            <section aria-label="Pinned notes">
              {showLabels && (
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Pinned
                </h2>
              )}
              {renderGrid(pinned)}
            </section>
          )}
          {others.length > 0 && (
            <section aria-label="Other notes">
              {showLabels && (
                <h2 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Others
                </h2>
              )}
              {renderGrid(others)}
            </section>
          )}
        </>
      )}

      <NoteFormDialog open={formOpen} onOpenChange={setFormOpen} note={editing} />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Delete this note?"
        description={deleting ? `"${nameOf(deleting)}" will be removed from your notepad. This cannot be undone.` : ''}
        onConfirm={async () => {
          if (deleting) await deleteNote(deleting.id)
          setDeleting(null)
        }}
      />
    </div>
  )
}
