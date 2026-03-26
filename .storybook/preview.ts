import type { Preview } from "@storybook/nextjs-vite"

// Load Manrope font + set --font-sans (normally done by next/font in layout.tsx)
import "./fonts.css"
// This imports your Tailwind styles so components look the same as in the app
import "../app/globals.css"

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },

    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: "todo",
    },
  },
}

export default preview
