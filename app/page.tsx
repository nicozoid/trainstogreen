"use client"

// We import dynamically to prevent Next.js from trying to render the map on the server.
// "ssr: false" means it only loads in the browser — required for Mapbox.
import dynamic from "next/dynamic"
import { ThemeToggle } from "@/components/theme-toggle"

const HikeMap = dynamic(() => import("@/components/map"), { ssr: false })

export default function Page() {
  return (
    // h-dvh = 100% of the dynamic viewport height (better than vh on mobile)
    <main className="h-dvh w-full relative">
      <HikeMap />
      {/* Theme toggle floats over the map in the top-right corner.
          hidden md:block = hidden on mobile, visible from md (768px) up.
          On mobile, we always use light mode (enforced in ThemeToggle).
          Sits at right-14 (not right-4) so the help button — rendered inside
          the map at right-4 — gets the outermost slot. */}
      <div className="hidden md:block absolute top-4 right-14 z-50">
        <ThemeToggle />
      </div>
    </main>
  )
}
