import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Slider } from "./slider"

const meta: Meta<typeof Slider> = {
  title: "UI/Slider",
  component: Slider,
  // Render inside a container so the slider has a visible width
  decorators: [
    (Story) => (
      <div className="w-64 p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof Slider>

// Single thumb slider
export const Default: Story = {
  args: {
    min: 0,
    max: 100,
    defaultValue: [50],
  },
}

// Range slider — two thumbs defining a min/max range
export const Range: Story = {
  args: {
    min: 0,
    max: 100,
    defaultValue: [25, 75],
  },
}

// Stepped slider — snaps to 15-minute increments, like the travel time filter
export const Stepped: Story = {
  args: {
    min: 45,
    max: 180,
    step: 15,
    defaultValue: [90],
  },
}

export const Disabled: Story = {
  args: {
    min: 0,
    max: 100,
    defaultValue: [50],
    disabled: true,
  },
}
