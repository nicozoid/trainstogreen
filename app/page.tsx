"use client"

// We import dynamically to prevent Next.js from trying to render the map on the server.
// "ssr: false" means it only loads in the browser — required for Mapbox.
import dynamic from "next/dynamic"

const HikeMap = dynamic(() => import("@/components/map"), { ssr: false })

export default function Page() {
  return (
    // h-dvh = 100% of the dynamic viewport height (better than vh on mobile)
    <main className="h-dvh w-full">
      <HikeMap />
    </main>
  )
}
