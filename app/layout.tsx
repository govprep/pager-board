import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BelterHub",
  description: "Live volunteer brigade pager incident board",
  manifest: "/manifest.webmanifest",
  // iOS reads this (not the manifest) to run the home-screen app full-screen
  // and to know it's installable — a prerequisite for web push on iPhone.
  appleWebApp: {
    capable: true,
    title: "BelterHub",
    statusBarStyle: "black-translucent",
  },
  icons: {
    apple: "/logo.jpg",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0e14",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
