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
  width: "device-width",
  initialScale: 1,
  // The installed app runs under a translucent status bar (appleWebApp above),
  // which hands us the whole screen — including the parts behind the notch and
  // the home indicator. `cover` is what makes the safe-area insets meaningful;
  // globals.css pads the topbar and the foot of the list by them.
  viewportFit: "cover",
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
