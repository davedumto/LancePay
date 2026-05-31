import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { bankAccountDisplayName } from '../../_lib/bank-accounts'

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const authToken = request.headers
    .get('authorization')
    ?.replace('Bearer ', '')
  if (!authToken)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  })
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const bankAccount = await prisma.bankAccount.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      bankName: true,
      bankCode: true,
      accountNumber: true,
      accountName: true,
      isDefault: true,
      nickname: true,
      createdAt: true,
    },
  })

  if (!bankAccount)
    return NextResponse.json(
      { error: 'Bank account not found' },
      { status: 404 },
    )

  if (bankAccount.userId !== user.id)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  return NextResponse.json({
    bankAccount: {
      id: bankAccount.id,
      bankName: bankAccount.bankName,
      bankCode: bankAccount.bankCode,
      accountNumber: bankAccount.accountNumber,
      accountName: bankAccount.accountName,
      isDefault: bankAccount.isDefault,
      nickname: bankAccount.nickname ?? null,
      displayName: bankAccountDisplayName({
        nickname: bankAccount.nickname ?? null,
        accountNumber: bankAccount.accountNumber,
        bankName: bankAccount.bankName,
      }),
      createdAt: bankAccount.createdAt,
    },
  })
}

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const authToken = request.headers
    .get('authorization')
    ?.replace('Bearer ', '')
  if (!authToken)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  })
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)

  const wantsDefault = body?.isDefault === true
  const hasNickname = body !== null && 'nickname' in body && typeof body.nickname === 'string'

  if (!body || (!wantsDefault && !hasNickname)) {
    return NextResponse.json(
      { error: 'PATCH body must include { isDefault: true } and/or { nickname }' },
      { status: 400 },
    )
  }

  if (hasNickname && body.nickname !== '' && body.nickname.trim().length > 32) {
    return NextResponse.json({ error: 'nickname must be at most 32 characters' }, { status: 400 })
  }

  const account = await prisma.bankAccount.findUnique({
    where: { id },
    select: { id: true, userId: true },
  })
  if (!account)
    return NextResponse.json(
      { error: 'Bank account not found' },
      { status: 404 },
    )
  if (account.userId !== user.id)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const bankAccountSelect = {
    id: true,
    bankName: true,
    bankCode: true,
    accountNumber: true,
    accountName: true,
    isDefault: true,
    nickname: true,
    createdAt: true,
  }

  if (wantsDefault) {
    const updated = await prisma.$transaction(async tx => {
      await tx.bankAccount.updateMany({
        where: { userId: user.id, isDefault: true },
        data: { isDefault: false },
      })

      return tx.bankAccount.update({
        where: { id: account.id },
        data: {
          isDefault: true,
          ...(hasNickname
            ? { nickname: body.nickname === '' ? null : body.nickname.trim() }
            : {}),
        },
        select: bankAccountSelect,
      })
    })

    return NextResponse.json({
      bankAccount: { ...updated, displayName: bankAccountDisplayName(updated) },
    })
  }

  const resolvedNickname = body.nickname === '' ? null : body.nickname.trim()
  const updated = await prisma.bankAccount.update({
    where: { id: account.id },
    data: { nickname: resolvedNickname },
    select: bankAccountSelect,
  })

  return NextResponse.json({
    bankAccount: { ...updated, displayName: bankAccountDisplayName(updated) },
  })
}

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const authToken = request.headers
    .get('authorization')
    ?.replace('Bearer ', '')
  if (!authToken)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  })
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const account = await prisma.bankAccount.findUnique({
    where: { id },
    select: { id: true, userId: true, isDefault: true },
  })
  if (!account)
    return NextResponse.json(
      { error: 'Bank account not found' },
      { status: 404 },
    )
  if (account.userId !== user.id)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const result = await prisma.$transaction(async tx => {
    const deleted = await tx.bankAccount.delete({
      where: { id: account.id },
      select: { id: true, isDefault: true },
    })

    if (!deleted.isDefault) {
      return { deletedId: deleted.id, promotedId: null }
    }

    const remaining = await tx.bankAccount.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        createdAt: true,
        withdrawals: {
          where: { type: 'withdrawal' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    })

    if (remaining.length === 0) {
      return { deletedId: deleted.id, promotedId: null }
    }

    const nextDefault = remaining
      .map(item => ({
        id: item.id,
        score:
          item.withdrawals[0]?.createdAt.getTime() ?? item.createdAt.getTime(),
      }))
      .sort((a, b) => b.score - a.score)[0]

    await tx.bankAccount.updateMany({
      where: { userId: user.id },
      data: { isDefault: false },
    })

    await tx.bankAccount.update({
      where: { id: nextDefault.id },
      data: { isDefault: true },
    })

    return { deletedId: deleted.id, promotedId: nextDefault.id }
  })

  return NextResponse.json(result)
}

export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(PATCHHandler)
export const DELETE = withRequestId(DELETEHandler)
