const activeExports = new Set<string>()

export function acquireExportLock(userId: string): boolean {
  if (activeExports.has(userId)) return false
  activeExports.add(userId)
  return true
}

export function releaseExportLock(userId: string): void {
  activeExports.delete(userId)
}

export function resetExportLocks(): void {
  activeExports.clear()
}
