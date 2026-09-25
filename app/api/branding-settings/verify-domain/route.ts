import { createHash, randomBytes } from 'crypto'
import { promises as dns } from 'dns'
import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

const VERIFICATION_TOKEN_PREFIX = 'lancepay-verify='
const MAX_VERIFICATION_ATTEMPTS = 10

async function authenticatedUser(request: NextRequest) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const claims = await verifyAuthToken(token)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

/**
 * Validates domain format
 */
function isValidDomain(domain: string): boolean {
  if (!domain || typeof domain !== 'string') return false
  const trimmed = domain.trim()
  // Basic domain validation: alphanumeric, dots, hyphens
  // Must have at least one dot and be 3+ characters
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9]{2,}$/
  return domainRegex.test(trimmed)
}

/**
 * Generates a secure verification token
 * Returns the plaintext token that user should add to DNS
 */
function generateVerificationToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Checks DNS TXT records for the verification token
 */
async function checkDnsVerification(domain: string, token: string): Promise<boolean> {
  try {
    const records = await dns.resolveTxt(domain)
    const lookupValue = VERIFICATION_TOKEN_PREFIX + token

    // Flatten the array of arrays into a single array of strings
    for (const record of records) {
      const recordValue = Array.isArray(record) ? record.join('') : record
      if (recordValue === lookupValue) {
        return true
      }
    }
    return false
  } catch (error) {
    // DNS lookup failed - could be ENOTFOUND, ENODATA, timeout, etc.
    logger.debug(
      { domain, error: error instanceof Error ? error.message : String(error) },
      'DNS lookup failed during domain verification',
    )
    return false
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await authenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    // Validate domain input
    const domain = typeof body.domain === 'string' ? body.domain.trim() : ''
    if (!isValidDomain(domain)) {
      return NextResponse.json(
        { error: 'Invalid domain format', details: { domain: ['Must be a valid domain name'] } },
        { status: 400 },
      )
    }

    // Get or create branding settings for this user
    let brandingSettings = await prisma.brandingSettings.findUnique({
      where: { userId: user.id },
    })

    let verificationToken: string

    if (!brandingSettings) {
      // First time - create branding settings and generate token
      verificationToken = generateVerificationToken()
      brandingSettings = await prisma.brandingSettings.create({
        data: {
          userId: user.id,
          customDomain: domain,
          verificationToken,
          verificationStatus: 'pending',
        },
      })
    } else {
      // Existing branding settings
      if (brandingSettings.customDomain && brandingSettings.customDomain !== domain) {
        return NextResponse.json(
          {
            error: 'Cannot verify different domain',
            details: {
              message: 'You already have a domain in verification. Complete verification or reset it first.',
            },
          },
          { status: 409 },
        )
      }

      // Update domain if not yet set
      if (!brandingSettings.customDomain) {
        brandingSettings = await prisma.brandingSettings.update({
          where: { userId: user.id },
          data: {
            customDomain: domain,
          },
        })
      }

      // Generate new token if none exists
      if (!brandingSettings.verificationToken) {
        verificationToken = generateVerificationToken()
        brandingSettings = await prisma.brandingSettings.update({
          where: { userId: user.id },
          data: {
            verificationToken,
            verificationStatus: 'pending',
          },
        })
      } else {
        verificationToken = brandingSettings.verificationToken
      }
    }

    // Increment attempt counter
    const newAttempts = (brandingSettings.verificationAttempts || 0) + 1
    if (newAttempts > MAX_VERIFICATION_ATTEMPTS) {
      return NextResponse.json(
        {
          error: 'Verification attempts exceeded',
          details: { message: 'Maximum verification attempts reached. Please contact support.' },
        },
        { status: 429 },
      )
    }

    // Check DNS for the verification token
    const isVerified = await checkDnsVerification(domain, verificationToken)

    if (isVerified) {
      // DNS check passed - mark domain as verified
      const updatedSettings = await prisma.brandingSettings.update({
        where: { userId: user.id },
        data: {
          verificationStatus: 'verified',
          verifiedAt: new Date(),
          verificationAttempts: newAttempts,
        },
        select: {
          id: true,
          customDomain: true,
          verificationStatus: true,
          verifiedAt: true,
        },
      })

      logger.info({ userId: user.id, domain }, 'Domain verification successful')

      return NextResponse.json(
        {
          domain: updatedSettings.customDomain,
          status: updatedSettings.verificationStatus,
          verifiedAt: updatedSettings.verifiedAt,
          message: 'Domain successfully verified',
        },
        { status: 200 },
      )
    } else {
      // DNS check failed or token not found - return pending with token for user to add
      const updatedSettings = await prisma.brandingSettings.update({
        where: { userId: user.id },
        data: {
          verificationStatus: 'pending',
          verificationAttempts: newAttempts,
        },
        select: {
          id: true,
          customDomain: true,
          verificationStatus: true,
          verificationToken: true,
          verificationAttempts: true,
        },
      })

      logger.debug(
        { userId: user.id, domain, attempts: newAttempts },
        'DNS verification check did not find token - returning pending',
      )

      return NextResponse.json(
        {
          domain: updatedSettings.customDomain,
          status: updatedSettings.verificationStatus,
          verificationCode: updatedSettings.verificationToken,
          attempts: updatedSettings.verificationAttempts,
          message: 'Please add the following TXT record to your domain DNS settings',
          instructionFormat: `${VERIFICATION_TOKEN_PREFIX}${updatedSettings.verificationToken}`,
        },
        { status: 200 },
      )
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/branding-settings/verify-domain error')
    return NextResponse.json(
      { error: 'Failed to verify domain' },
      { status: 500 },
    )
  }
}
