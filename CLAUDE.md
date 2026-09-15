# Kalthum for Peace — Automated Timesheet System

## What this is

An internal monthly timesheet and multi-step approval platform for Kalthum for Peace, replacing a manual paper/Excel process. Staff log daily attendance (Present/Absent/Public Holiday/Leave) for a month; timesheets route through a role- and department-dependent approval chain (Team Lead → Department Head → SPM/HR, with several self-approval and parallel-approval special cases) before becoming a permanent, immutable record.

Full product requirements: [context/PROJECT_CONTEXT.md](context/PROJECT_CONTEXT.md) — source of truth, do not invent requirements beyond it.

## Tech stack

- **Frontend/backend:** Next.js (App Router) + TypeScript
- **Styling:** Tailwind CSS
- **Database/Auth:** Supabase (PostgreSQL + Supabase Auth + Row Level Security)
- **Deployment:** Vercel (frontend), Supabase (backend), target domain `timesheet.kalthum4peace.org`
- **Migrations:** Supabase CLI, version-controlled SQL files under `supabase/migrations/`

## Status

Early build. No real users yet. Schema, RLS policies, and national holiday seed data are all applied to a personal dev Supabase project:
- Schema: [20260915000000_initial_schema.sql](supabase/migrations/20260915000000_initial_schema.sql) — 8 tables.
- RLS: [20260915140000_rls_policies.sql](supabase/migrations/20260915140000_rls_policies.sql) + [20260915150000_fix_approval_steps_recursion.sql](supabase/migrations/20260915150000_fix_approval_steps_recursion.sql) (fixes an infinite-recursion bug the first version had). Behaviorally verified with [scripts/test-rls.mjs](scripts/test-rls.mjs) — 16/16 required tests pass (SPM classification rule, self-approval rejection, step-ordering enforcement, timesheet_actions/notifications insert-blocking, admin's enumerated write boundary). Re-run this script after any future RLS change.
- Seed data: [20260915140100_seed_national_holidays.sql](supabase/migrations/20260915140100_seed_national_holidays.sql) — 16 rows (8 fixed/Easter-derived holidays × 2026-2027). Nigeria's moveable Islamic-calendar holidays (Eid al-Fitr, Eid al-Kabir, Eid al-Mawlid) are deliberately NOT seeded — need manual entry each year once officially announced, do not invent dates.

organizational_assignments append-only discipline is now DB-enforced: [20260915160000_org_assignments_append_only.sql](supabase/migrations/20260915160000_org_assignments_append_only.sql) (`before update` trigger rejecting edits to any row whose `effective_to` is already set). Behaviorally verified with [scripts/test-org-assignments-trigger.mjs](scripts/test-org-assignments-trigger.mjs).

Phase 4 workflow engine in progress:
- **Chain-generation** (`generate_approval_chain`, [supabase/migrations/20260915220000_scope_org_assignment_check_to_staff.sql](supabase/migrations/20260915220000_scope_org_assignment_check_to_staff.sql) has the current version — see git history for the 5 migrations before it, each fixing a real bug testing caught): builds a new cycle's approval_steps chain per role/department, applies self-approval substitution, sets timesheet status, notifies first-layer approvers. Not exposed to `authenticated` — only callable by submit/resubmit or the service role. 25/25 behavioral tests pass ([scripts/test-chain-generation.mjs](scripts/test-chain-generation.mjs)).
- Submit, approve, decline, return-acknowledge, resubmit: not yet built.

UI not started.

## Standing rules

- Read the actual current repo/schema state before proposing or building anything — never assume prior state, even from an earlier session's summary.
- Any schema change, migration, or RLS policy change is dry-run and shown in full before being applied for real. No exceptions, even for something that "looks obviously safe."
- Every write to a live Supabase project (schema or data) is confirmed explicitly before running — never inferred as "probably fine." The dev Supabase project counts as live once it holds anything worth not losing.
- Deploy schema and dependent code together, or explicitly sequence which lands first.
- Large/risky changes go on a separate branch, verified before merge to main — never merged speculatively "to save time."
- Verify behaviorally, not just by reading code — e.g. RLS policies get tested by actually attempting the access they're supposed to block, not just confirmed to exist by reading the policy.
- A surprising or too-clean result gets a second look before being trusted, especially if it contradicts something already confirmed.
- A permanent identifier, once assigned to a record, is never recalculated from other fields.
- If something surfaces that's genuinely an OPEN DECISION or a contradiction with PROJECT_CONTEXT.md, stop and report it rather than silently picking an assumption and continuing. Clean, unambiguous implementation work proceeds without round-tripping for approval on every step.
- No production changes of any kind unless explicitly requested.
- `.env` for all secrets, no hardcoded values anywhere in source, ever, including "temporarily."

### Portability (this project specifically)

Built in a personal dev environment now; production will belong to Kalthum for Peace on their own Vercel/Supabase accounts. For every implementation decision, ask: would moving this to Kalthum's own production environment later require a code change, or only a configuration change? If the former, reconsider the approach.

- Never hardcode environment-specific values or secrets anywhere in code, config, or migration files.
- Keep dev and production configuration fully separate (`.env` per environment; nothing assumes a specific account/project by default).
- All schema changes are version-controlled migration files, applied in sequence — never a manual dashboard edit, even in dev.
- Nothing in the codebase, CI, or deployment scripts creates a hard dependency on the developer's personal GitHub, Vercel, or Supabase accounts specifically. The app must work identically if pointed at a different Supabase project via `.env`.
