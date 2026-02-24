import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { 
  getAuthContext, 
  AutoSwapRuleSchema, 
  AutoSwapRuleStatusSchema,
  formatAutoSwapRule 
} from '../_shared'

/**
 * GET /api/routes-d/auto-swap/rules
 * Returns the current active auto-swap rule for the authenticated user
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await getAuthContext(request)
    
    if ('error' in authResult) {
      return NextResponse.json(
        { error: authResult.error }, 
        { status: 401 }
      )
    }

    const { user } = authResult

    
    const rule = await prisma.autoSwapRule.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { 
        bankAccount: {
          select: {
            id: true,
            bankName: true,
            accountNumber: true,
            accountName: true,
          }
        } 
      },
    })

    if (!rule) {
      return NextResponse.json({
        success: true,
        rule: null,
        message: 'No auto-swap rule configured',
      })
    }

    return NextResponse.json({
      success: true,
      rule: formatAutoSwapRule(rule),
    })
  } catch (error) {
    console.error('Error fetching auto-swap rule:', error)
    return NextResponse.json(
      { error: 'Failed to fetch auto-swap rule' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/routes-d/auto-swap/rules
 * Creates or updates the auto-swap rule for the authenticated user
 * - Percentage must be between 1 and 100
 * - Bank account must belong to the user
 * - Only one rule per user (upsert behavior)
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await getAuthContext(request)
    
    if ('error' in authResult) {
      return NextResponse.json(
        { error: authResult.error }, 
        { status: 401 }
      )
    }

    const { user } = authResult

    // Parse and validate request body
    const body = await request.json()
    const validationResult = AutoSwapRuleSchema.safeParse(body)

    if (!validationResult.success) {
      return NextResponse.json(
        { 
          error: 'Validation failed', 
          details: validationResult.error.flatten().fieldErrors 
        },
        { status: 400 }
      )
    }

    const { percentage, bankAccountId, isActive } = validationResult.data

    // Verify the bank account belongs to the user
    const bankAccount = await prisma.bankAccount.findFirst({
      where: {
        id: bankAccountId,
        userId: user.id,
      },
    })

    if (!bankAccount) {
      return NextResponse.json(
        { error: 'Bank account not found or does not belong to you' },
        { status: 404 }
      )
    }

    // Save one rule per user (update existing, otherwise create).
    // This is resilient to environments where `userId` uniqueness has drifted.
    const existingRule = await prisma.autoSwapRule.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })

    const rule = existingRule
      ? await prisma.autoSwapRule.update({
          where: { id: existingRule.id },
          data: {
            percentage,
            bankAccountId,
            isActive,
            updatedAt: new Date(),
          },
          include: {
            bankAccount: {
              select: {
                id: true,
                bankName: true,
                accountNumber: true,
                accountName: true,
              }
            }
          },
        })
      : await prisma.autoSwapRule.create({
          data: {
            userId: user.id,
            percentage,
            bankAccountId,
            isActive,
          },
          include: {
            bankAccount: {
              select: {
                id: true,
                bankName: true,
                accountNumber: true,
                accountName: true,
              }
            }
          },
        })

    return NextResponse.json({
      success: true,
      message: 'Auto-swap rule saved successfully',
      rule: formatAutoSwapRule(rule),
    }, { status: 201 })
  } catch (error) {
    console.error('Error saving auto-swap rule:', error)
    return NextResponse.json(
      { error: 'Failed to save auto-swap rule' },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/routes-d/auto-swap/rules
 * Toggle the auto-swap rule active status
 */
export async function PATCH(request: NextRequest) {
  try {
    const authResult = await getAuthContext(request)
    
    if ('error' in authResult) {
      return NextResponse.json(
        { error: authResult.error }, 
        { status: 401 }
      )
    }

    const { user } = authResult

    // Parse and validate request body
    const body = await request.json()
    const validationResult = AutoSwapRuleStatusSchema.safeParse(body)

    if (!validationResult.success) {
      return NextResponse.json(
        { 
          error: 'Validation failed', 
          details: validationResult.error.flatten().fieldErrors 
        },
        { status: 400 }
      )
    }

    const { isActive } = validationResult.data

    // Check if user has a rule
    const existingRule = await prisma.autoSwapRule.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })

    if (!existingRule) {
      return NextResponse.json(
        { error: 'No auto-swap rule found. Create one first.' },
        { status: 404 }
      )
    }

    // Update the rule status
    const rule = await prisma.autoSwapRule.update({
      where: { id: existingRule.id },
      data: {
        isActive,
        updatedAt: new Date(),
      },
      include: {
        bankAccount: {
          select: {
            id: true,
            bankName: true,
            accountNumber: true,
            accountName: true,
          }
        }
      },
    })

    return NextResponse.json({
      success: true,
      message: `Auto-swap rule ${isActive ? 'activated' : 'deactivated'} successfully`,
      rule: formatAutoSwapRule(rule),
    })
  } catch (error) {
    console.error('Error updating auto-swap rule status:', error)
    return NextResponse.json(
      { error: 'Failed to update auto-swap rule status' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/routes-d/auto-swap/rules
 * Deletes the user's auto-swap rule
 */
export async function DELETE(request: NextRequest) {
  try {
    const authResult = await getAuthContext(request)
    
    if ('error' in authResult) {
      return NextResponse.json(
        { error: authResult.error }, 
        { status: 401 }
      )
    }

    const { user } = authResult

    // Check if user has a rule
    const existingRule = await prisma.autoSwapRule.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })

    if (!existingRule) {
      return NextResponse.json(
        { error: 'No auto-swap rule found' },
        { status: 404 }
      )
    }

    // Delete the rule
    await prisma.autoSwapRule.delete({
      where: { id: existingRule.id },
    })

    return NextResponse.json({
      success: true,
      message: 'Auto-swap rule deleted successfully',
    })
  } catch (error) {
    console.error('Error deleting auto-swap rule:', error)
    return NextResponse.json(
      { error: 'Failed to delete auto-swap rule' },
      { status: 500 }
    )
  }
}
