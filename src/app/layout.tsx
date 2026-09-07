import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Kokono · Merchandise", template: "%s · Kokono" },
  description: "Internal merchandise catalog and inventory management.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
