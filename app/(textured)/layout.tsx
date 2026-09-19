import { TexturedPage } from "@/components/TexturedPage";

// Route group: wraps Approvals, Returned Items, Staff Roster, All
// Timesheets and Admin in the shared textured field. "My timesheet" and
// login live outside this group on purpose (My timesheet is deliberately
// plain; login uses the same TexturedPage directly with its centered
// variant). Route groups don't appear in URLs, so no link changes.
export default function TexturedLayout({ children }: { children: React.ReactNode }) {
  return <TexturedPage>{children}</TexturedPage>;
}
