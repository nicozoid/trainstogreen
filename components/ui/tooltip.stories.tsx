import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip"
import { Button } from "./button"

// Tooltip needs TooltipProvider as an ancestor — the decorator wraps every story
const meta: Meta = {
  title: "UI/Tooltip",
  decorators: [
    (Story) => (
      <TooltipProvider>
        {/* Centre the trigger so the tooltip has room to appear on any side */}
        <div className="flex min-h-32 items-center justify-center">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
}

export default meta
type Story = StoryObj

// Hover (or focus) the button to see the tooltip
export const Default: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Hover me</Button>
      </TooltipTrigger>
      <TooltipContent>This is a tooltip</TooltipContent>
    </Tooltip>
  ),
}

// `side` controls where the tooltip appears relative to the trigger
export const Top: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Top</Button>
      </TooltipTrigger>
      <TooltipContent side="top">Appears above</TooltipContent>
    </Tooltip>
  ),
}

export const Bottom: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Bottom</Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Appears below</TooltipContent>
    </Tooltip>
  ),
}
