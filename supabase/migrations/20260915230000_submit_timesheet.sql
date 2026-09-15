-- Kalthum for Peace — Automated Timesheet System
-- Part 2: submit
-- DRY RUN — not yet applied.
--
-- Validates caller owns the timesheet, it's currently 'draft', and every
-- calendar day in the timesheet's month has an attendance_entries row
-- (working default per an unconfirmed architecture-review assumption —
-- flagged again in CLAUDE.md, not silently assumed). On success, calls
-- generate_approval_chain (Part 1) to do the actual chain build.
--
-- Granted to `authenticated` (unlike generate_approval_chain) since this
-- IS the client-facing entry point — but it does not trust the client for
-- anything: ownership, status, and completeness are all checked
-- server-side before any state changes.

create or replace function public.submit_timesheet(p_timesheet_id uuid)
returns smallint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_status timesheet_status;
  v_month smallint;
  v_year smallint;
  v_missing_days int;
  v_cycle smallint;
begin
  select staff_id, status, month, year
    into v_staff_id, v_status, v_month, v_year
  from timesheets
  where id = p_timesheet_id
  for update;

  if v_staff_id is null then
    raise exception 'submit_timesheet: timesheet % not found', p_timesheet_id;
  end if;

  if v_staff_id != auth.uid() then
    raise exception 'submit_timesheet: caller % is not the owner of timesheet % (owner: %)', auth.uid(), p_timesheet_id, v_staff_id;
  end if;

  if v_status != 'draft' then
    raise exception 'submit_timesheet: timesheet % is not in draft status (current status: %)', p_timesheet_id, v_status;
  end if;

  -- Every calendar day in the month must have an attendance_entries row.
  -- Working default per an unconfirmed architecture-review assumption —
  -- see CLAUDE.md.
  select count(*) into v_missing_days
  from generate_series(
    make_date(v_year, v_month, 1),
    (make_date(v_year, v_month, 1) + interval '1 month' - interval '1 day')::date,
    interval '1 day'
  ) as d(day)
  where not exists (
    select 1 from attendance_entries ae
    where ae.timesheet_id = p_timesheet_id and ae.date = d.day::date
  );

  if v_missing_days > 0 then
    raise exception 'submit_timesheet: timesheet % is missing % day(s) of attendance entries for % — all days must be filled before submission',
      p_timesheet_id, v_missing_days, to_char(make_date(v_year, v_month, 1), 'YYYY-MM');
  end if;

  v_cycle := public.generate_approval_chain(p_timesheet_id);

  return v_cycle;
end;
$$;

grant execute on function public.submit_timesheet(uuid) to authenticated;
