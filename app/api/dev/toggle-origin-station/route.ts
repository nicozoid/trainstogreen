import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

// Shared data file that lists every "origin" station (marker squares,
// excluded from destination results).
const FILE_PATH = "data/origin-stations.json"

// Toggles a station's origin status. Body: { name, isOrigin }
// - isOrigin: true  → add name to list (if not already there)
// - isOrigin: false → remove name from list (if present)
export async function POST(req: NextRequest) {
  const { name, isOrigin } = await req.json()
  if (!name) return NextResponse.json({ error: "missing name" }, { status: 400 })

  const { data: list, sha } = await readDataFile<string[]>(FILE_PATH)

  if (isOrigin) {
    if (list.includes(name)) {
      return NextResponse.json({ message: "already an origin" })
    }
    list.push(name)
    await writeDataFile(FILE_PATH, list, `Mark ${name} as origin`, sha)
    return NextResponse.json({ message: `marked "${name}" as origin` })
  } else {
    const updated = list.filter((n) => n !== name)
    if (updated.length === list.length) {
      return NextResponse.json({ error: `"${name}" not found` }, { status: 404 })
    }
    await writeDataFile(FILE_PATH, updated, `Unmark ${name} as origin`, sha)
    return NextResponse.json({ message: `unmarked "${name}" as origin` })
  }
}
