"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// icon: "lock" renders a padlock, with the label visible only from sm up (it
// stays available to screen readers and as a tooltip at every width).
type NavItem = { href: string; label: string; icon?: "lock" };

// Split out of layout.tsx (a Server Component) because "obviously you are
// here" needs the current route, and Next's Server Components don't have
// that without threading a pathname header through middleware — usePathname
// is the direct, scoped way to get it. Active match is startsWith rather
// than exact equality so a detail route (e.g. /approvals/[id]) still lights
// up its parent /approvals link.
function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function HeaderNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    // -mx-3 cancels the pills' own px-3 so the link TEXT lines up with the
    // logo's left edge instead of sitting indented; the active pill's white
    // highlight bleeds into the header's side gutter (20px) by 12px. The
    // extra 1.5rem of width is also what lets three links fit per row at 375px.
    <nav className="-mx-3 flex w-[calc(100%+1.5rem)] flex-wrap items-center gap-1 text-sm font-medium">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.icon ? item.label : undefined}
            title={item.icon ? item.label : undefined}
            className={
              active
                ? "rounded-full bg-header-chip-bg px-3 py-1.5 font-semibold text-on-header-chip"
                : "rounded-full px-3 py-1.5 text-on-header transition-colors hover:bg-white/10"
            }
          >
            {item.icon === "lock" ? (
              <span className="flex items-center gap-1.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span className="hidden sm:inline">{item.label}</span>
              </span>
            ) : (
              item.label
            )}
          </Link>
        );
      })}
    </nav>
  );
}
