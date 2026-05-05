// Compact-display shorthands for orgSlug, used by the walks-manager
// table to keep org tags short ("swc", "to1") even when full org
// names are long ("Saturday Walkers Club", "Time Out Country Walks
// Volume 1"). Authored as a closed dictionary because the auto-
// derivation rules (initials of words / numerals at the end) work
// for most slugs but not all.
//
// To add a new org: add the slug → shorthand here. If we forget,
// `orgShorthand()` falls back to the slug itself, which still reads
// fine just longer.

const SHORTHANDS: Record<string, string> = {
  "saturday-walkers-club": "swc",
  "leicester-ramblers": "lr",
  "heart-rail-trails": "hrt",
  "abbey-line": "abbey",
  "rough-guide-walks-london-south-east-3rd": "rg",
  "time-out-country-walks-vol-1": "to1",
  "time-out-country-walks-vol-2": "to2",
  "visit-amber-valley": "vav",
}

export function orgShorthand(orgSlug: string): string {
  return SHORTHANDS[orgSlug] ?? orgSlug
}

// Format one org-row entry as a compact tag for the walks-manager
// table. Convention:
//   - main walk, no walkNumber:                   "swc"
//   - main walk, with walkNumber:                 "to1:23"
//   - non-main walk, no walkNumber:               "swc:shorter"
//   - non-main walk, with walkNumber:             "to1:23:variant"
// The `type` is omitted when "main" because the bare shorthand
// already implies the canonical/main attribution; explicitly tagging
// it would just be visual noise.
export function formatOrgTag(org: {
  orgSlug: string
  type: string
  walkNumber?: string
}): string {
  const base = orgShorthand(org.orgSlug)
  const number = org.walkNumber?.trim()
  const isMain = org.type === "main"
  const parts: string[] = [base]
  if (number) parts.push(number)
  if (!isMain) parts.push(org.type)
  return parts.join(":")
}
