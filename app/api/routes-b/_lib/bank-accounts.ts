export function bankAccountDisplayName(account: {
  nickname?: string | null
  accountNumber?: string | null
  bankName?: string | null
}): string | null {
  if (account.nickname) return account.nickname
  if (account.accountNumber && account.bankName) {
    return `****${account.accountNumber.slice(-4)} ${account.bankName}`
  }
  return null
}
