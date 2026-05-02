import path from "node:path"
import { NextResponse } from "next/server"
import { ConflictError, commitMultipleDataFiles, readDataFile } from "@/lib/github-data"
import { buildRamblerNotes } from "@/scripts/build-rambler-notes.mjs"

// Mirrors WALKS_FILES in app/api/dev/walk/[id]/route.ts and
// WALKS_PATH + EXTRA_WALKS_PATHS in scripts/build-rambler-notes.mjs.
// Keep all three in sync if walk source files are added or removed.
const WALKS_FILES = [
  "data/rambler-walks.json",
  "data/leicester-ramblers-walks.json",
  "data/heart-rail-trails-walks.json",
  "data/abbey-line-walks.json",
  "data/manual-walks.json",
]
const NOTES_FILE = "data/station-notes.json"

/**
 * Wraps an admin-write route handler with automatic conflict-retry and
 * normalized error responses.
 *
 * Most admin routes follow a read → mutate → write pattern against a single
 * `data/*.json` file. If two writes race, GitHub rejects the second with a
 * SHA-mismatch error (surfaced as ConflictError by `lib/github-data`). This
 * wrapper catches that and re-runs the whole handler, which causes a fresh
 * read of the file and a fresh mutation against the latest state. After
 * MAX_ATTEMPTS we give up and surface a 409 to the client.
 *
 * The handler must be safely re-runnable: don't mutate inputs, don't perform
 * non-idempotent side effects outside the JSON write itself. Reading the
 * request body (`await req.json()`) must happen OUTSIDE this wrapper, because
 * the body stream can only be consumed once.
 *
 * Non-conflict errors are caught, logged, and returned as JSON 500s so the
 * outbox drainer on the client gets a predictable shape.
 */
export async function handleAdminWrite(
  handler: () => Promise<Response>,
): Promise<Response> {
  const MAX_ATTEMPTS = 3
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await handler()
    } catch (e) {
      lastErr = e
      if (e instanceof ConflictError) continue
      console.error("admin write failed:", e)
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "save failed" },
        { status: 500 },
      )
    }
  }
  console.error("admin write conflict-retry exhausted:", lastErr)
  return NextResponse.json(
    { error: "conflict — please retry" },
    { status: 409 },
  )
}

/**
 * Save a walk: commit the source walk file AND the rebuilt derived
 * station-* files in a SINGLE commit. Called after every walk save
 * (create/edit/delete) so the public view (which reads
 * station-notes.json) stays in sync with the walk data without anyone
 * having to remember to run the build script and stage the result.
 *
 * Why one bundled commit instead of one-per-file:
 * - Each commit on a non-main branch triggers its own Vercel preview
 *   deploy. Saving one walk used to produce 5 commits (source +
 *   4 derived) → 5 stacked previews. Bundling makes it 1 deploy.
 * - The save is also more atomic: derived files can't get out of sync
 *   with the source file because they all land in the same commit.
 *
 * In local dev (no GITHUB_TOKEN) this just writes each file straight
 * to disk via fs.writeFileSync — no git involvement. Same net effect
 * as the build script, just routed through one path.
 */
export async function commitWalkSave(
  sourceFile: { path: string; data: unknown },
  baseMessage: string,
): Promise<void> {
  // returnData: true makes buildRamblerNotes return the computed
  // datasets instead of writing files; the non-null assertion below is
  // safe because of that flag (the script only returns undefined in
  // its CLI/file-write mode).
  //
  // The build script reads every walk source file plus station-notes.
  // json via readFileSync. On Vercel, the serverless function's
  // filesystem is the deploy-time snapshot — frozen at build time and
  // never updated by GitHub commits this function makes. So in a
  // sequential admin loop ("pull all" Komoot, etc.) every PATCH after
  // the first would rebuild prose from STALE copies of every walk
  // file except the one currently being mutated, silently reverting
  // earlier walks' updates in station-notes.json. To prevent that,
  // fetch fresh copies of every walk file + station-notes.json from
  // GitHub here and pass them into the build as overrides. Map keys
  // are absolute paths because that's what the build resolves
  // WALKS_PATH / EXTRA_WALKS_PATHS to via path.join.
  const overrideWalks = new Map<string, unknown>()
  await Promise.all(
    WALKS_FILES.map(async (file) => {
      const abs = path.resolve(process.cwd(), file)
      if (file === sourceFile.path) {
        // Just-mutated file — use the in-memory edit directly. The
        // PATCH handler already read the fresh GitHub version before
        // applying its mutation, so this carries the latest committed
        // state of every OTHER walk in the same file.
        overrideWalks.set(abs, sourceFile.data)
        return
      }
      try {
        const { data } = await readDataFile<unknown>(file)
        overrideWalks.set(abs, data)
      } catch {
        // Optional walk files (manual-walks.json etc.) may legitimately
        // be missing in some envs. The build's loadAllWalks already
        // tolerates ENOENT for the same files, so skipping is fine.
      }
    }),
  )

  // station-notes.json is admin-editable independently (the notes
  // endpoint writes it directly), so a stale on-disk copy could revert
  // recent hand-authored note edits when the build's rewrite lands.
  let overrideNotes: unknown
  try {
    const { data } = await readDataFile<unknown>(NOTES_FILE)
    overrideNotes = data
  } catch {
    // First-deploy edge case (file doesn't exist yet) — fall back to
    // the build's own readFileSync, which will throw with a clearer
    // error if it's a real problem.
  }

  const built = (await buildRamblerNotes({
    dryRun: false,
    flipOnMap: false,
    returnData: true,
    overrideWalks,
    overrideNotes,
  }))!

  await commitMultipleDataFiles(
    [
      sourceFile,
      { path: "data/station-notes.json", data: built.notes },
      { path: "data/station-months.json", data: built.months },
      { path: "data/stations-hiked.json", data: built.hiked },
      { path: "data/stations-with-komoot.json", data: built.komoot },
      { path: "data/stations-potential-months.json", data: built.potentialMonths },
      { path: "data/stations-by-source.json", data: built.bySource },
    ],
    baseMessage,
  )
}
