// Admin-only: mark a (home origin → destination) pair as tested-and-approved.
// Surfaces in the photo-overlay as a checkbox (admin-only). The map then
// stops tinting the station icon red for that primary/destination combo.
//
// Data shape on disk — `data/approved-journeys.json`:
//   {
//     "homeCoord|destCoord": {
//        homeName: string,
//        destName: string,
//        approvedAt: string  // ISO timestamp
//     },
//     …
//   }
//
// Composite "home|dest" keys keep lookups cheap (Set.has) and avoid
// nested-object churn when approving/unapproving a single pair.
import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/approved-journeys.json"

type ApprovalEntry = {
  homeName: string
  destName: string
  approvedAt: string
}

function compositeKey(homeCoord: string, destCoord: string) {
  return `${homeCoord}|${destCoord}`
}

export async function POST(req: NextRequest) {
  const { homeCoord, destCoord, homeName, destName, approved } = await req.json()
  if (!homeCoord || !destCoord) {
    return NextResponse.json({ error: "missing homeCoord or destCoord" }, { status: 400 })
  }
  const { data: approvals, sha } =
    await readDataFile<Record<string, ApprovalEntry>>(FILE_PATH)
  const key = compositeKey(homeCoord, destCoord)
  if (approved) {
    approvals[key] = {
      homeName: homeName ?? homeCoord,
      destName: destName ?? destCoord,
      approvedAt: new Date().toISOString(),
    }
  } else {
    delete approvals[key]
  }
  await writeDataFile(
    FILE_PATH,
    approvals,
    `${approved ? "Approve" : "Unapprove"} ${homeName ?? homeCoord} → ${destName ?? destCoord}`,
    sha,
  )
  return NextResponse.json({ message: "ok" })
}

// GET returns a flat array of composite keys — the map layer only needs
// membership checks, not the name/timestamp metadata.
export async function GET() {
  const { data } = await readDataFile<Record<string, ApprovalEntry>>(FILE_PATH)
  return NextResponse.json(Object.keys(data))
}
