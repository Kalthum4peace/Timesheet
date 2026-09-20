-- Kalthum for Peace — Automated Timesheet System
-- Public-holiday admin UI: let admin/admin_hr delete an ORG-scope holiday.
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
--
-- Until now public_holidays had a select policy (everyone) and an insert
-- policy (admin/admin_hr, scope = 'org' only) and NO delete policy, so a
-- mistakenly added holiday could not be removed at all.
--
-- The new policy mirrors the insert policy exactly: admin/admin_hr, and only
-- rows whose scope is 'org'. National-scope rows stay seed-data-only — they
-- can be neither inserted nor deleted by any client, admin included. That is
-- enforced HERE, in the database, not merely by the UI hiding a button.
--
-- Stays inside the enumerated admin write boundary documented in
-- test-rls.mjs (profiles + organizational_assignments + public_holidays).

create policy public_holidays_delete_org on public_holidays
for delete to authenticated
using (
  scope = 'org'
  and public.current_profile_role() in ('admin', 'admin_hr')
);
