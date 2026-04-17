import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/excluded-stations.json"

export async function POST(req: NextRequest) {
  const { name, coordKey } = await req.json()
  // coordKey is REQUIRED. Name entries cause duplicate-name cascades (e.g. excluding
  // "Rainham" would hide both the Kent and London ones). `name` is accepted only for
  // the commit message — the stored entry is always the coordKey.
  if (!coordKey || typeof coordKey !== "string") {
    return NextResponse.json({ error: "missing or invalid coordKey" }, { status: 400 })
  }

  const { data: list, sha } = await readDataFile<string[]>(FILE_PATH)

  if (list.includes(coordKey)) {
    return NextResponse.json({ message: "already excluded" })
  }

  list.push(coordKey)
  await writeDataFile(FILE_PATH, list, `Exclude ${name ?? coordKey}`, sha)
  return NextResponse.json({ message: `excluded "${name ?? coordKey}"` })
}
