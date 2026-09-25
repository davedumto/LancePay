import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BalanceCard } from '@/components/dashboard/balance-card'

describe('BalanceCard with string XLM balance (#1516)', () => {
  it('renders without throwing when xlm arrives as a string from the API', () => {
    const balance = {
      available: { display: '$100.00' },
      localEquivalent: { display: '₦160,000', rate: 1600 },
      // app/api/user/balance/route.ts returns xlm as a string (e.g. "25.5")
      xlm: '25.5',
    }

    let html: string = ''
    expect(() => {
      html = renderToStaticMarkup(
        createElement(BalanceCard, { balance, isLoading: false } as never),
      )
    }).not.toThrow()
    // 25.5 coerced to a number and formatted with toFixed(2)
    expect(html).toContain('25.50 XLM')
  })

  it('renders without throwing when xlmBalance prop arrives as a string', () => {
    let html: string = ''
    expect(() => {
      html = renderToStaticMarkup(
        createElement(
          BalanceCard,
          { balance: null, isLoading: false, xlmBalance: '3.14159' } as never,
        ),
      )
    }).not.toThrow()
    expect(html).toContain('3.14 XLM')
  })

  it('falls back to 0.00 XLM for non-numeric values instead of throwing', () => {
    let html: string = ''
    expect(() => {
      html = renderToStaticMarkup(
        createElement(BalanceCard, { balance: { xlm: 'not-a-number' }, isLoading: false } as never),
      )
    }).not.toThrow()
    expect(html).toContain('0.00 XLM')
  })
})
