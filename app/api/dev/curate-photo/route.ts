import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"
import { type FlickrPhoto } from "@/lib/flickr"

const FILE_PATH = "data/photo-curations.json"

// Each station's curations.
//
// `approved` is the canonical display order — admins reorder freely within it,
// but the array MUST keep the invariant: every id in `pinnedIds` comes before
// any non-pinned photo. All callers that move photos around enforce this.
//
// `pinnedIds` is the set of photo ids the admin has pinned. Their relative
// order is derived from their order in `approved[]` (pinnedIds itself isn't
// an ordered source of truth; it's just "which photos have the pin badge").
type CurationEntry = {
  name: string
  approved: FlickrPhoto[]
  pinnedIds?: string[]
}

// Helper — count how many of the currently-approved photos are pinned.
// `approved.slice(0, numPins)` is the pinned prefix.
function getNumPins(entry: CurationEntry): number {
  if (!entry.pinnedIds?.length) return 0
  const set = new Set(entry.pinnedIds)
  let count = 0
  for (const p of entry.approved) {
    if (set.has(p.id)) count++
    else break  // invariant: pins come first, so we can stop at the first non-pinned
  }
  return count
}

// POST — approve / unapprove / pin / unpin / move a photo for a station
// Body: { coordKey, name, photoId, action, photo?, direction? }
export async function POST(req: NextRequest) {
  const { coordKey, name, photoId, action, photo, direction } = await req.json()

  if (!coordKey || !photoId || !action) {
    return NextResponse.json({ error: "missing coordKey, photoId, or action" }, { status: 400 })
  }

  const { data: curations, sha } = await readDataFile<Record<string, CurationEntry>>(FILE_PATH)
  const entry = curations[coordKey] ?? { name: name ?? coordKey, approved: [] }
  entry.name = name ?? entry.name

  if (action === "approve") {
    if (!photo) {
      return NextResponse.json({ error: "photo object required for approve" }, { status: 400 })
    }
    // Append to end — new approvals land at the bottom of the non-pinned section.
    if (!entry.approved.some((p) => p.id === photoId)) {
      entry.approved.push(photo)
    }
  } else if (action === "approveAtTop") {
    // "jump to top" on a non-approved photo: approve AND put at the top of
    // the non-pinned section (just below the last pin). Keeps pins untouched.
    if (!photo) {
      return NextResponse.json({ error: "photo object required for approveAtTop" }, { status: 400 })
    }
    // Remove any existing entry for this id so we can re-insert cleanly.
    entry.approved = entry.approved.filter((p) => p.id !== photoId)
    const numPins = getNumPins(entry)
    entry.approved.splice(numPins, 0, photo)
  } else if (action === "unapprove") {
    entry.approved = entry.approved.filter((p) => p.id !== photoId)
    entry.pinnedIds = (entry.pinnedIds ?? []).filter((id) => id !== photoId)
  } else if (action === "pin") {
    // Pinning implicitly approves — if the photo isn't in the approved list
    // yet, we need the full photo object so we can store it.
    let existing = entry.approved.find((p) => p.id === photoId)
    if (!existing) {
      if (!photo) {
        return NextResponse.json({ error: "photo object required to pin an unapproved photo" }, { status: 400 })
      }
      existing = photo
    }
    // Remove from current position (if already in approved[]) and from pinnedIds.
    entry.approved = entry.approved.filter((p) => p.id !== photoId)
    const prevPins = (entry.pinnedIds ?? []).filter((id) => id !== photoId)
    // Insert at position `numPins` (computed against the list AFTER removal) so
    // the photo lands at the bottom of the pinned section — below any existing
    // pins, above every non-pinned photo.
    const numPinsAfterRemoval = prevPins.filter((id) => entry.approved.some((p) => p.id === id)).length
    entry.approved.splice(numPinsAfterRemoval, 0, existing as FlickrPhoto)
    entry.pinnedIds = [...prevPins, photoId]
  } else if (action === "unpin") {
    // Photo keeps its position — which, since it was at the bottom of the
    // pinned section, becomes the top of the non-pinned section.
    entry.pinnedIds = (entry.pinnedIds ?? []).filter((id) => id !== photoId)
  } else if (action === "move") {
    // "up" / "down" — swap with immediate neighbour, clamped at the section
    //                 boundary (can't cross between pinned and non-pinned).
    // "top"         — push to the top of the photo's own section.
    //                 pinned   → index 0
    //                 non-pinned → index numPins (just below the last pin).
    // "bottom"      — push to the bottom of the photo's own section.
    //                 pinned   → index numPins - 1 (bottom of pins).
    //                 non-pinned → index approved.length - 1 (end of queue).
    const idx = entry.approved.findIndex((p) => p.id === photoId)
    if (idx >= 0) {
      const pinnedSet = new Set(entry.pinnedIds ?? [])
      const isPinned = pinnedSet.has(photoId)
      const numPins = getNumPins(entry)
      if (direction === "top") {
        const [p] = entry.approved.splice(idx, 1)
        const targetIdx = isPinned ? 0 : numPins
        entry.approved.splice(targetIdx, 0, p)
      } else if (direction === "bottom") {
        const [p] = entry.approved.splice(idx, 1)
        const targetIdx = isPinned ? numPins - 1 : entry.approved.length
        entry.approved.splice(Math.max(0, targetIdx), 0, p)
      } else {
        const targetIdx = direction === "up" ? idx - 1 : idx + 1
        if (targetIdx >= 0 && targetIdx < entry.approved.length) {
          // Respect the pin/non-pin section boundary — don't let a swap cross it.
          const neighbourPinned = pinnedSet.has(entry.approved[targetIdx].id)
          if (isPinned === neighbourPinned) {
            ;[entry.approved[idx], entry.approved[targetIdx]] = [entry.approved[targetIdx], entry.approved[idx]]
          }
        }
      }
    }
  } else {
    return NextResponse.json({ error: "action must be 'approve', 'approveAtTop', 'unapprove', 'pin', 'unpin', or 'move'" }, { status: 400 })
  }

  // Tidy: drop empty pinnedIds and drop empty entries entirely.
  if (entry.pinnedIds && entry.pinnedIds.length === 0) delete entry.pinnedIds
  if (entry.approved.length === 0) {
    delete curations[coordKey]
  } else {
    curations[coordKey] = entry
  }

  await writeDataFile(FILE_PATH, curations, `${action} photo for ${name ?? coordKey}`, sha)
  return NextResponse.json({ message: "ok" })
}

// GET — returns all curations so the modal can use them
export async function GET() {
  const { data } = await readDataFile<Record<string, CurationEntry>>(FILE_PATH)
  return NextResponse.json(data)
}
