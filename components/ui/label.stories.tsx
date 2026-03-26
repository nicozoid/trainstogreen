import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Label } from "./label"
import { Input } from "./input"

const meta: Meta<typeof Label> = {
  title: "UI/Label",
  component: Label,
}

export default meta
type Story = StoryObj<typeof Label>

export const Default: Story = {
  args: {
    children: "Email address",
  },
}

// Shows the typical pattern: Label + Input paired together via htmlFor/id
export const WithInput: Story = {
  render: () => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="demo-email">Email address</Label>
      <Input id="demo-email" type="email" placeholder="you@example.com" />
    </div>
  ),
}
