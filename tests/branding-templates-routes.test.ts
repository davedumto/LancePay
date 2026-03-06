import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as listTemplates, POST as createTemplate } from '@/app/api/routes-d/branding/templates/route'
import { GET as getTemplate, PUT as updateTemplate } from '@/app/api/routes-d/branding/templates/[id]/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => {
  const invoiceTemplate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  }

  return {
    prisma: {
      user: {
        findUnique: vi.fn(),
      },
      invoiceTemplate,
      $transaction: vi.fn(async (callback: (tx: { invoiceTemplate: typeof invoiceTemplate }) => unknown) => {
        return callback({ invoiceTemplate })
      }),
    },
  }
})

function makeAuthorizedRequest(url: string, init?: RequestInit) {
  return new NextRequest(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: 'Bearer test-token',
    },
  })
}

describe('Invoice template routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-user-id' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-1',
      privyId: 'privy-user-id',
      email: 'freelancer@example.com',
    } as never)
  })

  it('lists templates for authenticated user', async () => {
    vi.mocked(prisma.invoiceTemplate.findMany).mockResolvedValue([
      {
        id: 'tpl-1',
        userId: 'user-1',
        name: 'Default Template',
        isDefault: true,
      },
    ] as never)

    const request = makeAuthorizedRequest('http://localhost:3000/api/routes-d/branding/templates')
    const response = await listTemplates(request)

    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.templates).toHaveLength(1)
    expect(prisma.invoiceTemplate.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'asc' },
    })
  })

  it('creates first template as default', async () => {
    vi.mocked(prisma.invoiceTemplate.count).mockResolvedValue(0)
    vi.mocked(prisma.invoiceTemplate.updateMany).mockResolvedValue({ count: 0 } as never)
    vi.mocked(prisma.invoiceTemplate.create).mockResolvedValue({
      id: 'tpl-1',
      userId: 'user-1',
      name: 'My Template',
      isDefault: true,
      logoUrl: null,
      primaryColor: '#000000',
      accentColor: '#059669',
      showLogo: true,
      showFooter: true,
      footerText: null,
      layout: 'modern',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never)

    const request = makeAuthorizedRequest('http://localhost:3000/api/routes-d/branding/templates', {
      method: 'POST',
      body: JSON.stringify({
        name: 'My Template',
      }),
    })

    const response = await createTemplate(request)
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.template.isDefault).toBe(true)
    expect(prisma.invoiceTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        name: 'My Template',
        isDefault: true,
      }),
    })
  })

  it('rejects creating more than five templates', async () => {
    vi.mocked(prisma.invoiceTemplate.count).mockResolvedValue(5)

    const request = makeAuthorizedRequest('http://localhost:3000/api/routes-d/branding/templates', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Overflow Template',
      }),
    })

    const response = await createTemplate(request)

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toContain('up to 5')
    expect(prisma.invoiceTemplate.create).not.toHaveBeenCalled()
  })

  it('rejects oversized logo upload on create', async () => {
    vi.mocked(prisma.invoiceTemplate.count).mockResolvedValue(0)

    const oversizedLogo = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`
    const request = makeAuthorizedRequest('http://localhost:3000/api/routes-d/branding/templates', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Template with large logo',
        logoUrl: oversizedLogo,
      }),
    })

    const response = await createTemplate(request)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.message).toContain('2MB')
    expect(prisma.invoiceTemplate.create).not.toHaveBeenCalled()
  })

  it('gets template by id for owning user', async () => {
    vi.mocked(prisma.invoiceTemplate.findFirst).mockResolvedValue({
      id: 'tpl-1',
      userId: 'user-1',
      name: 'Template A',
      isDefault: false,
    } as never)

    const request = makeAuthorizedRequest('http://localhost:3000/api/routes-d/branding/templates/tpl-1')
    const response = await getTemplate(request, { params: Promise.resolve({ id: 'tpl-1' }) })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.template.id).toBe('tpl-1')
  })

  it('updates template and toggles default safely', async () => {
    vi.mocked(prisma.invoiceTemplate.findFirst).mockResolvedValue({
      id: 'tpl-1',
      userId: 'user-1',
      isDefault: false,
      name: 'Template A',
    } as never)

    vi.mocked(prisma.invoiceTemplate.updateMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(prisma.invoiceTemplate.update).mockResolvedValue({
      id: 'tpl-1',
      userId: 'user-1',
      isDefault: true,
      name: 'Template Updated',
    } as never)

    const request = makeAuthorizedRequest('http://localhost:3000/api/routes-d/branding/templates/tpl-1', {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Template Updated',
        isDefault: true,
      }),
    })

    const response = await updateTemplate(request, { params: Promise.resolve({ id: 'tpl-1' }) })

    expect(response.status).toBe(200)
    expect(prisma.invoiceTemplate.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isDefault: true, id: { not: 'tpl-1' } },
      data: { isDefault: false },
    })

    const body = await response.json()
    expect(body.template.name).toBe('Template Updated')
    expect(body.template.isDefault).toBe(true)
  })

  it('rejects oversized logo upload on update', async () => {
    vi.mocked(prisma.invoiceTemplate.findFirst).mockResolvedValue({
      id: 'tpl-1',
      userId: 'user-1',
      isDefault: false,
      name: 'Template A',
    } as never)

    const oversizedLogo = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`
    const request = makeAuthorizedRequest('http://localhost:3000/api/routes-d/branding/templates/tpl-1', {
      method: 'PUT',
      body: JSON.stringify({
        logoUrl: oversizedLogo,
      }),
    })

    const response = await updateTemplate(request, { params: Promise.resolve({ id: 'tpl-1' }) })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.message).toContain('2MB')
    expect(prisma.invoiceTemplate.update).not.toHaveBeenCalled()
  })
})
