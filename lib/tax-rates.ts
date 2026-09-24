/**
 * Helpers for resolving effective-dated and compound tax rates.
 *
 * A tax rate may reference a parent rate that is "applied before it". This
 * models compound tax, where a tax is charged on an amount that has already
 * been taxed by its parent. The effective combined percentage is therefore
 * the multiplicative compounding of every rate in the chain:
 *
 *   combined = (1 + r_parent) * (1 + r_child) * ... - 1
 *
 * rather than a naive sum of the individual percentages.
 */

export interface RateComponent {
  id: string
  name: string
  rate: number
}

/**
 * Combines an ordered list of rate components (root parent first) into a
 * single effective percentage using multiplicative compounding.
 * Returns a fraction, e.g. 0.155 for a combined 15.5%.
 */
export function combineRates(components: RateComponent[]): number {
  const product = components.reduce((acc, component) => acc * (1 + component.rate), 1)
  return product - 1
}

export interface ChainNode {
  id: string
  name: string
  rate: number
  parentRateId: string | null
}

/**
 * Walks the parent chain for a rate and returns its components ordered from the
 * root parent down to the rate itself. Guards against cycles so a corrupted
 * parent reference cannot cause an infinite loop.
 *
 * @param startId  id of the leaf rate to resolve
 * @param nodesById lookup of every rate that may appear in the chain
 */
export function resolveRateChain(
  startId: string,
  nodesById: Map<string, ChainNode>
): RateComponent[] {
  const chain: RateComponent[] = []
  const seen = new Set<string>()

  let currentId: string | null = startId
  while (currentId) {
    if (seen.has(currentId)) {
      throw new Error(`Cyclic tax rate reference detected at "${currentId}"`)
    }
    seen.add(currentId)

    const node = nodesById.get(currentId)
    if (!node) {
      throw new Error(`Missing tax rate "${currentId}" while resolving chain`)
    }

    // Prepend so the root parent ends up first in the returned list.
    chain.unshift({ id: node.id, name: node.name, rate: node.rate })
    currentId = node.parentRateId
  }

  return chain
}

/**
 * Returns true when two effective date ranges overlap. A null `to` means the
 * range is open-ended. Ranges are treated as half-open: [from, to).
 */
export function rangesOverlap(
  aFrom: Date,
  aTo: Date | null,
  bFrom: Date,
  bTo: Date | null
): boolean {
  const aEnd = aTo ? aTo.getTime() : Infinity
  const bEnd = bTo ? bTo.getTime() : Infinity
  return aFrom.getTime() < bEnd && bFrom.getTime() < aEnd
}
