import { NextResponse } from "next/server"
import { readDataFile } from "@/lib/github-data"

const FILE_PATH = "data/station-months.json"

type MonthCode =
  | "jan" | "feb" | "mar" | "apr" | "may" | "jun"
  | "jul" | "aug" | "sep" | "oct" | "nov" | "dec"
type MonthsEntry = { name: string; months: MonthCode[] }

// Read-only: station-months.json is a pure build output, derived from
// each walk variant's structured `bestSeasons` month-code field in
// scripts/build-rambler-notes.mjs. No POST — the admin UI used to edit
// station-level metadata directly, but month data now flows from walk
// data. Edit `bestSeasons` on the walk variants instead and re-run the
// build script.
export async function GET() {
  const { data: all } = await readDataFile<Record<string, MonthsEntry>>(FILE_PATH)
  return NextResponse.json(all)
}
