import { NextRequest, NextResponse } from "next/server"
import { readDataFile, writeDataFile } from "@/lib/github-data"

const FILE_PATH = "data/photo-flickr-presets.json"

// Global presets for the three built-in Flickr algos. Editing any of these
// affects every station that uses that algo (as default or via fallback).
// The `custom` algo is per-station — lives in data/photo-flickr-settings.json.
export type PresetName = "landscapes" | "hikes" | "station"
export type Preset = {
  includeTags: string[]
  excludeTags: string[]
  radius: number // km
  sort: "relevance" | "interestingness-desc"
}
export type Presets = Record<PresetName, Preset>

const PRESET_NAMES: PresetName[] = ["landscapes", "hikes", "station"]

// Hardcoded originals — used by the "Reset to defaults" button. Must stay
// in sync with the initial data/photo-flickr-presets.json seed.
export const PRESET_DEFAULTS: Presets = {
  landscapes: {
    includeTags: ["landscape"],
    excludeTags: [
      "people", "girls", "boys", "children", "portrait", "portraits",
      "countryfashion", "countryoutfit", "countrystyle",
      "train", "tank", "railway", "trains", "railways", "station",
      "engine", "locomotive",
      "bus", "buses", "airbus", "airport", "airways", "airliner", "flight",
      "motorbike", "motorcycle",
      "paddleboarding",
      "object",
      "baby",
      "plane", "taps", "city", "town", "great western railways", "reading", "sexy", "midjourney",
      "protest", "demonstration", "demo", "march",
      "band", "music", "musicians",
    ],
    radius: 7,
    sort: "interestingness-desc",
  },
  hikes: {
    includeTags: [
      "landscape", "landmark", "hike", "trail", "walk", "way",
      "castle", "ruins", "garden", "park", "nature reserve", "nature",
      "cottage", "village", "thatch", "tudor", "medieval", "estate",
    ],
    excludeTags: [
      "people", "girls", "boys", "children", "portrait", "portraits",
      "countryfashion", "countryoutfit", "countrystyle",
      "train", "tank", "railway", "trains", "railways", "station",
      "engine", "locomotive",
      "bus", "buses", "airbus", "airport", "airways", "airliner", "flight",
      "motorbike", "motorcycle",
      "paddleboarding",
      "object",
      "baby",
      "plane", "taps", "city", "town", "great western railways", "reading", "sexy", "midjourney",
      "protest", "demonstration", "demo", "march",
      "band", "music", "musicians",
    ],
    radius: 7,
    sort: "interestingness-desc",
  },
  station: {
    includeTags: ["station", "city", "cityscape", "landmark", "urban", "architecture", "building"],
    excludeTags: [
      "portrait", "portraits",
      "countryfashion", "countryoutfit", "countrystyle",
      "paddleboarding",
      "baby",
      "taps", "reading", "sexy", "midjourney",
      "protest", "demonstration", "demo", "march",
      "band", "music", "musicians",
    ],
    radius: 1,
    sort: "interestingness-desc",
  },
}

function validatePreset(p: unknown): Preset | null {
  if (!p || typeof p !== "object") return null
  const obj = p as Record<string, unknown>
  if (!Array.isArray(obj.includeTags) || !Array.isArray(obj.excludeTags)) return null
  if (typeof obj.radius !== "number") return null
  const sort = obj.sort === "relevance" || obj.sort === "interestingness-desc" ? obj.sort : "interestingness-desc"
  return {
    includeTags: (obj.includeTags as unknown[]).map((t) => String(t).trim()).filter(Boolean),
    excludeTags: (obj.excludeTags as unknown[]).map((t) => String(t).trim()).filter(Boolean),
    radius: Math.max(0.1, Math.min(30, obj.radius)),
    sort,
  }
}

// GET — returns all three presets so the admin panel can hydrate.
export async function GET() {
  const { data } = await readDataFile<Partial<Presets>>(FILE_PATH)
  // Merge with defaults in case the file is missing a key (e.g. after a format migration).
  const merged: Presets = {
    landscapes: data.landscapes ?? PRESET_DEFAULTS.landscapes,
    hikes: data.hikes ?? PRESET_DEFAULTS.hikes,
    station: data.station ?? PRESET_DEFAULTS.station,
  }
  return NextResponse.json(merged)
}

// POST — update a single preset. Body: { name, preset } OR { name, reset: true }
// When `reset: true`, the preset is restored to PRESET_DEFAULTS.
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { name, preset, reset } = body as { name?: PresetName; preset?: Preset; reset?: boolean }

  if (!name || !PRESET_NAMES.includes(name)) {
    return NextResponse.json({ error: `name must be one of ${PRESET_NAMES.join(", ")}` }, { status: 400 })
  }

  const { data: current, sha } = await readDataFile<Partial<Presets>>(FILE_PATH)

  let nextPreset: Preset
  if (reset) {
    nextPreset = PRESET_DEFAULTS[name]
  } else {
    const validated = validatePreset(preset)
    if (!validated) {
      return NextResponse.json({ error: "preset must include includeTags[], excludeTags[], radius, sort" }, { status: 400 })
    }
    nextPreset = validated
  }

  const next: Presets = {
    landscapes: current.landscapes ?? PRESET_DEFAULTS.landscapes,
    hikes: current.hikes ?? PRESET_DEFAULTS.hikes,
    station: current.station ?? PRESET_DEFAULTS.station,
    [name]: nextPreset,
  }

  await writeDataFile(FILE_PATH, next, `${reset ? "reset" : "update"} flickr preset: ${name}`, sha)
  return NextResponse.json({ message: "ok", preset: nextPreset })
}
