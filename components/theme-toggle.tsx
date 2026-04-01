"use client"

import { useTheme } from "next-themes"
import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Icon button that toggles between light and dark mode.
 * Uses next-themes under the hood — the theme class is applied to <html>,
 * which activates the .dark color variables in globals.css.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      aria-label="Toggle dark mode"
      /* bg-background/60 = semi-transparent fill; hover:bg-background = solid on hover.
         backdrop-blur-sm softens the map beneath the translucent fill. */
      className="bg-background/60 backdrop-blur-sm hover:bg-background transition-colors cursor-pointer"
    >
      {/* Sun shows in light mode, Moon shows in dark mode.
          We render both and hide/show with Tailwind's dark: variant. */}
      <Sun className="size-4 scale-100 dark:scale-0 transition-transform" />
      <Moon className="absolute size-4 scale-0 dark:scale-100 transition-transform" />
    </Button>
  )
}
