/**
 * Dev-only endpoint that deletes a saved routing snapshot from disk.
 * Used by the admin "Force regenerate routing" button to clear a
 * stale precomputed file so a subsequent page reload runs the live
 * compute (and admin can then Save a fresh snapshot).
 */

import { NextRequest, NextResponse } from "next/server"
import fs from "fs/promises"
import path from "path"

export async function POST(req: NextRequest) {
  const { key } = await req.json()
  if (!key || typeof key !== "string" || !/^[a-z0-9-]+$/i.test(key)) {
    return NextResponse.json({ error: "invalid key" }, { status: 400 })
  }
  const filePath = path.join(process.cwd(), "public", "routing", `${key}.json`)
  try {
    await fs.unlink(filePath)
    return NextResponse.json({ message: `deleted ${key}.json` })
  } catch (err) {
    // ENOENT just means it didn't exist — treat as a no-op success
    // so repeated clicks don't error out.
    if ((err as { code?: string })?.code === "ENOENT") {
      return NextResponse.json({ message: `${key}.json already absent` })
    }
    return NextResponse.json(
      { error: "delete failed", detail: String(err) },
      { status: 500 },
    )
  }
}
