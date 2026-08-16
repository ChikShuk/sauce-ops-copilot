import type { Metadata } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

// Plus Jakarta Sans over Geist: a tall x-height and open, slightly rounded
// terminals read calmer at the small sizes this board lives at, and it has
// enough character not to look like a default. Weights are limited to the four
// the type scale actually uses, so nothing extra is downloaded.
const sans = Plus_Jakarta_Sans({
  variable: "--font-sans-family",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// Identifiers only — event ids, order ids, opaque restaurant ids. JetBrains
// Mono has unambiguous 0/O and 1/l, which is the whole job here.
const mono = JetBrains_Mono({
  variable: "--font-mono-family",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sauce Ops Copilot",
  description:
    "Live operational findings for restaurant operators: correlated events, deterministic priority, and AI-written summaries.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      {/*
        The dashboard is an app shell, not a document: the page itself never
        scrolls, its panes do. That requires a definite height the whole way
        down — `min-h-dvh` here would let the body grow past the viewport, and
        every `overflow-y-auto` further down would silently stop working
        because its ancestors have no height to overflow.

        dvh rather than vh so a mobile browser's collapsing URL bar doesn't
        crop the last card.
      */}
      <body className="h-dvh overflow-hidden">
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
