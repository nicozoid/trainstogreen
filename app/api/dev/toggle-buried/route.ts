import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"
import { handleAdminWrite } from "@/app/api/dev/_helpers"

const FILE_PATH = "data/buried-stations.json"

// Single toggle endpoint — replaces the previous exclude/include split.
// `coordKey` is required (names cause duplicate-name cascades). `name` is
// accepted only for the commit message.
export async function POST(req: NextRequest) {
  const { name, coordKey } = await req.json()
  if (!coordKey || typeof coordKey !== "string") {
    return NextResponse.json({ error: "missing or invalid coordKey" }, { status: 400 })
  }

  return handleAdminWrite(async () => {
    const { data: list, sha } = await readDataFile<string[]>(FILE_PATH)
    const has = list.includes(coordKey)
    const updated = has ? list.filter((n) => n !== coordKey) : [...list, coordKey]
    const verb = has ? "Unbury" : "Bury"
    await writeDataFile(FILE_PATH, updated, `${verb} ${name ?? coordKey}`, sha)
    return NextResponse.json({ message: `${verb.toLowerCase()}: ${name ?? coordKey}`, buried: !has })
  })
}
