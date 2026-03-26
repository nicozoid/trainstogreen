import { NextRequest, NextResponse } from "next/server"
import fs from "fs"
import path from "path"

const FILE = path.join(process.cwd(), "data", "excluded-stations.json")

export async function POST(req: NextRequest) {
  const { name, coordKey } = await req.json()
  if (!name) return NextResponse.json({ error: "missing name" }, { status: 400 })

  // Store the coordinate key when available — "lng,lat" is unique per station even
  // when two stations share a name (e.g. Newport Essex vs Newport Wales).
  // Fall back to name for any callers that don't provide a coordKey.
  const entry = coordKey ?? name

  const list: string[] = JSON.parse(fs.readFileSync(FILE, "utf-8"))

  if (list.includes(entry)) {
    return NextResponse.json({ message: "already excluded" })
  }

  list.push(entry)
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2) + "\n", "utf-8")
  return NextResponse.json({ message: `excluded "${name}"` })
}
