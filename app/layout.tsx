import type { Metadata } from "next";
import { Work_Sans } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import "./globals.css";
import { createClient } from "@/lib/supabase/server";

const workSans = Work_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-work-sans",
});

export const metadata: Metadata = {
  title: "Kalthum Timesheet",
  description: "Monthly timesheet and approval platform for Kalthum for Peace.",
};

const APPROVER_ROLES = ["team_lead", "department_head", "spm", "hr"];

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let canApprove = false;
  let isHr = false;
  let isAdmin = false;
  if (user) {
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    canApprove = !!profile && APPROVER_ROLES.includes(profile.role);
    isHr = profile?.role === "hr";
    isAdmin = profile?.role === "admin";
  }

  return (
    <html lang="en">
      <body className={`${workSans.variable} font-sans antialiased`}>
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-4">
            <Image
              src="/kfp-logo.jpg"
              alt="Kalthum Foundation for Peace"
              width={36}
              height={36}
              className="rounded-lg"
            />
            <div className="flex flex-col">
              <span className="whitespace-nowrap text-lg font-semibold leading-none">
                <span className="sm:hidden">KFP Timesheet</span>
                <span className="hidden sm:inline">Kalthum For Peace Timesheet</span>
              </span>
              <svg
                className="mt-1 text-accent"
                width="110"
                height="16"
                viewBox="0 0 130 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M2 16C22 16 34 17 46 12C58 7 66 2 78 2C90 2 96 8 104 8"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            {user && (
              <nav className="ml-auto flex gap-5 text-sm font-medium text-text-secondary">
                {/* Admin has no timesheet chain of its own (see
                    generate_approval_chain — no rule for role='admin'),
                    per PROJECT_CONTEXT's admin/approval separation, so this
                    link would only lead to a dead end for them. */}
                {!isAdmin && (
                  <Link href="/timesheet" className="hover:text-text-primary">
                    My timesheet
                  </Link>
                )}
                {canApprove && (
                  <Link href="/approvals" className="hover:text-text-primary">
                    Approvals
                  </Link>
                )}
                {canApprove && (
                  <Link href="/returned-items" className="hover:text-text-primary">
                    Returned items
                  </Link>
                )}
                {isHr && (
                  <Link href="/all-timesheets" className="hover:text-text-primary">
                    All timesheets
                  </Link>
                )}
                {isAdmin && (
                  <Link href="/admin" className="hover:text-text-primary">
                    Admin
                  </Link>
                )}
              </nav>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-3xl px-5 py-8">{children}</main>
      </body>
    </html>
  );
}
