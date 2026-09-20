import type { Metadata } from "next";
import { Work_Sans } from "next/font/google";
import Image from "next/image";
import "./globals.css";
import { createClient } from "@/lib/supabase/server";
import { HeaderNav } from "@/components/HeaderNav";
import { SignOutButton } from "@/components/SignOutButton";

const workSans = Work_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-work-sans",
});

export const metadata: Metadata = {
  title: "Kalthum Timesheet",
  description: "Monthly timesheet and approval platform for Kalthum for Peace.",
};

const APPROVER_ROLES = ["team_lead", "department_head", "spm", "hr", "admin_hr"];

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
  let canAccessAdmin = false;
  let hasNoTimesheetOfOwn = false;
  let mustChangePassword = false;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role, must_change_password")
      .eq("id", user.id)
      .single();
    mustChangePassword = !!profile?.must_change_password;
    canApprove = !!profile && APPROVER_ROLES.includes(profile.role);
    // admin_hr carries both boundaries at once: it sees the HR surfaces
    // (All timesheets) AND the Admin surface, but — unlike plain admin — it
    // DOES have its own timesheet chain (see generate_approval_chain's
    // "own timesheet" branch), so it's deliberately NOT lumped into
    // hasNoTimesheetOfOwn below.
    isHr = profile?.role === "hr" || profile?.role === "admin_hr";
    canAccessAdmin = profile?.role === "admin" || profile?.role === "admin_hr";
    hasNoTimesheetOfOwn = profile?.role === "admin";
  }

  // Admin (but not admin_hr — see generate_approval_chain's "own timesheet"
  // branch, which DOES cover admin_hr) has no timesheet chain of its own,
  // per PROJECT_CONTEXT's admin/approval separation, so "My timesheet"
  // would only lead to a dead end for a plain admin.
  // While the mandatory first-login password change is pending, the only
  // place they can go is /change-password (middleware enforces that), so the
  // nav is withheld entirely rather than offering links that just bounce.
  // Everyone else gets "Change password" as the last nav item, rendered as an
  // icon-only pill on phones (labelled from sm up). As a full text link it
  // wrapped onto a lonely third row for an HR/Admin login (142px -> 178px
  // header at 375px); as a top-bar button beside Sign out it pushed Sign out
  // onto its own row (188px). The icon pill fits in the spare room on row 2.
  const navItems = user && !mustChangePassword
    ? [
        ...(!hasNoTimesheetOfOwn ? [{ href: "/timesheet", label: "My timesheet" }] : []),
        ...(canApprove ? [{ href: "/approvals", label: "Approvals" }] : []),
        ...(canApprove ? [{ href: "/returned-items", label: "Returned items" }] : []),
        ...(canApprove ? [{ href: "/roster", label: "Staff roster" }] : []),
        ...(isHr ? [{ href: "/all-timesheets", label: "All timesheets" }] : []),
        ...(canAccessAdmin ? [{ href: "/admin", label: "Admin" }] : []),
        { href: "/change-password", label: "Change password", icon: "lock" as const },
      ]
    : [];

  return (
    <html lang="en">
      <body className={`${workSans.variable} font-sans antialiased`}>
        <header className="bg-header-bg">
          {/* Two tiers at every width: row 1 = brand (left) + Sign out
              (right); row 2 = the nav links, full width. Sign out lives here
              once, globally, so it reads as "always here, top of screen" on
              desktop and mobile alike instead of being repeated in every
              page's content header. */}
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-3 px-5 py-3">
            <Image
              src="/kfp-logo-mark.jpg"
              alt="Kalthum Foundation for Peace"
              width={36}
              height={36}
              className="rounded-lg"
            />
            <div className="flex flex-col">
              <span className="whitespace-nowrap text-lg font-semibold leading-none text-on-header">
                <span className="sm:hidden">KFP Timesheet</span>
                <span className="hidden sm:inline">Kalthum For Peace Timesheet</span>
              </span>
              <svg
                className="mt-1 text-on-header/50"
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
              <div className="ml-auto">
                <SignOutButton />
              </div>
            )}
            {user && navItems.length > 0 && <HeaderNav items={navItems} />}
          </div>
        </header>
        <main className="mx-auto max-w-3xl px-5 py-8">{children}</main>
      </body>
    </html>
  );
}
