import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// GET /api/routes-b/bank-accounts — list user's saved bank accounts
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const bankAccounts = await prisma.bankAccount.findMany({
      where: { userId: user.id },
      orderBy: [
        { isDefault: 'desc' },
        { createdAt: 'asc' }
      ],
      select: {
        id: true,
        bankName: true,
        bankCode: true,
        accountNumber: true,
        accountName: true,
        isDefault: true,
        createdAt: true,
      }
    })

    return NextResponse.json({ bankAccounts })
  } catch (error) {
    console.error('Error fetching bank accounts:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/routes-b/bank-accounts — add a new bank account
export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { bankName, bankCode, accountNumber, accountName } = body

    // Validation
    if (!bankName || typeof bankName !== 'string' || bankName.trim().length === 0 || bankName.length > 100) {
      return NextResponse.json({ error: 'bankName must be a non-empty string (max 100 chars)' }, { status: 400 })
    }

    if (!bankCode || typeof bankCode !== 'string' || !/^\d{3,10}$/.test(bankCode)) {
      return NextResponse.json({ error: 'bankCode must be 3-10 digits' }, { status: 400 })
    }

    if (!accountNumber || typeof accountNumber !== 'string' || !/^\d{10}$/.test(accountNumber)) {
      return NextResponse.json({ error: 'accountNumber must be exactly 10 digits (Nigerian NUBAN)' }, { status: 400 })
    }

    if (!accountName || typeof accountName !== 'string' || accountName.trim().length === 0 || accountName.length > 100) {
      return NextResponse.json({ error: 'accountName must be a non-empty string (max 100 chars)' }, { status: 400 })
    }

    // Check for duplicate account
    const existing = await prisma.bankAccount.findFirst({
      where: {
        userId: user.id,
        accountNumber,
        bankCode
      }
    })

    if (existing) {
      return NextResponse.json({ error: 'This bank account is already linked' }, { status: 409 })
    }

    // First account auto-default logic
    const existingCount = await prisma.bankAccount.count({ where: { userId: user.id } })
    const isDefault = existingCount === 0

    const bankAccount = await prisma.bankAccount.create({
      data: {
        userId: user.id,
        bankName: bankName.trim(),
        bankCode,
        accountNumber,
        accountName: accountName.trim(),
        isDefault,
      },
      select: {
        id: true,
        bankName: true,
        bankCode: true,
        accountNumber: true,
        accountName: true,
        isDefault: true,
        createdAt: true,
      }
    })

    return NextResponse.json(bankAccount, { status: 201 })
  } catch (error) {
    console.error('Error creating bank account:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}