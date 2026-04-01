import { Geist_Mono } from "next/font/google"
import localFont from "next/font/local"

import type { Metadata } from "next"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils";
import { welcomeCopy } from "@/lib/copy";

export const metadata: Metadata = {
  title: "Trains to Green | Nic Zap",
  // Reuses the welcome banner body as the page-level description
  description: welcomeCopy.body,
  icons: {
    icon: "/trainstogreen-favicon.svg",
  },
  // OpenGraph tags control how link previews look on social media / messaging apps
  openGraph: {
    siteName: "Trains to Green",
    title: welcomeCopy.heading,
    description: welcomeCopy.body,
  },
}

// localFont loads a self-hosted font file instead of pulling from Google Fonts
const generalSans = localFont({
  src: "../public/fonts/GeneralSans-Variable.woff2",
  variable: "--font-sans", // sets the same CSS variable Manrope was using
  weight: "200 700",       // the range supported by this variable font
})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", generalSans.variable)}
    >
      <body suppressHydrationWarning>
        <ThemeProvider><TooltipProvider>{children}</TooltipProvider></ThemeProvider>
      </body>
    </html>
  )
}
