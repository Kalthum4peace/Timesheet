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

Early build. No real users yet. Architecture review (requirements lock, schema, RLS design) is complete. Currently implementing: initial schema migration (dry run, not yet applied to any database).

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
