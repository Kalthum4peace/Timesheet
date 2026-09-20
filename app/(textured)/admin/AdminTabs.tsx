"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Staff" },
  { href: "/admin/holidays", label: "Public holidays" },
];

// "Staff" must match /admin exactly, or it would also light up on
// /admin/holidays (startsWith would match both tabs there).
export function AdminTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin sections" className="flex gap-1 border-b border-border">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "-mb-px border-b-2 border-accent px-3 py-2 text-sm font-semibold text-accent-on-tint"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
