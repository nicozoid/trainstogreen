import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { TooltipProvider } from "@/components/ui/tooltip"
import FilterPanel from "./filter-panel"

// FilterPanel uses Tooltip internally, so we need TooltipProvider as a wrapper.
// `decorators` wrap every story — same concept as React context providers.
const meta: Meta<typeof FilterPanel> = {
  title: "Components/FilterPanel",
  component: FilterPanel,
  decorators: [
    (Story) => (
      <TooltipProvider>
        {/* Give it a dark background so the card stands out, like on the map */}
        <div className="relative min-h-[500px] bg-muted/50 p-4">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof FilterPanel>

// Interactive story — uses React state so the controls actually work.
// `render` gives us full control over the component's JSX and state.
export const Interactive: Story = {
  render: () => {
    /* eslint-disable react-hooks/rules-of-hooks -- Storybook render functions are components */
    const [maxMinutes, setMaxMinutes] = useState(90)
    const [showTrails, setShowTrails] = useState(true)
    const [searchQuery, setSearchQuery] = useState("")
    const [visibleRatings, setVisibleRatings] = useState(
      new Set(["highlight", "verified", "unverified", "not-recommended", "unrated"])
    )

    function toggleRating(key: string) {
      setVisibleRatings((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    }

    return (
      <FilterPanel
        maxMinutes={maxMinutes}
        onChange={setMaxMinutes}
        showTrails={showTrails}
        onToggleTrails={setShowTrails}
        visibleRatings={visibleRatings}
        onToggleRating={toggleRating}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        adminMode={false}
      />
    )
  },
}
