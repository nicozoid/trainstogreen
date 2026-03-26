import { NextRequest, NextResponse } from "next/server"
import fs from "fs"
import path from "path"

const FILE = path.join(process.cwd(), "data", "excluded-stations.json")

export async function POST(req: NextRequest) {
  const { name, coordKey } = await req.json()

  // Accept either a coordKey ("lng,lat") or a name — whichever matches the stored entry
  const entry = coordKey ?? name
  if (!entry) return NextResponse.json({ error: "missing name or coordKey" }, { status: 400 })

  const list: string[] = JSON.parse(fs.readFileSync(FILE, "utf-8"))
  const updated = list.filter((n) => n !== entry)

  if (updated.length === list.length) {
    return NextResponse.json({ error: `"${entry}" not found` }, { status: 404 })
  }

  fs.writeFileSync(FILE, JSON.stringify(updated, null, 2) + "\n", "utf-8")
  return NextResponse.json({ message: `re-included "${name ?? coordKey}"` })
}
