import { useMemo, useRef, useState } from 'react'
import {
  Building2,
  GripVertical,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import type { Client, ClientPriorityLane } from '@/lib/types'
import { CLIENT_PRIORITY_LANES, ClientPriorityLaneNames, ClientPriorityLaneStyles, ClientColorStyles } from '@/lib/types'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { cn } from '@/lib/utils'

/**
 * The client priority board: every ACTIVE client sits in one of four fixed
 * columns. Dragging between columns sets the client's stage; dragging up or
 * down inside a column ranks it (top = highest priority). Each drag is one
 * row in `client_priorities` saved through the store — the board "saves
 * automatically" because there is nothing to save: the rows ARE the board.
 *
 * Clients without a row are unranked and render at the bottom of Low Priority
 * (A→Z), so a brand-new client appears on the board by itself and "Reset
 * board" simply deletes every row. Inactive clients are not prioritised, so
 * they stay off the board entirely.
 */
export function ClientPriorityBoardPage() {
  const { clients, clientPriorities, activeClients, isAdmin, dataLoading, moveClientPriority, resetClientPriorities } = useStore()

  const [resetOpen, setResetOpen] = useState(false)

  // Drag state — identical to the Tasks board: `dragging` is the card under
  // the pointer, `dropTarget` the lane (and index) it would land in. The ref
  // mirrors `dragging` synchronously because dragover fires before React has
  // re-rendered, and a background poll landing mid-drag must not make the
  // handlers think nothing is being dragged.
  const draggingRef = useRef<Client | null>(null)
  const [dragging, setDragging] = useState<Client | null>(null)
  const [dropTarget, setDropTarget] = useState<{ lane: ClientPriorityLane; index: number } | null>(null)

  function startDrag(client: Client) {
    draggingRef.current = client
    setDragging(client)
  }

  function endDrag() {
    draggingRef.current = null
    setDragging(null)
    setDropTarget(null)
  }

  // The lane row scrolls sideways when the columns do not all fit; dragging a
  // card to either edge nudges it along so cross-board drops stay possible.
  const rowRef = useRef<HTMLDivElement | null>(null)
  function edgeScroll(e: React.DragEvent<HTMLDivElement>) {
    const row = rowRef.current
    if (!row || !draggingRef.current) return
    const box = row.getBoundingClientRect()
    const edge = 72
    if (e.clientX < box.left + edge) row.scrollLeft -= 18
    else if (e.clientX > box.right - edge) row.scrollLeft += 18
  }

  const priorityOf = (clientId: string) => clientPriorities.find((p) => p.client_id === clientId) ?? null

  /**
   * What the board shows: active clients grouped by lane. Ranked clients sort
   * by their row's position; unranked ones append to the bottom of Low
   * Priority, A→Z, until someone drags them.
   */
  const lanes = useMemo(() => {
    const result = Object.fromEntries(CLIENT_PRIORITY_LANES.map((l) => [l, [] as Client[]])) as Record<ClientPriorityLane, Client[]>
    const unranked: Client[] = []
    for (const c of activeClients) {
      const p = priorityOf(c.id)
      if (p && result[p.lane]) result[p.lane].push(c)
      else unranked.push(c)
    }
    for (const lane of CLIENT_PRIORITY_LANES) {
      result[lane].sort((a, b) => (priorityOf(a.id)?.position ?? 0) - (priorityOf(b.id)?.position ?? 0))
    }
    result.low.push(...unranked.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })))
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClients, clientPriorities])

  /** Commit a drop: the client goes into `lane` at rendered index `index`. */
  function moveTo(client: Client, lane: ClientPriorityLane, index: number) {
    const rendered = lanes[lane].filter((c) => c.id !== client.id)
    const target = Math.max(0, Math.min(index, rendered.length))
    const current = lanes[lane].findIndex((c) => c.id === client.id)
    // Dropping a card exactly where it already sits is a no-op.
    if (priorityOf(client.id)?.lane === lane && current === target) return
    // The drop index counts unranked cards too (they render in the lane), but
    // positions only exist for ranked rows — so the client slots in after the
    // ranked cards above the drop point. Dropping into the unranked tail
    // ranks it just above that tail, which is what the gesture promises.
    const rankedCount = rendered.filter((c) => priorityOf(c.id)).length
    const position = Math.min(rendered.slice(0, target).filter((c) => priorityOf(c.id)).length, rankedCount)
    void moveClientPriority(client.id, lane, position)
  }

  function commitDrop(lane: ClientPriorityLane, index: number) {
    const client = draggingRef.current
    endDrag()
    if (!client) return
    moveTo(client, lane, dropTarget?.lane === lane ? dropTarget.index : index)
  }

  /** Keyboard / touch fallback: rank one spot up/down, or jump one lane over. */
  function nudge(client: Client, lane: ClientPriorityLane, direction: 'up' | 'down' | 'left' | 'right') {
    const index = lanes[lane].findIndex((c) => c.id === client.id)
    if (direction === 'up') return moveTo(client, lane, index - 1)
    if (direction === 'down') return moveTo(client, lane, index + 1)
    const i = CLIENT_PRIORITY_LANES.indexOf(lane)
    const next = CLIENT_PRIORITY_LANES[i + (direction === 'right' ? 1 : -1)]
    if (!next) return
    // Lanes over: the bottom of the destination, unless dropping below the
    // card's own rank would be more faithful — bottom is the simplest promise.
    moveTo(client, next, lanes[next].length)
  }

  function onReset() {
    return resetClientPriorities().then(() => undefined)
  }

  /**
   * A card, rendered as a plain function call rather than a nested component
   * (same reason as the Tasks board: a nested component type would be
   * re-created every render and unmount the very node the browser is
   * dragging, killing the drag on the first attempt).
   */
  function renderCard({ client, index, lane }: { client: Client; index: number; lane: ClientPriorityLane }) {
    const style = ClientPriorityLaneStyles[lane]
    return (
      <div
        draggable
        onDragStart={(e) => {
          startDrag(client)
          e.dataTransfer.effectAllowed = 'move'
          // Firefox refuses to start a drag without data on the transfer.
          e.dataTransfer.setData('text/plain', client.id)
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          if (!draggingRef.current) return
          e.preventDefault()
          e.stopPropagation()
          // Drop above or below this card depending on which half we are over.
          const box = e.currentTarget.getBoundingClientRect()
          const after = e.clientY - box.top > box.height / 2
          setDropTarget({ lane, index: after ? index + 1 : index })
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          commitDrop(lane, dropTarget?.lane === lane ? dropTarget.index : index)
        }}
        className={cn(
          'group cursor-grab select-none rounded-lg border border-l-4 bg-card px-2.5 py-2 shadow-sm transition active:cursor-grabbing',
          'hover:shadow-md',
          style.accent,
          dragging?.id === client.id && 'opacity-40',
        )}
      >
        <div className="flex items-center gap-2">
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden />
          <span className={cn('h-2 w-2 shrink-0 rounded-full', ClientColorStyles[client.color].dot)} aria-hidden />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{client.name}</p>
        </div>

        {/* Touch-friendly alternatives to dragging — a phone has no drag, but
            on a mouse pointer the cards stay as clean as the design (the
            buttons only appear where dragging cannot work). */}
        <div className="mt-1 hidden items-center justify-between gap-1 border-t pt-1 [@media(pointer:coarse)]:flex">
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={index === 0}
              aria-label={`Rank "${client.name}" one spot higher`}
              onClick={() => nudge(client, lane, 'up')}
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={index === lanes[lane].length - 1}
              aria-label={`Rank "${client.name}" one spot lower`}
              onClick={() => nudge(client, lane, 'down')}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={lane === CLIENT_PRIORITY_LANES[0]}
              aria-label={`Move "${client.name}" to the previous column`}
              onClick={() => nudge(client, lane, 'left')}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={lane === CLIENT_PRIORITY_LANES[CLIENT_PRIORITY_LANES.length - 1]}
              aria-label={`Move "${client.name}" to the next column`}
              onClick={() => nudge(client, lane, 'right')}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  function renderLane(lane: ClientPriorityLane) {
    const style = ClientPriorityLaneStyles[lane]
    const items = lanes[lane]
    const isTarget = dropTarget?.lane === lane
    return (
      <div
        key={lane}
        onDragOver={(e) => {
          if (!draggingRef.current) return
          e.preventDefault()
          // Empty space below the cards drops at the end of the lane.
          if (!isTarget) setDropTarget({ lane, index: items.length })
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropTarget((prev) => (prev?.lane === lane ? null : prev))
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          commitDrop(lane, isTarget ? dropTarget.index : items.length)
        }}
        className={cn(
          // One lane of the row: its own framed card, sharing the board evenly
          // when there is room, scrolling sideways (one snapped lane at a time)
          // when there is not.
          'flex min-h-[14rem] flex-[1_0_15.5rem] snap-start flex-col rounded-xl border bg-background/70 px-2.5 py-2 transition',
          dragging && 'bg-muted/40',
          isTarget && cn('bg-muted ring-2', style.ring),
        )}
      >
        <div className="mb-3 flex items-center gap-2 px-1 pt-1">
          <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', style.dot)} aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{ClientPriorityLaneNames[lane]}</h2>
          <Badge variant="muted" className="text-[10px]">{items.length}</Badge>
        </div>

        <div className="flex flex-1 flex-col gap-2">
          {items.map((client, index) => (
            <div key={client.id}>
              {isTarget && dropTarget.index === index && (
                <div className="mb-2 h-1.5 rounded-full bg-primary/60" aria-hidden />
              )}
              {renderCard({ client, index, lane })}
            </div>
          ))}
          {isTarget && dropTarget.index >= items.length && (
            <div className="h-1.5 rounded-full bg-primary/60" aria-hidden />
          )}

          {items.length === 0 && !isTarget && (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">
              Drag a client here
            </div>
          )}
        </div>
      </div>
    )
  }

  const showSkeleton = dataLoading && clients.length === 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Client priority board"
        description="Drag between columns to set status. Drag up or down inside a column to rank it: top is highest priority, bottom is lowest. Saves automatically."
      >
        <Button variant="outline" disabled={clients.length === 0} onClick={() => setResetOpen(true)}>
          <RotateCcw className="mr-2 h-4 w-4" /> Reset board
        </Button>
      </PageHeader>

      {showSkeleton ? (
        <div className="rounded-2xl border bg-muted/30 p-2 sm:p-3">
          <div className="flex gap-2 overflow-hidden">
            {CLIENT_PRIORITY_LANES.map((lane) => (
              <Skeleton key={lane} className="h-56 flex-[1_0_15.5rem] rounded-xl" />
            ))}
          </div>
        </div>
      ) : activeClients.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No active clients yet"
          description={
            isAdmin
              ? 'Add clients from the Tasks page (Clients), and they will show up here ready to rank.'
              : 'The admin has not added any clients yet, so there is nothing to rank.'
          }
        />
      ) : (
        // Horizontal board: the four lanes sit side by side inside one framed
        // board. When the row is wider than the screen it scrolls sideways,
        // one snapped lane at a time.
        <div className="rounded-2xl border bg-muted/30 p-2 sm:p-3">
          <div
            ref={rowRef}
            onDragOver={edgeScroll}
            className="flex snap-x snap-mandatory gap-2 overflow-x-auto"
          >
            {CLIENT_PRIORITY_LANES.map((lane) => renderLane(lane))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={(v) => !v && setResetOpen(false)}
        title="Reset the board?"
        description="Every client goes back to the bottom of Low Priority, ranked A→Z, and the columns start empty. The clients themselves are not changed."
        confirmLabel="Reset board"
        onConfirm={onReset}
      />
    </div>
  )
}
