import "./globals.css";
import type { Metadata } from "next";
import { currentUser } from "@/lib/session";
import { OcrAlarm } from "@/components/OcrAlarm";
import { AuthAlarm } from "@/components/AuthAlarm";

export const metadata: Metadata = {
  title: "Job applications",
  description: "Review and manage automated job applications",
  robots: { index: false, follow: false },
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/incoming", label: "Jobs found" },
  { href: "/add", label: "Add jobs" },
  { href: "/queue", label: "Queue" },
  { href: "/status", label: "Status" },
  { href: "/applications", label: "Applications" },
  { href: "/blocked", label: "Blocked" },
  { href: "/answers", label: "Answers" },
  { href: "/preference", label: "Preferences" },
  { href: "/history", label: "History" },
  { href: "/runs", label: "Runs" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body>
        {user ? (
          <header className="top">
            <div className="inner">
              <span className="brand">jobapp</span>
              <nav>
                {NAV.map((n) => (
                  <a key={n.href} href={n.href}>{n.label}</a>
                ))}
              </nav>
              <span className="who">
                {user.username}
                <span className="pill">{user.role}</span>
                <form action="/logout" method="post">
                  <button type="submit" style={{ padding: "4px 10px", fontSize: 13 }}>Sign out</button>
                </form>
              </span>
            </div>
          </header>
        ) : null}
        {user ? <OcrAlarm /> : null}
        {user ? <AuthAlarm /> : null}
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
