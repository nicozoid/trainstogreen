import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"
import type { FlickrPhoto } from "@/lib/flickr"

const FILE_PATH = "data/photo-curations.json"

// Each station's curations: approved photos (full objects so they can always
// be displayed) and rejected photo IDs (just need the ID to filter them out).
type CurationEntry = {
  name: string
  approved: FlickrPhoto[]
  rejected: string[]
}

// POST — approve or reject a photo for a station
// Body: { coordKey, name, photoId, action: "approve" | "reject", photo?: FlickrPhoto }
// "photo" is required when action is "approve" (stores the full object).
export async function POST(req: NextRequest) {
  const { coordKey, name, photoId, action, photo, direction } = await req.json()

  if (!coordKey || !photoId || !action) {
    return NextResponse.json({ error: "missing coordKey, photoId, or action" }, { status: 400 })
  }

  const { data: curations, sha } = await readDataFile<Record<string, CurationEntry>>(FILE_PATH)
  const entry = curations[coordKey] ?? { name: name ?? coordKey, approved: [], rejected: [] }
  entry.name = name ?? entry.name

  if (action === "approve") {
    if (!photo) {
      return NextResponse.json({ error: "photo object required for approve" }, { status: 400 })
    }
    // Remove from rejected if it was there
    entry.rejected = entry.rejected.filter((id) => id !== photoId)
    // Add to approved if not already there. Approved list is capped at
    // MAX_APPROVED (mirrors MAX_PHOTOS in photo-overlay.tsx); once the
    // cap is hit, a new approval replaces the last (12th) photo.
    // The displaced photo returns to neutral state — not rejected — so
    // it can be re-approved later or surface as a Flickr candidate again.
    const MAX_APPROVED = 12
    if (!entry.approved.some((p) => p.id === photoId)) {
      if (entry.approved.length >= MAX_APPROVED) {
        entry.approved = entry.approved.slice(0, MAX_APPROVED - 1)
      }
      entry.approved.push(photo)
    }
  } else if (action === "reject") {
    // Remove from approved if it was there
    entry.approved = entry.approved.filter((p) => p.id !== photoId)
    // Add to rejected if not already there
    if (!entry.rejected.includes(photoId)) {
      entry.rejected.push(photoId)
    }
  } else if (action === "unapprove") {
    // Remove from approved without adding to rejected — photo returns to neutral state
    entry.approved = entry.approved.filter((p) => p.id !== photoId)
  } else if (action === "move") {
    // "top"    — jump to the front.
    // "bottom" — jump to the 12th slot (index 11). Matches the overlay cap
    //            of 12 visible photos: "bottom" means bottom-of-visible, not
    //            true end of list. On stations with <12 approved this
    //            degrades to append (splice clamps to end).
    // "up" / "down" — single-step swap with the neighbour.
    const idx = entry.approved.findIndex((p) => p.id === photoId)
    if (idx >= 0) {
      if (direction === "top") {
        const [photo] = entry.approved.splice(idx, 1)
        entry.approved.unshift(photo)
      } else if (direction === "bottom") {
        const [photo] = entry.approved.splice(idx, 1)
        const targetIdx = Math.min(11, entry.approved.length)
        entry.approved.splice(targetIdx, 0, photo)
      } else if (direction === "end") {
        // True end of approved list — used by refresh on approved photos
        // to demote them past the visible 12.
        const [photo] = entry.approved.splice(idx, 1)
        entry.approved.push(photo)
      } else {
        const targetIdx = direction === "up" ? idx - 1 : idx + 1
        if (targetIdx >= 0 && targetIdx < entry.approved.length) {
          ;[entry.approved[idx], entry.approved[targetIdx]] = [entry.approved[targetIdx], entry.approved[idx]]
        }
      }
    }
  } else {
    return NextResponse.json({ error: "action must be 'approve', 'reject', 'unapprove', or 'move'" }, { status: 400 })
  }

  // Clean up empty entries
  if (entry.approved.length === 0 && entry.rejected.length === 0) {
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
