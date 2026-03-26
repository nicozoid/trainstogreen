import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Input } from "./input"

const meta: Meta<typeof Input> = {
  title: "UI/Input",
  component: Input,
}

export default meta
type Story = StoryObj<typeof Input>

export const Default: Story = {
  args: {
    placeholder: "Type something…",
  },
}

export const WithValue: Story = {
  args: {
    value: "Guildford",
  },
}

// type="search" adds the browser's native × clear button
export const Search: Story = {
  args: {
    type: "search",
    placeholder: "Search stations…",
  },
}

export const Password: Story = {
  args: {
    type: "password",
    placeholder: "Enter password",
  },
}

export const Disabled: Story = {
  args: {
    placeholder: "Disabled input",
    disabled: true,
  },
}
