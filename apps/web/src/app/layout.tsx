import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tradebot",
  description: "Paper copy-trading dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <span className="brand">TRADEBOT</span>
          <Link href="/portfolio">Portfolio</Link>
          <Link href="/leaders">Leaders</Link>
          <Link href="/feed">Live Feed</Link>
          <Link href="/candidates">Review</Link>
          <Link href="/status">Status</Link>
          <Link href="/settings">Settings</Link>
        </nav>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
