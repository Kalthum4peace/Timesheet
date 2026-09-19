"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  // Outlined, icon-led button rather than a bare text link: it sits in the
  // page content next to a header full of nav links, and the two must never
  // read as the same kind of control. Border uses text-secondary (not the
  // faint border tokens) so the button's shape is actually visible against
  // the page — same lesson as the status pill.
  return (
    <button
      type="button"
      onClick={handleSignOut}
      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-text-secondary bg-surface px-3 py-1.5 text-sm font-medium text-text-primary outline-none transition-colors hover:border-accent hover:text-accent-on-tint focus-visible:ring-2 focus-visible:ring-accent/40"
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
