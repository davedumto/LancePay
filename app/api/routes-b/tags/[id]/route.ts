import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// ── DELETE /api/routes-b/tags/[id] — remove a tag and all its invoice associations ──
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        const claims = await verifyAuthToken(authToken || '')
        if (!claims) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
        if (!user) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        const tag = await prisma.tag.findUnique({ where: { id } })
        if (!tag) {
            return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
        }

        if (tag.userId !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        await prisma.tag.delete({ where: { id } })

        return new NextResponse(null, { status: 204 })
    } catch (error) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
