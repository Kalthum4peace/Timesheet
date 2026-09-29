-- Kalthum for Peace — Automated Timesheet System
-- Client feedback (2026-09-28): the timesheet is only fillable from the start
-- of the current month through today — a day that has not happened yet cannot
-- be marked. This migration enforces that in the database, not just the UI:
-- attendance_entries can no longer hold a FUTURE date.
--
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
-- SHIPS TOGETHER WITH the UI change (AttendanceGrid / TimesheetForm): the save
-- flow upserts the whole entries map in one statement, so a single future-dated
-- row in that batch fails the entire save. The UI must stop sending them first.
--
-- DELIBERATELY NOT CHANGED: missing_attendance_days() and therefore
-- submit_timesheet / resubmit_timesheet. "Every day of the month must be filled
-- before submitting" stays exactly as it is. With future dates now impossible
-- to record, that means the current month cannot be submitted until its last
-- day — which is the intended behaviour: there is one timesheet per staff per
-- month and a submitted timesheet is locked, so submitting mid-month would
-- leave no way to record the rest of the month. (An earlier draft of this
-- migration shortened the required range to "1st .. today"; dropped for that
-- reason.)
--
-- "TODAY". The rule reads public.app_today(), one place that says what today's
-- date is. It returns current_date, i.e. the database's own time zone — UTC on
-- Supabase, the same clock the existing future-month insert lock
-- (20260918000000, timesheets_insert_staff) already uses, so the two agree. The
-- catch: staff in Nigeria (UTC+1) cannot enter "today" during the first hour of
-- their local day, when UTC is still yesterday. If that matters, change ONLY
-- this function (e.g. (now() at time zone 'Africa/Lagos')::date) and update
-- timesheets_insert_staff to call it too so the month-start rule moves with it.
-- The app reads the same function (rpc 'app_today') to decide which days to
-- offer, so the UI follows the database rather than the browser's clock.

-- ============================================================
-- app_today
-- ============================================================

create or replace function public.app_today()
returns date
language sql
stable
as $$
  select current_date;
$$;

-- Evaluated inside RLS policies as the calling role, and called by the app as
-- an rpc, so it must stay executable by authenticated. It returns a date and
-- reads nothing.
grant execute on function public.app_today() to authenticated, anon, service_role;

-- ============================================================
-- attendance_entries: no future-dated rows
-- ============================================================
-- Same two policies as 20260915140000, restated verbatim with one extra
-- condition on the NEW row: date <= app_today(). RLS applies to the row being
-- written, so this also rejects an UPDATE that moves a row to a future date,
-- and an upsert (INSERT .. ON CONFLICT DO UPDATE) carrying any future row
-- fails as a whole statement — nothing partial is written.
-- The UPDATE policy's USING clause is deliberately left WITHOUT the date test:
-- it only decides which existing rows the caller may touch. Rows already saved
-- with a future date (e.g. a sheet pre-filled before this rule) are not
-- re-validated by any policy, so nothing already stored conflicts with this
-- migration; those rows simply cannot be re-written.

drop policy if exists attendance_entries_insert_staff on attendance_entries;
drop policy if exists attendance_entries_update_staff on attendance_entries;

create policy attendance_entries_insert_staff on attendance_entries
for insert to authenticated
with check (
  attendance_entries.date <= public.app_today()
  and exists (
    select 1 from timesheets t
    where t.id = attendance_entries.timesheet_id
      and t.staff_id = auth.uid()
      and t.status in ('draft', 'returning')
  )
);

create policy attendance_entries_update_staff on attendance_entries
for update to authenticated
using (
  exists (
    select 1 from timesheets t
    where t.id = attendance_entries.timesheet_id
      and t.staff_id = auth.uid()
      and t.status in ('draft', 'returning')
  )
)
with check (
  attendance_entries.date <= public.app_today()
  and exists (
    select 1 from timesheets t
    where t.id = attendance_entries.timesheet_id
      and t.staff_id = auth.uid()
      and t.status in ('draft', 'returning')
  )
);
