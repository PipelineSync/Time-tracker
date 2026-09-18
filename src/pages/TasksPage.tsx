import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Building2 } from 'lucide-react'
import { useStore } from '@/lib/store'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { ManageClientsDialog } from '@/components/ManageClientsDialog'
import { TaskBoard } from '@/components/TaskBoard'
import { boardFiltersFromParams, type BoardFilters } from '@/lib/taskFilters'

/**
 * The Tasks page: the full board with its archive tab. The board itself is
 * the shared TaskBoard component — the Dashboard's stat cards, focus rows and
 * workload rows land here with their filter pre-applied via the query string.
 */
export function TasksPage() {
  const { can } = useStore()
  const canViewAll = can('tasks.view_all')

  const [searchParams] = useSearchParams()
  const [filters, setFilters] = useState<BoardFilters>(() => boardFiltersFromParams(searchParams))

  // Arriving from the dashboard (or a shared link) with ?overdue=1&… re-scopes
  // the board. In-page filter changes never touch the URL, so this only fires
  // on navigation.
  useEffect(() => {
    setFilters(boardFiltersFromParams(searchParams))
  }, [searchParams])

  const [clientsOpen, setClientsOpen] = useState(false)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description={
          canViewAll
            ? "Every worker's board. Drag a card between stages to update it."
            : 'Your board. Drag a card between stages as you work through it.'
        }
      >
        {can('clients.manage') && (
          <Button variant="outline" onClick={() => setClientsOpen(true)}>
            <Building2 className="mr-2 h-4 w-4" /> Clients
          </Button>
        )}
      </PageHeader>

      <TaskBoard filters={filters} onFiltersChange={setFilters} showArchive />

      {can('clients.manage') && <ManageClientsDialog open={clientsOpen} onOpenChange={setClientsOpen} />}
    </div>
  )
}
