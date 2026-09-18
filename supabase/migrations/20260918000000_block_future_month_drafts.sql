-- Kalthum for Peace — Automated Timesheet System
-- Client feedback (demo, 2026-09-18), Part 1 item 1: staff must not be able
-- to create/fill a future month's timesheet.
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
--
-- The UI (TimesheetForm.tsx) already stops navigation past the current
-- month, but per this project's own standing rule (never trust the frontend
-- alone for a real constraint), the actual enforcement belongs in the
-- INSERT policy that creates the row in the first place. No matching change
-- is needed on timesheets_update_staff or submit_timesheet/resubmit_timesheet:
-- month/year are set once at row creation and never updated afterward, so
-- blocking the INSERT is the one real enforcement point.

drop policy if exists timesheets_insert_staff on timesheets;

create policy timesheets_insert_staff on timesheets
for insert to authenticated
with check (
  staff_id = auth.uid()
  and status = 'draft'
  and make_date(year::int, month::int, 1) <= date_trunc('month', current_date)::date
);
