import type { Invoice, InvoiceBasis } from './types'
import { storage } from './storage'

/**
 * Invoicing helpers shared by the board and its verification script.
 *
 * An invoice bills **either** a client or a named project — `basis` on the
 * row says which. A project-based invoice may also name the client the
 * project belongs to, so the board can be narrowed to one billing target
 * (all / client based / project based) without guessing at the shape of a
 * row: the filter below is the single definition of what each choice means.
 */

/** The board's basis switch: everything, or just one of the two billing targets. */
export type InvoiceBasisFilter = 'all' | InvoiceBasis

export const INVOICE_BASIS_FILTERS: InvoiceBasisFilter[] = ['all', 'client', 'project']

export const InvoiceBasisFilterLabels: Record<InvoiceBasisFilter, string> = {
  all: 'All',
  client: 'Client based',
  project: 'Project based',
}

/** The invoices a basis choice leaves on the board. */
export function filterInvoicesByBasis(invoices: Invoice[], filter: InvoiceBasisFilter): Invoice[] {
  if (filter === 'all') return invoices
  return invoices.filter((inv) => inv.basis === filter)
}

/** How many invoices a basis choice would leave on the board. */
export function countInvoicesByBasis(invoices: Invoice[], filter: InvoiceBasisFilter): number {
  return filterInvoicesByBasis(invoices, filter).length
}

/**
 * The choice is remembered per device (next to the theme), so the board opens
 * where it was left: someone chasing project invoices does not re-pick the
 * filter every visit. Anything unreadable falls back to showing everything.
 */
const BASIS_FILTER_KEY = 'wt_invoice_basis_filter'

export function readInvoiceBasisFilter(): InvoiceBasisFilter {
  const saved = storage.getItem(BASIS_FILTER_KEY)
  return saved === 'client' || saved === 'project' ? saved : 'all'
}

export function writeInvoiceBasisFilter(filter: InvoiceBasisFilter): void {
  storage.setItem(BASIS_FILTER_KEY, filter)
}
