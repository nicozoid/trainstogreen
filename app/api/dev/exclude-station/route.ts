import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/excluded-stations.json"

export async function POST(req: NextRequest) {
  const { name } = await req.json()
  if (!name) return NextResponse.json({ error: "missing name" }, { status: 400 })

  const entry = name

  const { data: list, sha } = await readDataFile<string[]>(FILE_PATH)

  if (list.includes(entry)) {
    return NextResponse.json({ message: "already excluded" })
  }

  list.push(entry)
  await writeDataFile(FILE_PATH, list, `Exclude ${name}`, sha)
  return NextResponse.json({ message: `excluded "${name}"` })
}
