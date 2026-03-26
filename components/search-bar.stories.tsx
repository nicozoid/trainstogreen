import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import SearchBar from "./search-bar"

const meta: Meta<typeof SearchBar> = {
  title: "Components/SearchBar",
  component: SearchBar,
}

export default meta
type Story = StoryObj<typeof SearchBar>

// Default empty state
export const Empty: Story = {
  args: {
    value: "",
    onChange: () => {}, // No-op — Storybook's "Actions" panel will log calls
  },
}

// Pre-filled state — useful for seeing how the component looks with content
export const WithValue: Story = {
  args: {
    value: "Guildford",
    onChange: () => {},
  },
}
