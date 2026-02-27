/**
 * Stubbed business verification (KYB) helpers.
 * In production this would call out to a third-party compliance provider
 * using an API key / endpoint defined in environment variables.
 */

export type KYBStatus = 'NEEDS_INFO' | 'PENDING' | 'PROCESSING' | 'ACCEPTED' | 'REJECTED';

export interface BusinessInfo {
  id: string;
  status: KYBStatus;
  message?: string;
  // additional fields could be added here to mirror real vendor responses
}

const KYB_BASE_URL = process.env.NEXT_PUBLIC_KYB_ENDPOINT || '';

/**
 * Fetch the verification status for a business entity.
 *
 * The only required identifier today is `businessId`; clients may use
 * registration number or other fields but those are handled by the
 * third-party service.  For now we return a fixed pending response.
 */
export async function getBusinessStatus(businessId: string): Promise<BusinessInfo> {
  // placeholder implementation, simulate network call delay
  if (!businessId) {
    throw new Error('businessId is required');
  }

  // Example of how an actual request could look:
  // const resp = await fetch(`${KYB_BASE_URL}/verify?businessId=${encodeURIComponent(businessId)}`, {
  //   headers: { Authorization: `Bearer ${process.env.KYB_API_KEY}` },
  // });
  // if (!resp.ok) throw new Error(`KYB request failed: ${resp.statusText}`);
  // return resp.json();

  // Simulated response
  return {
    id: businessId,
    status: 'PENDING',
    message: 'Verification in progress (simulation)',
  };
}
