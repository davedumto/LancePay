export type Widget = {
  id: string
  label: string
  defaultOrder: number
}

export const WIDGET_CATALOG: Widget[] = [
  { id: 'invoices', label: 'Invoices', defaultOrder: 0 },
  { id: 'clients', label: 'Clients', defaultOrder: 1 },
  { id: 'earnings', label: 'Earnings', defaultOrder: 2 },
  { id: 'transactions', label: 'Transactions', defaultOrder: 3 },
  { id: 'pending-withdrawals', label: 'Pending Withdrawals', defaultOrder: 4 },
  { id: 'trust-score', label: 'Trust Score', defaultOrder: 5 },
]

export const VALID_WIDGET_IDS = new Set(WIDGET_CATALOG.map(w => w.id))

export const DEFAULT_ORDER: string[] = WIDGET_CATALOG
  .slice()
  .sort((a, b) => a.defaultOrder - b.defaultOrder)
  .map(w => w.id)

export type WidgetConfig = {
  order: string[]
  hidden: string[]
}

const store = new Map<string, WidgetConfig>()

export function clearWidgetStore(): void {
  store.clear()
}

export function getWidgetConfig(userId: string): WidgetConfig {
  const saved = store.get(userId)
  const savedOrder = saved?.order ?? []
  const savedHidden = saved?.hidden ?? []

  // Keep known IDs in the saved order, then append any missing ones in default order
  const seenInOrder = new Set(savedOrder.filter(id => VALID_WIDGET_IDS.has(id)))
  const merged = [
    ...savedOrder.filter(id => VALID_WIDGET_IDS.has(id)),
    ...DEFAULT_ORDER.filter(id => !seenInOrder.has(id)),
  ]

  return {
    order: merged,
    hidden: savedHidden.filter(id => VALID_WIDGET_IDS.has(id)),
  }
}

export type PatchWidgetPayload = {
  order?: string[]
  hidden?: string[]
}

export type PatchResult =
  | { ok: true; config: WidgetConfig }
  | { ok: false; error: string; unknownIds: string[] }

export function patchWidgetConfig(userId: string, patch: PatchWidgetPayload): PatchResult {
  const unknownIds: string[] = []

  if (patch.order !== undefined) {
    for (const id of patch.order) {
      if (!VALID_WIDGET_IDS.has(id)) unknownIds.push(id)
    }
  }
  if (patch.hidden !== undefined) {
    for (const id of patch.hidden) {
      if (!VALID_WIDGET_IDS.has(id)) unknownIds.push(id)
    }
  }

  if (unknownIds.length > 0) {
    return { ok: false, error: 'Unknown widget ids', unknownIds: [...new Set(unknownIds)] }
  }

  const current = getWidgetConfig(userId)

  const newOrder = patch.order !== undefined
    ? [...new Set(patch.order.filter(id => VALID_WIDGET_IDS.has(id)))]
    : current.order

  const newHidden = patch.hidden !== undefined
    ? [...new Set(patch.hidden.filter(id => VALID_WIDGET_IDS.has(id)))]
    : current.hidden

  store.set(userId, { order: newOrder, hidden: newHidden })
  return { ok: true, config: getWidgetConfig(userId) }
}
