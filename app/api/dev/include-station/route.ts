import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/excluded-stations.json"

export async function POST(req: NextRequest) {
  const { name, coordKey } = await req.json()

  // coordKey is REQUIRED. The excluded-stations file is now coordKey-only, so
  // re-inclusion must target a specific coordinate. `name` is accepted only for
  // the commit message and logs.
  if (!coordKey || typeof coordKey !== "string") {
    return NextResponse.json({ error: "missing or invalid coordKey" }, { status: 400 })
  }

  const { data: list, sha } = await readDataFile<string[]>(FILE_PATH)
  const updated = list.filter((n) => n !== coordKey)

  if (updated.length === list.length) {
    return NextResponse.json({ error: `"${coordKey}" not found` }, { status: 404 })
  }

  await writeDataFile(FILE_PATH, updated, `Re-include ${name ?? coordKey}`, sha)
  return NextResponse.json({ message: `re-included "${name ?? coordKey}"` })
}
