import { NextRequest, NextResponse } from "next/server"
import fs from "fs"
import path from "path"

const FILE = path.join(process.cwd(), "data", "station-notes.json")

type NotesEntry = { name: string; publicNote: string; privateNote: string }

export async function POST(req: NextRequest) {
  const { coordKey, name, publicNote, privateNote } = await req.json()
  if (!coordKey) return NextResponse.json({ error: "missing coordKey" }, { status: 400 })

  const notes: Record<string, NotesEntry> = JSON.parse(fs.readFileSync(FILE, "utf-8"))

  if (publicNote || privateNote) {
    // Upsert — store name alongside notes for human readability
    notes[coordKey] = { name: name ?? coordKey, publicNote: publicNote ?? "", privateNote: privateNote ?? "" }
  } else {
    // Both empty — remove the entry entirely
    delete notes[coordKey]
  }

  fs.writeFileSync(FILE, JSON.stringify(notes, null, 2) + "\n", "utf-8")
  return NextResponse.json({ message: "ok" })
}

// GET returns all notes so the map can load them on startup
export async function GET() {
  const notes: Record<string, NotesEntry> = JSON.parse(fs.readFileSync(FILE, "utf-8"))
  return NextResponse.json(notes)
}
