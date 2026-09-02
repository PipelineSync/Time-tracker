import { useNavigate } from 'react-router-dom'
import { Crown, UserRound, Users } from 'lucide-react'
import { AvatarBubble } from '@/components/AvatarBubble'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { roleLabel } from '@/lib/chat'
import { cn } from '@/lib/utils'
import type { ChatMember } from '@/lib/types'

/**
 * "See all members": everyone who can post in the team chat. The admin is always
 * listed first, and the list is identical for workers — a worker sees the whole
 * team here (including the admin) even though the rest of their data access is
 * limited to their own records.
 */
export function ChatMembersDialog({
  open,
  onOpenChange,
  members,
  loading,
  currentUserId,
  currentWorkerId,
  isAdmin,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  members: ChatMember[]
  loading?: boolean
  currentUserId: string | null
  currentWorkerId: string | null
  isAdmin: boolean
}) {
  const navigate = useNavigate()
  const admin = members.find((m) => m.role === 'admin') ?? null
  const team = members.filter((m) => m.role !== 'admin')

  const isSelf = (m: ChatMember) =>
    Boolean((m.user_id && m.user_id === currentUserId) || (m.worker_id && m.worker_id === currentWorkerId))

  const MemberRow = ({ m }: { m: ChatMember }) => (
    <li
      className={cn(
        'flex items-center gap-3 rounded-lg border p-3',
        isSelf(m) ? 'border-primary/40 bg-primary/5' : 'bg-card'
      )}
    >
      <AvatarBubble name={m.name} avatarUrl={m.avatar_url} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-semibold">{m.name}</p>
          {m.role === 'admin' ? (
            <Badge className="gap-1 border-transparent bg-primary text-primary-foreground">
              <Crown className="h-3 w-3" /> Admin
            </Badge>
          ) : (
            <Badge variant="muted">{roleLabel(m.role, m.position)}</Badge>
          )}
          {isSelf(m) && <Badge variant="outline">You</Badge>}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {m.role === 'admin'
            ? 'Workspace owner · posts as Admin'
            : [m.position?.trim() || 'Team member', m.worker_status === 'inactive' ? 'Inactive account' : null]
                .filter(Boolean)
                .join(' · ')}
        </p>
      </div>
    </li>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserRound className="h-4 w-4" /> All members
            {!loading && members.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">({members.length})</span>
            )}
          </DialogTitle>
          <DialogDescription>
            Everyone in the team chat{admin ? ', including the admin' : ''}. Names, roles and profile pictures come
            from each member&apos;s profile.
          </DialogDescription>
        </DialogHeader>

        {loading && members.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading members…</p>
        ) : members.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Users className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No members could be loaded. Refresh the page — the member list comes from your workspace.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {admin && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Admin</p>
                <ul className="space-y-2">
                  <MemberRow m={admin} />
                </ul>
              </div>
            )}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {admin ? 'Workers' : 'Team'} ({team.length})
              </p>
              {team.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No workers yet.{' '}
                  {isAdmin ? 'Add workers from the Workers page to chat with them.' : 'Your manager has not added any teammates yet.'}
                </p>
              ) : (
                <ul className="max-h-[45vh] space-y-2 overflow-y-auto pr-0.5">
                  {team.map((m) => (
                    <MemberRow key={m.id} m={m} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            {isAdmin
              ? 'Workers can see you here, so add a profile picture in Settings to be recognizable.'
              : 'Upload your profile picture in Settings so your manager recognizes you in the chat.'}
          </p>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onOpenChange(false)
                navigate('/workers')
              }}
            >
              <Users className="mr-1 h-4 w-4" /> Manage workers
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
