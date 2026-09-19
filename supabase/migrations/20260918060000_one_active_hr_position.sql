-- Kalthum for Peace — Automated Timesheet System
-- Client feedback round 2 follow-up (2026-09-18): database-level guarantee of
-- "at most one active HR-position profile".
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
--
-- Why: generate_approval_chain requires exactly ONE active profile with role
-- in ('hr','admin_hr') and hard-fails every submission at two. createStaffMember
-- already rejects a second one at the application layer, but a check-then-
-- insert can't be made race-proof from application code: two simultaneous
-- submits can both pass the check before either inserts. This makes the
-- database itself refuse the second one.
--
-- Why a constant-expression index and NOT `on profiles (role)`: a unique
-- index on the role COLUMN treats 'hr' and 'admin_hr' as different keys, so
-- it would still permit one active hr AND one active admin_hr at once — the
-- exact "found 2" state this exists to prevent. Indexing a constant makes
-- every row inside the WHERE filter collide with every other regardless of
-- which of the two roles it has. Inactive profiles are outside the filter,
-- so deactivating the old HR and then creating/activating a new one works,
-- and hr -> admin_hr role changes on the same row are unaffected.
--
-- Precondition: the table must currently satisfy this, or the index build
-- fails. The DO block turns that into a readable error instead of a bare
-- "could not create unique index" and changes nothing.

do $$
declare
  v_active_hr_positions int;
begin
  select count(*) into v_active_hr_positions
  from profiles
  where role in ('hr', 'admin_hr') and active = true;

  if v_active_hr_positions > 1 then
    raise exception
      'one_active_hr_position: % active hr/admin_hr profiles exist; deactivate all but one before applying this migration',
      v_active_hr_positions;
  end if;
end;
$$;

create unique index profiles_one_active_hr_position
  on profiles ((true))
  where role in ('hr', 'admin_hr') and active = true;
