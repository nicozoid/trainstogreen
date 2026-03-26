import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import StationModal from "./photo-overlay"

const meta: Meta<typeof StationModal> = {
  title: "Components/StationModal",
  component: StationModal,
}

export default meta
type Story = StoryObj<typeof StationModal>

// Shared props used across stories — a realistic station example
const baseArgs = {
  open: true,
  onClose: () => {},
  lat: 51.237,
  lng: -0.571,
  stationName: "Guildford",
  minutes: 52,
  flickrCount: null,
}

// Default state — without a Flickr API key, the modal shows a
// "not configured" placeholder. This is what you'll see in Storybook
// since NEXT_PUBLIC_FLICKR_API_KEY isn't set here.
export const Default: Story = {
  args: baseArgs,
}

// With dev tools enabled — shows the rating toolbar with interactive icons.
// Uses `render` so we can wire up state for the rating buttons.
export const WithDevTools: Story = {
  render: () => {
    /* eslint-disable react-hooks/rules-of-hooks -- Storybook render functions are components */
    const [rating, setRating] = useState<
      "highlight" | "verified" | "unverified" | "not-recommended" | null
    >(null)

    return (
      <StationModal
        {...baseArgs}
        devMode
        currentRating={rating}
        onRate={setRating}
        onExclude={() => alert("Station excluded")}
      />
    )
  },
}

// Note: The loading skeleton and photo grid states are driven by internal
// useEffect hooks that fire on mount. They can't be shown as static stories
// without refactoring StationModal to accept photos/loading as props.
// If you want to preview those states in Storybook later, we could extract
// the photo grid into its own presentational component.
