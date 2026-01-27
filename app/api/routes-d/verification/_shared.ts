/**
 * Domain classification for client verification (KYC-Lite).
 * Personal = known consumer providers; Disposable = temp-mail; else Corporate.
 */

const PERSONAL_DOMAINS = new Set(
  [
    'gmail.com',
    'googlemail.com',
    'yahoo.com',
    'yahoo.co.uk',
    'outlook.com',
    'hotmail.com',
    'hotmail.co.uk',
    'live.com',
    'icloud.com',
    'aol.com',
    'protonmail.com',
    'proton.me',
    'mail.com',
    'zoho.com',
    'ymail.com',
    'me.com',
    'msn.com',
    'btinternet.com',
    'sky.com',
    'virginmedia.com',
    'blueyonder.co.uk',
    'google.com', // sometimes used for personal
  ].map((d) => d.toLowerCase())
);

const DISPOSABLE_DOMAINS = new Set(
  [
    'mailinator.com',
    'guerrillamail.com',
    'guerrillamail.info',
    'temp-mail.org',
    'tempmail.com',
    '10minutemail.com',
    'throwaway.email',
    'trashmail.com',
    'yopmail.com',
    'getnada.com',
    'maildrop.cc',
    'tempinbox.com',
    'fakeinbox.com',
    'sharklasers.com',
    'grr.la',
    'guerrillamailblock.com',
    'spam4.me',
    'dispostable.com',
    'mailnesia.com',
    'mohmal.com',
    'emailondeck.com',
    'mintemail.com',
  ].map((d) => d.toLowerCase())
);

export type DomainType = 'corporate' | 'personal' | 'disposable';

export function getDomainFromEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at === -1 || at === trimmed.length - 1) return null;
  return trimmed.slice(at + 1);
}

export function classifyDomain(domain: string): DomainType {
  const d = domain.toLowerCase();
  if (DISPOSABLE_DOMAINS.has(d)) return 'disposable';
  if (PERSONAL_DOMAINS.has(d)) return 'personal';
  return 'corporate';
}

export const MIN_PAID_INVOICES_FOR_VERIFIED = 3;
