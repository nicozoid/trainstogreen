import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Button } from "./button"

// `meta` configures how this component appears in Storybook's sidebar
// and what controls are available in the panel
const meta: Meta<typeof Button> = {
  title: "UI/Button", // Sidebar path: "UI" folder > "Button"
  component: Button,
  // `argTypes` let you control props interactively in Storybook's panel
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "outline", "secondary", "ghost", "destructive", "link"],
    },
    size: {
      control: "select",
      options: ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"],
    },
  },
}

export default meta

// Each named export = one story (a specific state of the component)
// `StoryObj` gives you type-safety for args based on the component's props
type Story = StoryObj<typeof Button>

// The simplest story — just the default button with a label
export const Default: Story = {
  args: {
    children: "Button",
  },
}

// One story per variant so you can see them all at a glance
export const Outline: Story = {
  args: {
    children: "Outline",
    variant: "outline",
  },
}

export const Secondary: Story = {
  args: {
    children: "Secondary",
    variant: "secondary",
  },
}

export const Ghost: Story = {
  args: {
    children: "Ghost",
    variant: "ghost",
  },
}

export const Destructive: Story = {
  args: {
    children: "Destructive",
    variant: "destructive",
  },
}

export const Link: Story = {
  args: {
    children: "Link",
    variant: "link",
  },
}

// Size variants
export const Small: Story = {
  args: {
    children: "Small",
    size: "sm",
  },
}

export const Large: Story = {
  args: {
    children: "Large",
    size: "lg",
  },
}

export const Disabled: Story = {
  args: {
    children: "Disabled",
    disabled: true,
  },
}
