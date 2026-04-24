import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"
import { type FlickrPhoto } from "@/lib/flickr"

const FILE_PATH = "data/photo-curations.json"

// Each station's curations.
//
// `approved` is the canonical display order — admins reorder freely within it.
// Pinned photos are "locked in place": when another photo moves, pinned
// photos keep their absolute index. But an admin CAN still move a pinned
// photo manually via the reorder buttons.
//
// `pinnedIds` is just the set of photo ids with the pin badge — no ordering
// invariant; a pin can sit at any index in `approved[]`.
type CurationEntry = {
  name: string
  approved: FlickrPhoto[]
  pinnedIds?: string[]
}

// Bubble a photo at `idx` in `arr` one slot toward `end` (either "up" = lower
// index or "down" = higher index). Pin semantics are asymmetric:
//   - If the moving photo is itself PINNED, it can freely swap with the
//     immediately adjacent photo, pinned or not. Pins only block non-pinned
//     movers; they don't block each other.
//   - If the moving photo is NOT pinned, we skip over any pinned occupants
//     and swap with the first non-pinned slot in that direction. Pinned
//     photos keep their absolute positions — non-pinned photos flow around
//     them.
// Returns the new index, or `idx` if no move was possible. Mutates `arr`.
function moveOne(
  arr: FlickrPhoto[],
  idx: number,
  direction: "up" | "down",
  pinnedSet: Set<string>,
): number {
  const step = direction === "up" ? -1 : 1
  const end = direction === "up" ? -1 : arr.length
  const movingId = arr[idx].id
  const isMovingPinned = pinnedSet.has(movingId)
  let t = idx + step
  while (t !== end) {
    const occupantId = arr[t].id
    // Moving-pinned can swap with any neighbour; non-pinned must find a
    // non-pinned slot (or itself) to land in.
    if (isMovingPinned || !pinnedSet.has(occupantId) || occupantId === movingId) {
      ;[arr[idx], arr[t]] = [arr[t], arr[idx]]
      return t
    }
    t += step
  }
  return idx
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
    // "jump to top" on a non-approved photo: approve AND insert as high in the
    // list as possible, skipping past any prefix of pinned photos. So index 0
    // if nothing pinned is there; otherwise the first non-pinned index.
    if (!photo) {
      return NextResponse.json({ error: "photo object required for approveAtTop" }, { status: 400 })
    }
    entry.approved = entry.approved.filter((p) => p.id !== photoId)
    const pinned = new Set(entry.pinnedIds ?? [])
    let insertAt = 0
    while (insertAt < entry.approved.length && pinned.has(entry.approved[insertAt].id)) insertAt++
    entry.approved.splice(insertAt, 0, photo)
  } else if (action === "unapprove") {
    entry.approved = entry.approved.filter((p) => p.id !== photoId)
    entry.pinnedIds = (entry.pinnedIds ?? []).filter((id) => id !== photoId)
  } else if (action === "pin") {
    // Pin = just mark the photo. It stays at its current index in approved[].
    // (Pinning implicitly approves, for the case where an admin pins from a
    // non-Approved tab — the photo gets appended to approved[] if absent.)
    if (!entry.approved.some((p) => p.id === photoId)) {
      if (!photo) {
        return NextResponse.json({ error: "photo object required to pin an unapproved photo" }, { status: 400 })
      }
      entry.approved.push(photo)
    }
    const prevPins = (entry.pinnedIds ?? []).filter((id) => id !== photoId)
    entry.pinnedIds = [...prevPins, photoId]
  } else if (action === "unpin") {
    // Unpin = just clear the badge. Photo keeps its position in approved[].
    entry.pinnedIds = (entry.pinnedIds ?? []).filter((id) => id !== photoId)
  } else if (action === "move") {
    // Pinned photos (other than the one being moved) are treated as fixed:
    // a move skips past them via swap-with-skip so their absolute index stays.
    //   "up" / "down" — one skip-step toward lower/higher index.
    //   "top"         — repeatedly skip-step up until no further move possible
    //                   (bubble to the topmost reachable slot).
    //   "bottom"      — mirror of "top".
    const idx = entry.approved.findIndex((p) => p.id === photoId)
    if (idx >= 0) {
      const pinnedSet = new Set(entry.pinnedIds ?? [])
      if (direction === "up" || direction === "down") {
        moveOne(entry.approved, idx, direction, pinnedSet)
      } else if (direction === "top" || direction === "bottom") {
        const step: "up" | "down" = direction === "top" ? "up" : "down"
        let cur = idx
        // Repeat until moveOne returns the same index (no further move).
        // Bounded by arr.length to be safe against any logic bug.
        for (let n = 0; n < entry.approved.length; n++) {
          const next = moveOne(entry.approved, cur, step, pinnedSet)
          if (next === cur) break
          cur = next
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
