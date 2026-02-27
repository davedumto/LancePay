import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '../savings/_shared'
import { logger } from '@/lib/logger'

const TAX_VAULT_TITLE = 'Tax Vault'

/**
 * GET /api/routes-d/tax-vault
 * Returns the user's tax vault settings and current balance.
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await getAuthContext(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: 401 })
    }

    const { user } = authResult

    const taxVault = await prisma.savingsGoal.findFirst({
      where: { userId: user.id, isTaxVault: true },
    })

    return NextResponse.json({
      success: true,
      taxPercentage: user.taxPercentage,
      taxVault: taxVault
        ? {
            id: taxVault.id,
            currentAmountUsdc: Number(taxVault.currentAmountUsdc),
            isActive: taxVault.isActive,
            status: taxVault.status,
          }
        : null,
    })
  } catch (error) {
    logger.error({ err: error }, 'Tax vault GET error:')
    return NextResponse.json({ error: 'Failed to get tax vault' }, { status: 500 })
  }
}

/**
 * PUT /api/routes-d/tax-vault
 * Updates the user's tax percentage and ensures a Tax Vault savings goal exists.
 * Body: { taxPercentage: number (0-100) }
 */
export async function PUT(request: NextRequest) {
  try {
    const authResult = await getAuthContext(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: 401 })
    }

    const { user } = authResult
    const body = await request.json()
    const taxPercentage = Number(body.taxPercentage)

    if (isNaN(taxPercentage) || taxPercentage < 0 || taxPercentage > 100) {
      return NextResponse.json(
        { error: 'taxPercentage must be a number between 0 and 100' },
        { status: 400 }
      )
    }

    // Update the user's tax percentage
    await prisma.user.update({
      where: { id: user.id },
      data: { taxPercentage },
    })

    // If percentage > 0, ensure a Tax Vault savings goal exists (create or reactivate)
    let taxVault = await prisma.savingsGoal.findFirst({
      where: { userId: user.id, isTaxVault: true },
    })

    if (taxPercentage > 0) {
      if (!taxVault) {
        taxVault = await prisma.savingsGoal.create({
          data: {
            userId: user.id,
            title: TAX_VAULT_TITLE,
            // Tax vault has no fixed target — use a very large number as a soft ceiling
            targetAmountUsdc: 999999999,
            savingsPercentage: taxPercentage,
            isTaxVault: true,
            isActive: true,
            status: 'in_progress',
          },
        })
      } else {
        taxVault = await prisma.savingsGoal.update({
          where: { id: taxVault.id },
          data: {
            savingsPercentage: taxPercentage,
            isActive: true,
            status: 'in_progress',
          },
        })
      }
    } else if (taxVault) {
      // Disable the tax vault when percentage is set to 0
      taxVault = await prisma.savingsGoal.update({
        where: { id: taxVault.id },
        data: { isActive: false },
      })
    }

    return NextResponse.json({
      success: true,
      message: 'Tax vault updated',
      taxPercentage,
      taxVault: taxVault
        ? {
            id: taxVault.id,
            currentAmountUsdc: Number(taxVault.currentAmountUsdc),
            isActive: taxVault.isActive,
            status: taxVault.status,
          }
        : null,
    })
  } catch (error) {
    logger.error({ err: error }, 'Tax vault PUT error:')
    return NextResponse.json({ error: 'Failed to update tax vault' }, { status: 500 })
  }
}

/**
 * POST /api/routes-d/tax-vault/release
 * Releases (empties) the tax vault balance back to the main balance.
 * Used when the user wants to withdraw saved tax funds.
 */
export async function DELETE(request: NextRequest) {
  try {
    const authResult = await getAuthContext(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: 401 })
    }

    const { user } = authResult

    const taxVault = await prisma.savingsGoal.findFirst({
      where: { userId: user.id, isTaxVault: true },
    })

    if (!taxVault) {
      return NextResponse.json({ error: 'No tax vault found' }, { status: 404 })
    }

    const releasedAmount = Number(taxVault.currentAmountUsdc)

    await prisma.savingsGoal.update({
      where: { id: taxVault.id },
      data: { currentAmountUsdc: 0 },
    })

    return NextResponse.json({
      success: true,
      message: 'Tax vault funds released',
      releasedAmountUsdc: releasedAmount,
    })
  } catch (error) {
    logger.error({ err: error }, 'Tax vault DELETE error:')
    return NextResponse.json({ error: 'Failed to release tax vault' }, { status: 500 })
  }
}
