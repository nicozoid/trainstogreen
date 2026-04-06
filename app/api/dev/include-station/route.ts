import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/excluded-stations.json"

export async function POST(req: NextRequest) {
  const { name, coordKey } = await req.json()

  // Accept either a coordKey ("lng,lat") or a name — whichever matches the stored entry
  const entry = coordKey ?? name
  if (!entry) return NextResponse.json({ error: "missing name or coordKey" }, { status: 400 })

  const { data: list, sha } = await readDataFile<string[]>(FILE_PATH)
  const updated = list.filter((n) => n !== entry)

  if (updated.length === list.length) {
    return NextResponse.json({ error: `"${entry}" not found` }, { status: 404 })
  }

  await writeDataFile(FILE_PATH, updated, `Re-include ${name ?? coordKey}`, sha)
  return NextResponse.json({ message: `re-included "${name ?? coordKey}"` })
}
