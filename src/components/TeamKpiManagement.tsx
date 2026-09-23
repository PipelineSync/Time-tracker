import { useEffect, useState } from 'react'
import type { BonusDecision, KpiAuditEvent, MonthlyGoal, Worker } from '@/lib/types'
import { useStore } from '@/lib/store'
import { KPI_TARGETS, fmtPct, effectiveBonus } from '@/lib/kpi'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AvatarBubble } from '@/components/AvatarBubble'
import { History, Target, Wallet } from 'lucide-react'
import { toast } from 'sonner'

/**
 * Monthly targets (management input §14): the only numbers people type are
 * the planned task count and role-specific on-time/QA targets. KPI scores are
 * computed — never entered.
 */
export function MonthlyTargetsCard({
  employees,
  month,
  goals,
  onSave,
}: {
  employees: Worker[]
  month: string
  goals: MonthlyGoal[]
  onSave: (input: { worker_id: string; month: string; target: number | null; on_time_target: number | null; qa_target: number | null; note: string | null }) => Promise<unknown>
}) {
  const { can } = useStore()
  const editable = can('team_kpi.view')
  const [drafts, setDrafts] = useState<Record<string, { target: string; onTime: string; qa: string }>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  useEffect(() => {
    const next: Record<string, { target: string; onTime: string; qa: string }> = {}
    for (const w of employees) {
      const g = goals.find((x) => x.worker_id === w.id && x.month === month)
      next[w.id] = {
        target: g?.target != null ? String(g.target) : '',
        onTime: String(g?.on_time_target ?? KPI_TARGETS.onTime),
        qa: String(g?.qa_target ?? KPI_TARGETS.qa),
      }
    }
    setDrafts(next)
  }, [employees, goals, month])

  async function save(workerId: string) {
    const d = drafts[workerId]
    if (!d) return
    const target = d.target.trim() === '' ? null : Number(d.target)
    const onTime = d.onTime.trim() === '' ? null : Number(d.onTime)
    const qa = d.qa.trim() === '' ? null : Number(d.qa)
    if (target !== null && (!Number.isFinite(target) || target < 0)) return toast.error('Planned target must be 0 or more.')
    if (onTime !== null && (!Number.isFinite(onTime) || onTime < 0 || onTime > 100)) return toast.error('On-time target must be 0–100.')
    if (qa !== null && (!Number.isFinite(qa) || qa < 0 || qa > 100)) return toast.error('QA target must be 0–100.')
    setSavingId(workerId)
    try {
      await onSave({
        worker_id: workerId,
        month,
        target,
        on_time_target: onTime,
        qa_target: qa,
        note: null,
      })
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="h-4 w-4 text-primary" /> Monthly targets
          {!editable && <Badge variant="muted" className="text-[10px]">Read-only</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {employees.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No employees in scope.</p>
        )}
        {employees.map((w) => {
          const d = drafts[w.id]
          if (!d) return null
          return (
            <div key={w.id} className="grid grid-cols-1 items-end gap-2 rounded-xl border p-3 sm:grid-cols-[1fr,110px,110px,110px,auto]">
              <div className="flex min-w-0 items-center gap-2">
                <AvatarBubble name={w.name} avatarUrl={w.avatar_url} color={w.color} className="h-7 w-7 text-[10px]" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{w.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{w.position || 'Team member'}</p>
                </div>
              </div>
              <div className="grid gap-1">
                <Label className="text-[10px] text-muted-foreground">Tasks plan</Label>
                <Input
                  type="number"
                  min="0"
                  value={d.target}
                  disabled={!editable}
                  onChange={(e) => setDrafts((p) => ({ ...p, [w.id]: { ...d, target: e.target.value } }))}
                  placeholder="—"
                  className="h-8"
                />
              </div>
              <div className="grid gap-1">
                <Label className="text-[10px] text-muted-foreground">On-time %</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={d.onTime}
                  disabled={!editable}
                  onChange={(e) => setDrafts((p) => ({ ...p, [w.id]: { ...d, onTime: e.target.value } }))}
                  className="h-8"
                />
              </div>
              <div className="grid gap-1">
                <Label className="text-[10px] text-muted-foreground">QA %</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={d.qa}
                  disabled={!editable}
                  onChange={(e) => setDrafts((p) => ({ ...p, [w.id]: { ...d, qa: e.target.value } }))}
                  className="h-8"
                />
              </div>
              <Button
                size="sm"
                disabled={!editable || savingId === w.id}
                onClick={() => void save(w.id)}
              >
                {savingId === w.id ? '…' : 'Save'}
              </Button>
            </div>
          )
        })}
        <p className="text-[11px] text-muted-foreground">
          Defaults: on-time {KPI_TARGETS.onTime}% · QA {KPI_TARGETS.qa}% · rework ≤{KPI_TARGETS.rework}% · goal
          achievement {KPI_TARGETS.goal}%+ of the plan. Mary’s role uses a 95% on-time target.
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * Bonus safety (§12): eligibility + approved amount are a manual, Owner-only
 * decision with an audit trail — the KPI score never sets money itself.
 */
export function BonusDecisionsCard({
  employees,
  month,
  decisions,
  onSave,
}: {
  employees: Worker[]
  month: string
  decisions: BonusDecision[]
  onSave: (input: { worker_id: string; month: string; eligible: BonusDecision['eligible']; approved_amount: number | null; note: string | null }) => Promise<unknown>
}) {
  const { isAdmin } = useStore()
  const [drafts, setDrafts] = useState<Record<string, { eligible: string; amount: string }>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  useEffect(() => {
    const next: Record<string, { eligible: string; amount: string }> = {}
    for (const w of employees) {
      const b = effectiveBonus(decisions, w.id, month)
      next[w.id] = {
        eligible: b?.eligible ?? 'pending',
        amount: b?.approved_amount != null ? String(b.approved_amount) : '',
      }
    }
    setDrafts(next)
  }, [employees, decisions, month])

  async function save(workerId: string) {
    const d = drafts[workerId]
    if (!d) return
    const amount = d.amount.trim() === '' ? null : Number(d.amount)
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return toast.error('Amount must be 0 or more.')
    setSavingId(workerId)
    try {
      await onSave({
        worker_id: workerId,
        month,
        eligible: d.eligible === 'yes' || d.eligible === 'no' ? d.eligible : 'pending',
        approved_amount: amount,
        note: null,
      })
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4 text-emerald-600" /> Bonus decisions
          <Badge variant="muted" className="text-[10px]">Owner only</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {employees.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No employees in scope.</p>
        )}
        {employees.map((w) => {
          const d = drafts[w.id]
          if (!d) return null
          const decision = effectiveBonus(decisions, w.id, month)
          return (
            <div key={w.id} className="grid grid-cols-1 items-end gap-2 rounded-xl border p-3 sm:grid-cols-[1fr,130px,130px,auto]">
              <div className="flex min-w-0 items-center gap-2">
                <AvatarBubble name={w.name} avatarUrl={w.avatar_url} color={w.color} className="h-7 w-7 text-[10px]" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{w.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {decision
                      ? decision.eligible === 'pending'
                        ? 'Pending — not yet decided'
                        : decision.eligible === 'yes'
                          ? `Eligible${decision.approved_amount != null ? ` · approved ${decision.approved_amount}` : ''}`
                          : 'Not eligible'
                      : 'No decision yet — Pending'}
                  </p>
                </div>
              </div>
              <div className="grid gap-1">
                <Label className="text-[10px] text-muted-foreground">Eligible</Label>
                <Select
                  value={d.eligible}
                  disabled={!isAdmin}
                  onValueChange={(v) => setDrafts((p) => ({ ...p, [w.id]: { ...d, eligible: v } }))}
                >
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="yes">Yes</SelectItem>
                    <SelectItem value="no">No</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1">
                <Label className="text-[10px] text-muted-foreground">Approved amount</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={d.amount}
                  disabled={!isAdmin}
                  onChange={(e) => setDrafts((p) => ({ ...p, [w.id]: { ...d, amount: e.target.value } }))}
                  placeholder="—"
                  className="h-8"
                />
              </div>
              <Button
                size="sm"
                disabled={!isAdmin || savingId === w.id}
                onClick={() => void save(w.id)}
                title={isAdmin ? 'Record this decision' : 'Only the Owner can edit bonus decisions'}
              >
                {savingId === w.id ? '…' : 'Approve'}
              </Button>
            </div>
          )
        })}
        <p className="text-[11px] text-muted-foreground">
          KPI scores never set pay automatically — eligibility and amounts are recorded here (with an
          audit line) so every approval has a person and a time attached.
        </p>
      </CardContent>
    </Card>
  )
}

/** KPI audit history (§12): QA scores, rework, due changes, completions, approvals. */
export function KpiAuditCard({ events }: { events: KpiAuditEvent[] }) {
  const rows = events.slice(0, 30)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4 text-muted-foreground" /> KPI audit history
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No audit events yet — QA reviews, due-date changes and bonus approvals will appear here.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm">{e.detail || e.action}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {e.action.replace(/_/g, ' ')} · {e.actor || 'system'}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {new Date(e.created_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/** Re-export so the page can show a one-liner without importing kpi twice. */
export { fmtPct }
