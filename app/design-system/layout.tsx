/**
 * Layout for the entire /design-system route tree.
 *
 * Next.js auto-applies this layout to every page under
 * app/design-system/**. It wraps all DS pages in <DsShell> (sidebar +
 * theme toggle) — no individual page has to re-render the chrome.
 *
 * Note we don't import or wrap any of the main app's providers here.
 * The root layout (app/layout.tsx) already mounts ThemeProvider,
 * TooltipProvider, and AdminProvider, and that wrapping flows down
 * to ALL routes — including this one. So we get next-themes "for
 * free" without needing to mount it again.
 *
 * What we DO override: the main app's <body> has `overflow: hidden`
 * to suit the full-screen map. The DS app expects normal scrolling.
 * <DsShell> wraps its content in a normal-flow <main>, but the body
 * rule still applies. To opt out, we put the shell inside a div
 * with overflow-y-auto and a height that isn't pinned to the body.
 * The `h-dvh` on DsShell's grid handles this — the inner area
 * scrolls within itself rather than relying on the body.
 */

import { DsShell } from "@/components/design-system/ds-shell"

export const metadata = {
  title: "Design system | Trains to Green",
}

export default function DesignSystemLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DsShell>{children}</DsShell>
}
