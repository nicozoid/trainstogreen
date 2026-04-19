# Adding a new primary origin station

This document walks through the full process for wiring a new station into
the "Max time from ___" dropdown, using Realtime Trains API data for direct
routes + the existing terminal matrix for via-central-London stitching.

Charing Cross was the first origin added this way; the same steps apply to
other London National Rail terminals.

---

## Prerequisites

- RTT API token (a long-life refresh token from <https://api-portal.rtt.io>).
  Export it as `RTT_TOKEN` when running the fetch script. The token is
  personal and should never be committed.
- Google Maps Routes API key (only needed if the new origin isn't already in
  `data/terminal-matrix.json` and you want stitcher coverage — see
  "Non-terminal origins" below).

---

## Step-by-step: adding a standard London terminal

### 1. Identify the station

- Pick the National Rail station (not the Underground entry if both exist).
- Look up its CRS three-letter code. Either check
  <https://www.nationalrail.co.uk/stations/> or query our own dataset:

  ```sh
  jq -r '.features[] | select(.properties.name == "Victoria" and (.properties.network // "") | test("National Rail")) | "\(.properties["ref:crs"]) \(.geometry.coordinates[0]),\(.geometry.coordinates[1])"' public/stations.json
  ```

- Write down: CRS code, "lng,lat" coord key, canonical name as it appears in
  `public/stations.json`.

### 2. Run the RTT direct-reachable fetch

```sh
RTT_TOKEN=<your-jwt> node scripts/fetch-direct-reachable.mjs <CRS>
```

The script samples the next Saturday, 07:00–12:00 (our agreed day-hiker
window — do NOT change to weekday without a reason, weekend service patterns
differ). It writes to `data/origin-routes.json`, merging into whatever's
already there.

**Quota:** paces at one call every 2.1 s to stay under RTT's 30/min cap.
Typical London terminal: 150–300 services over the window, so ~5–10 minutes
and ~300 API calls. Well inside the 750/hour and 9,000/day limits.

**Flaky responses:** expect ~50% of service-detail queries to return HTTP
502 for some operator's services (we saw this for Southeastern `P-prefix`
headcodes at CHX). Rerunning does not help — the RTT backend is consistently
missing data for those records. The destination set captured from the
services that DO work is still complete in practice, because every stopping
pattern is usually covered by more than one service.

### 3. Verify the fetch output

Spot-check the output before wiring it in:

```sh
jq '.["<coord-key>"] | {stationCount: (.directReachable | length), generatedAt, sample: (.directReachable | to_entries | .[0:10] | map({name: .value.name, mins: .value.minMinutes, services: .value.services}))}' data/origin-routes.json
```

Sanity checks:
- `stationCount` > 20 for a meaningful London terminal.
- Nearest stations (Waterloo East, London Bridge for CHX) have `mins` in
  single digits and high `services` counts.
- Long-distance stations (Hastings, Canterbury etc.) have plausible times.

### 4. Add the origin to `PRIMARY_ORIGINS` in [components/map.tsx](../components/map.tsx)

Find the `PRIMARY_ORIGINS` object and add an entry keyed by coord string:

```ts
const PRIMARY_ORIGINS: Record<string, OriginDef> = {
  // ... existing entries
  "<lng,lat>": {
    canonicalName: "<exact name from public/stations.json>",
    displayName: "<short label for filter trigger and map label>",
    menuName: "<longer label for dropdown menu>",
    adminOnly: true,  // optional — keep while coverage is being validated
  },
}
```

**Rules:**
- `canonicalName` MUST match the station's name in both
  `public/stations.json` AND `data/london-terminals.json` (by which the
  stitcher looks up the Terminal record).
- Coord key MUST match the station's coord in `public/stations.json`
  exactly (not the terminal list's approximate coords).
- Add the coord key to `PRIMARY_ORIGIN_GROUPS_ALL`. If admin-only, put it in
  the admin group at the end; if public, add to the first group.

### 5. Confirm the station is in `data/london-terminals.json`

If missing, add it. Required fields: `name`, `lat`, `lng`, `aliases` (Google
variants like "London Charing Cross"). This is what makes the stitcher able
to recognise the new origin as a valid transfer point.

### 6. Confirm the terminal matrix has a row for the new origin

```sh
jq '.["<exact name>"] | keys' data/terminal-matrix.json
```

All 13 existing London terminals already have matrix rows. If you're adding
a 14th terminal (rare), you'd need to run `scripts/fetch-terminal-matrix.mjs`
to populate its row using the Google Routes API. That's ~26 API calls (one
for each direction to/from each other terminal). Mind the Routes quota.

### 7. Verify in the preview

- Reload the dev server, admin-click the hexagon if the origin is
  `adminOnly`, and select the new origin from the dropdown.
- Expect the SE/N/W/etc. destinations on the origin's lines to populate
  with real timetable times.
- Expect long-distance destinations (Swindon, Bedford, etc.) to populate
  with stitched-via-matrix times.
- Hover destinations — the journey-trace animation should draw along the
  calling points.
- Click a destination — the modal should say "X hours and Y minutes from
  \<origin\>. N changes: ..." with correct grammar.

### 8. When to drop `adminOnly`

After a few sessions of manual verification where the times feel right, drop
the `adminOnly: true` flag in `PRIMARY_ORIGINS` so the origin becomes public
in the dropdown. At that point it's no longer experimental.

---

## Non-terminal origins (Clapham Junction, Highbury & Islington, Lewisham, etc.)

The stitcher relies on `london-terminals.json` + `data/terminal-matrix.json`.
If the new origin isn't one of the 13 NR London terminals, it can only use
RTT direct-reachable data — no stitching. Consequences:

- Coverage is limited to stations directly served by trains that call at the
  origin (typically 50–200 stations).
- Long-distance destinations via an HS1-style change are NOT reachable from
  this origin in the data.

**Options to extend coverage:**

1. Accept the limited set. For an origin serving a dense suburban network
   (e.g. Lewisham with its SE commuter routes) this might already cover the
   bulk of day-hike destinations.
2. Add the origin to `london-terminals.json` and run
   `scripts/fetch-terminal-matrix.mjs` to generate matrix rows. Costs ~26
   Google Routes API calls per new "terminal". Overkill for one-off origins
   but worth it for major hubs like Clapham Junction.
3. Add Layer-3 "change at a hub outside central London" support — not yet
   implemented. Would require running `fetch-direct-reachable.mjs` for
   intermediate hubs (e.g. Tonbridge for Hastings via SE trains) and
   chaining direct journeys in the app's lookup logic. Non-trivial.

---

## Data refresh

Network Rail timetables change in May and December each year. When either
changes meaningfully, rerun `fetch-direct-reachable.mjs` for every RTT-based
origin. Everything else in `data/origin-routes.json` is a pure function of
the script + timetable, so regenerating is safe.

The Routes-API-sourced journeys (Farringdon, KX, Stratford) live in
`public/stations.json` and are refreshed via `scripts/fetch-journeys.mjs`.
That script also targets Saturday mornings (`nextSaturday()`) and should be
rerun at timetable-change time.

---

## Reference: files touched per new origin

| File | What changes |
|------|--------------|
| `data/origin-routes.json` | New entry keyed by origin coord with `directReachable` map |
| `components/map.tsx` | New entry in `PRIMARY_ORIGINS` + `PRIMARY_ORIGIN_GROUPS_ALL` |
| `data/london-terminals.json` | Only if the origin isn't already a known terminal |
| `data/terminal-matrix.json` | Only if adding a new terminal (costs Google Routes API calls) |

No code changes are required for new origins beyond the map.tsx constant
updates — the RTT + stitcher pipeline is fully generic.
