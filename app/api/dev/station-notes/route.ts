import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"
import { handleAdminWrite } from "@/app/api/dev/_helpers"

const FILE_PATH = "data/station-notes.json"

type NotesEntry = {
  name: string
  publicNote: string
  privateNote: string
  // Build-output walk fields — written by scripts/build-rambler-notes.mjs.
  // NOT writable through this endpoint; structured walk edits go through
  // /api/dev/walk/[id] which rewrites the source walk JSON and re-runs
  // the build. The four below are preserved when this route writes the
  // user-editable publicNote/privateNote so we don't clobber them.
  adminWalksAll?: string
  publicWalksS2S?: string
  publicWalksCircular?: string
}

// POST accepts publicNote and privateNote only. The build-output walk
// fields are preserved on the existing entry so user-note edits don't
// clobber them.
export async function POST(req: NextRequest) {
  const { coordKey, name, publicNote, privateNote } = await req.json()
  if (!coordKey) return NextResponse.json({ error: "missing coordKey" }, { status: 400 })

  return handleAdminWrite(async () => {
    const { data: notes, sha } = await readDataFile<Record<string, NotesEntry>>(FILE_PATH)

    const existing = notes[coordKey]
    const existingAdminAll = existing?.adminWalksAll ?? ""
    const existingPublicS2S = existing?.publicWalksS2S ?? ""
    const existingPublicCircular = existing?.publicWalksCircular ?? ""
    const hasAnyExistingWalkProse =
      existingAdminAll || existingPublicS2S || existingPublicCircular

    if (publicNote || privateNote || hasAnyExistingWalkProse) {
      notes[coordKey] = {
        name: name ?? coordKey,
        publicNote: publicNote ?? "",
        privateNote: privateNote ?? "",
        adminWalksAll: existingAdminAll,
        publicWalksS2S: existingPublicS2S,
        publicWalksCircular: existingPublicCircular,
      }
    } else {
      // Everything empty — remove the entry entirely
      delete notes[coordKey]
    }

    await writeDataFile(FILE_PATH, notes, `Update notes for ${name ?? coordKey}`, sha)
    return NextResponse.json({ message: "ok" })
  })
}

// GET returns all notes so the map can load them on startup
export async function GET() {
  const { data: notes } = await readDataFile<Record<string, NotesEntry>>(FILE_PATH)
  return NextResponse.json(notes)
}
