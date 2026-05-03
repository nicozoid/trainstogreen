// Headless smoke test for the Phase 2 composer wiring. Loads the app,
// waits for the map to mount, and fails if anything mentioning the new
// modules surfaces in console errors.
//
// Run: npx tsx scripts/smoke-test-composer.ts

import { chromium } from "playwright"

const url = "http://localhost:3000/?admin=1&primary=KGX"

const errors: string[] = []
const warnings: string[] = []

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await context.newPage()

page.on("console", (msg) => {
  const t = msg.type()
  const text = msg.text()
  if (t === "error") errors.push(text)
  else if (t === "warning") warnings.push(text)
})
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`))

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
  // Wait for the Mapbox canvas to mount (best signal the map booted).
  await page.waitForSelector("canvas.mapboxgl-canvas", { timeout: 30000 })
  // Give the journey/origin-routes data a chance to settle.
  await page.waitForTimeout(3000)
  console.log("✓ page loaded; map canvas mounted")
} catch (e) {
  console.error("✗ page load failed:", e)
  await browser.close()
  process.exit(1)
}

await browser.close()

const composerErrors = errors.filter(
  (e) =>
    /journey-composer|compose-segment|rail-segments|composePolylineForJourney/i.test(e),
)

console.log(`\nconsole errors:   ${errors.length}`)
console.log(`composer-related: ${composerErrors.length}`)
if (composerErrors.length > 0) {
  console.log("\nCOMPOSER ERRORS:")
  for (const e of composerErrors) console.log(`  - ${e}`)
  process.exit(1)
}
if (errors.length > 0) {
  console.log("\nother errors (top 5):")
  for (const e of errors.slice(0, 5)) console.log(`  - ${e}`)
}
console.log("\n✓ smoke test passed (no composer-related runtime errors)")
