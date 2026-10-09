import type { Invoice, InvoiceBasis, InvoiceStatus } from './types'
import { INVOICE_BASES, INVOICE_STATUSES } from './types'
import { invoiceStatus } from './invoiceCycles'
import { monthKeyOf } from './finance'
import { monthKeyOfISO, monthLastDay, monthOptions } from './monthScope'
import { storage } from './storage'

/**
 * Invoicing helpers for the board and its verification script. The rules that
 * decide what an invoice does live in `invoiceCycles`; these read the board.
 *
 * An invoice bills one of three things (its basis): a regular client, a
 * project, or an Upwork client. The board's switch narrows the view to one of
 * them, and the totals above it cover everything.
 */

/** The board's switch: which kind of invoice the board shows. */
export const InvoiceBasisLabels: Record<InvoiceBasis, string> = {
  client: 'Regular clients',
  project: 'Project-based clients',
  upwork: 'Upwork clients',
}

/** The invoices a basis choice leaves on the board. */
export function filterInvoicesByBasis(invoices: Invoice[], basis: InvoiceBasis): Invoice[] {
  return invoices.filter((inv) => inv.basis === basis)
}

/** How many invoices a basis choice would leave on the board. */
export function countInvoicesByBasis(invoices: Invoice[], basis: InvoiceBasis): number {
  return invoices.reduce((count, inv) => (inv.basis === basis ? count + 1 : count), 0)
}

/**
 * The choice is remembered per device (next to the theme), so the board opens
 * where it was left. Anything unreadable — including the retired "all" view —
 * opens on regular clients.
 */
const BASIS_KEY = 'wt_invoice_basis_filter'

export function readInvoiceBasis(): InvoiceBasis {
  const saved = storage.getItem(BASIS_KEY)
  return INVOICE_BASES.includes(saved as InvoiceBasis) ? (saved as InvoiceBasis) : 'client'
}

export function writeInvoiceBasis(basis: InvoiceBasis): void {
  storage.setItem(BASIS_KEY, basis)
}

/** The board lanes: every invoice in the lane its status puts it in, due soonest on top. */
export function groupInvoicesByStatus(invoices: Invoice[], today: string): Record<InvoiceStatus, Invoice[]> {
  const groups = Object.fromEntries(INVOICE_STATUSES.map((s) => [s, [] as Invoice[]])) as Record<InvoiceStatus, Invoice[]>
  for (const inv of invoices) groups[invoiceStatus(inv.stage, inv.due_date, today)].push(inv)
  for (const status of INVOICE_STATUSES) {
    groups[status].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.created_at.localeCompare(b.created_at))
  }
  return groups
}

/** The 'YYYY-MM' month `delta` months away from `ym`. */
export function shiftMonth(ym: string, delta: number): string {
  const [year, month] = ym.split('-').map(Number)
  return monthKeyOf(new Date(year, month - 1 + delta, 1))
}

/** The month an invoice is planned in: the month it is due. */
export function invoiceMonthKey(invoice: Invoice): string {
  return monthKeyOfISO(invoice.due_date)
}

/**
 * Whether an invoice belongs on the board for `month` ('YYYY-MM', or 'all').
 * A paid invoice belongs to the month it was paid in. An open one belongs to
 * the month it is due in and stays on every later month's board until it is
 * paid, so nothing owed drops out of view.
 */
export function invoiceOnMonthBoard(invoice: Invoice, month: string): boolean {
  if (month === 'all') return true
  if (invoice.stage === 'paid') return (monthKeyOfISO(invoice.paid_on) || invoiceMonthKey(invoice)) === month
  return invoiceMonthKey(invoice) <= month
}

/** The invoices a month's board shows. */
export function invoicesOnMonthBoard(invoices: Invoice[], month: string): Invoice[] {
  return invoices.filter((invoice) => invoiceOnMonthBoard(invoice, month))
}

/** The months the month picker offers: every month an invoice was due, billed or paid in. */
export function invoiceMonthOptions(invoices: Invoice[], today: string): string[] {
  const months = new Set<string>()
  for (const invoice of invoices) {
    months.add(invoiceMonthKey(invoice))
    const billed = monthKeyOfISO(invoice.billed_on)
    if (billed) months.add(billed)
    const paid = monthKeyOfISO(invoice.paid_on)
    if (paid) months.add(paid)
  }
  return monthOptions(months, today)
}

export interface MonthlyInvoiceTotals {
  /** Billed in the month, every kind of invoice together. */
  billed: number
  billedBy: Record<InvoiceBasis, number>
  billedCount: number
  /** Payment confirmed in the month. */
  paid: number
  paidCount: number
  /** Invoices due in the month, and how many of them are settled. */
  due: number
  dueCount: number
  dueSettledCount: number
  /** Billed and not yet paid, due by the end of the month. Overdue ones included. */
  outstanding: number
  outstandingCount: number
  overdueCount: number
  /** Of the outstanding, the ones due in an earlier month: carried over. */
  carriedCount: number
}

/**
 * The board's monthly figures for `month`: what was billed and paid in it, what
 * fell due in it, and what is still owed by the month's end. Each month starts
 * from zero, and anything still owed from an earlier month is counted as carried over.
 */
export function monthlyInvoiceTotals(invoices: Invoice[], month: string, today: string): MonthlyInvoiceTotals {
  const end = monthLastDay(month)
  const totals: MonthlyInvoiceTotals = {
    billed: 0,
    billedBy: { client: 0, project: 0, upwork: 0 },
    billedCount: 0,
    paid: 0,
    paidCount: 0,
    due: 0,
    dueCount: 0,
    dueSettledCount: 0,
    outstanding: 0,
    outstandingCount: 0,
    overdueCount: 0,
    carriedCount: 0,
  }
  for (const inv of invoices) {
    if (inv.billed_on?.startsWith(month)) {
      totals.billed += inv.amount
      totals.billedBy[inv.basis] += inv.amount
      totals.billedCount += 1
    }
    if (inv.stage === 'paid' && inv.paid_on?.startsWith(month)) {
      totals.paid += inv.amount
      totals.paidCount += 1
    }
    const dueMonth = invoiceMonthKey(inv)
    if (dueMonth === month) {
      totals.due += inv.amount
      totals.dueCount += 1
      if (inv.stage === 'paid') totals.dueSettledCount += 1
    }
    const status = invoiceStatus(inv.stage, inv.due_date, today)
    if ((status === 'awaiting' || status === 'overdue') && inv.due_date <= end) {
      totals.outstanding += inv.amount
      totals.outstandingCount += 1
      if (status === 'overdue') totals.overdueCount += 1
      if (dueMonth < month) totals.carriedCount += 1
    }
  }
  return totals
}

/** What a regular client's card shows about the client's recurring billing. */
export interface RegularChain {
  /** The latest day any of the client's invoices was billed; null when none has been. */
  lastBilled: string | null
  /** The client's auto-bill switch. */
  autoBill: boolean
  /** The next cycle auto-bill will raise — null when auto-bill is off or nothing is queued. */
  nextAutoBill: string | null
}

export function regularChain(invoices: Invoice[], clientId: string): RegularChain {
  const chain = invoices.filter((inv) => inv.basis === 'client' && inv.client_id === clientId)
  let lastBilled: string | null = null
  let nextAutoBill: string | null = null
  const autoBill = chain.some((inv) => inv.auto_bill)
  for (const inv of chain) {
    if (inv.billed_on && (lastBilled === null || inv.billed_on > lastBilled)) lastBilled = inv.billed_on
    if (autoBill && inv.stage === 'pending' && !inv.auto_billed && inv.bill_on && (nextAutoBill === null || inv.bill_on < nextAutoBill)) {
      nextAutoBill = inv.bill_on
    }
  }
  return { lastBilled, autoBill, nextAutoBill }
}
