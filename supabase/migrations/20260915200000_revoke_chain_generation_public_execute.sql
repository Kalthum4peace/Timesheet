-- Kalthum for Peace — Automated Timesheet System
-- Fix: generate_approval_chain was callable directly by any authenticated
-- client, bypassing submit/resubmit's ownership and status validation
-- entirely. Found by behavioral testing.
-- DRY RUN — not yet applied.
--
-- Root cause: Postgres grants EXECUTE on every new function to PUBLIC by
-- default. The original migration only omitted an explicit grant to
-- `authenticated` — it never revoked the default PUBLIC grant, so
-- `authenticated` (and `anon`) could still call it via the default. This
-- is the general lesson for every future internal-only function in this
-- project: omitting a grant is not the same as revoking the default one.

revoke execute on function public.generate_approval_chain(uuid) from public;
revoke execute on function public.generate_approval_chain(uuid) from authenticated;
revoke execute on function public.generate_approval_chain(uuid) from anon;
