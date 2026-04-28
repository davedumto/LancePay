export function parseIncludeArchivedParam(value: string | null): boolean {
  return value === 'true'
}

export function getArchiveFilter(includeArchived: boolean) {
  return includeArchived ? {} : { isConfidential: false }
}
