"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Rendered exactly ONCE, in the shared header (app/layout.tsx) — never per
// page. Outlined white on the brand-blue bar: label is full white (4.99:1),
// outline is white at 85% (4.04:1 — a control boundary needs 3:1). Deliberately
// an outline, not a filled pill, so it can't be mistaken for the white
// active-nav pill it sits above.
export function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-on-header/85 px-3 py-1.5 text-sm font-medium text-on-header outline-none transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/70"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
      Sign out
    </button>
  );
}
