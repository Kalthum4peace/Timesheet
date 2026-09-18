-- Kalthum for Peace — Automated Timesheet System
-- Client feedback (demo, 2026-09-18), Part 2: merged Admin/HR role.
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
--
-- Adds the new enum value ONLY. Kept in its own migration/transaction
-- deliberately: Postgres does not allow a newly-added enum value to be
-- referenced (in a policy, function body executed at DDL time, etc.) within
-- the same transaction that added it ("unsafe use of new value of enum
-- type"). Every place that actually USES 'admin_hr' (RLS policies,
-- generate_approval_chain) is a separate, later migration file.

alter type role_type add value 'admin_hr';
