import { NextRequest, NextResponse } from "next/server"
import fs from "fs"
import path from "path"
import type { FlickrPhoto } from "@/lib/flickr"

const FILE = path.join(process.cwd(), "data", "photo-curations.json")

// Each station's curations: approved photos (full objects so they can always
// be displayed) and rejected photo IDs (just need the ID to filter them out).
type CurationEntry = {
  name: string
  approved: FlickrPhoto[]
  rejected: string[]
}

function readFile(): Record<string, CurationEntry> {
  return JSON.parse(fs.readFileSync(FILE, "utf-8"))
}

function writeFile(data: Record<string, CurationEntry>) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf-8")
}

// POST — approve or reject a photo for a station
// Body: { coordKey, name, photoId, action: "approve" | "reject", photo?: FlickrPhoto }
// "photo" is required when action is "approve" (stores the full object).
export async function POST(req: NextRequest) {
  const { coordKey, name, photoId, action, photo } = await req.json()

  if (!coordKey || !photoId || !action) {
    return NextResponse.json({ error: "missing coordKey, photoId, or action" }, { status: 400 })
  }

  const curations = readFile()
  const entry = curations[coordKey] ?? { name: name ?? coordKey, approved: [], rejected: [] }
  entry.name = name ?? entry.name

  if (action === "approve") {
    if (!photo) {
      return NextResponse.json({ error: "photo object required for approve" }, { status: 400 })
    }
    // Remove from rejected if it was there
    entry.rejected = entry.rejected.filter((id) => id !== photoId)
    // Add to approved if not already there
    if (!entry.approved.some((p) => p.id === photoId)) {
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
  } else {
    return NextResponse.json({ error: "action must be 'approve', 'reject', or 'unapprove'" }, { status: 400 })
  }

  // Clean up empty entries
  if (entry.approved.length === 0 && entry.rejected.length === 0) {
    delete curations[coordKey]
  } else {
    curations[coordKey] = entry
  }

  writeFile(curations)
  return NextResponse.json({ message: "ok" })
}

// GET — returns all curations so the modal can use them
export async function GET() {
  return NextResponse.json(readFile())
}
