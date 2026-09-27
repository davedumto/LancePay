import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// DELETE /api/whitelist-addresses/[id] — remove a whitelisted withdrawal address
//
// In-flight withdrawal protection (approach b - allow deletion):
// Withdrawals store the destination address as a snapshot (withdrawAddress field)
// at creation time, not as a foreign key reference to WhitelistAddress.
// This means deleting a WhitelistAddress has NO effect on in-flight withdrawals,
// since the withdrawal has already captured the address value. Therefore, allowing
// deletion is safe and doesn't introduce any data inconsistency.

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function DELETE(
  request: NextRequest,
  { params }: any,
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const {} = await params
    if (!id || typeof id !== 'string' || !id.trim()) {
      return NextResponse.json({ error: 'Address ID is required' }, { status: 400 })
    }

    // Verify ownership: ensure the whitelisted address belongs to the authenticated user
    const address = await prisma.whitelistAddress.findFirst({
      where: { id, userId: user.id },
    })

    if (!address) {
      return NextResponse.json({ error: 'Whitelisted address not found' }, { status: 404 })
    }

    // Delete the whitelisted address
    // Safe to delete even if withdrawals are in-flight, since withdrawals
    // snapshot the address value at creation time
    await prisma.whitelistAddress.delete({ where: { id } })

    logger.info(
      { userId: user.id, addressId: id, address: address.address },
      'DELETE /api/whitelist-addresses/[id]',
    )

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/whitelist-addresses/[id] error')
    return NextResponse.json({ error: 'Failed to remove whitelisted address' }, { status: 500 })
  }
}
