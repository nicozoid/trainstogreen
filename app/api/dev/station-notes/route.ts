import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/station-notes.json"

type NotesEntry = { name: string; publicNote: string; privateNote: string; ramblerNote?: string }

export async function POST(req: NextRequest) {
  const { coordKey, name, publicNote, privateNote, ramblerNote } = await req.json()
  if (!coordKey) return NextResponse.json({ error: "missing coordKey" }, { status: 400 })

  const { data: notes, sha } = await readDataFile<Record<string, NotesEntry>>(FILE_PATH)

  if (publicNote || privateNote || ramblerNote) {
    // Upsert — store name alongside notes for human readability
    notes[coordKey] = {
      name: name ?? coordKey,
      publicNote: publicNote ?? "",
      privateNote: privateNote ?? "",
      ramblerNote: ramblerNote ?? "",
    }
  } else {
    // All empty — remove the entry entirely
    delete notes[coordKey]
  }

  await writeDataFile(FILE_PATH, notes, `Update notes for ${name ?? coordKey}`, sha)
  return NextResponse.json({ message: "ok" })
}

// GET returns all notes so the map can load them on startup
export async function GET() {
  const { data: notes } = await readDataFile<Record<string, NotesEntry>>(FILE_PATH)
  return NextResponse.json(notes)
}
