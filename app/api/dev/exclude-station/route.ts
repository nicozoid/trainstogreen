import { NextRequest, NextResponse } from "next/server"
import fs from "fs"
import path from "path"

const FILE = path.join(process.cwd(), "data", "excluded-stations.json")

export async function POST(req: NextRequest) {
  const { name } = await req.json()
  if (!name) return NextResponse.json({ error: "missing name" }, { status: 400 })

  const entry = name

  const list: string[] = JSON.parse(fs.readFileSync(FILE, "utf-8"))

  if (list.includes(entry)) {
    return NextResponse.json({ message: "already excluded" })
  }

  list.push(entry)
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2) + "\n", "utf-8")
  return NextResponse.json({ message: `excluded "${name}"` })
}
