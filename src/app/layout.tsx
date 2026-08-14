import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
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
      <body className="h-dvh overflow-hidden">{children}</body>
    </html>
  );
}
