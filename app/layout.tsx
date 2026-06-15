import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Belter Watch",
  description: "Live volunteer brigade pager incident board",
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
