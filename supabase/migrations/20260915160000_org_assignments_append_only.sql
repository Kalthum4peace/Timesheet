-- Kalthum for Peace — Automated Timesheet System
-- Close known gap: enforce organizational_assignments append-only discipline
-- DRY RUN — not yet applied.
--
-- Rejects any UPDATE to a row whose effective_to was ALREADY non-null before
-- the update (a closed/historical row must never be touched again). Permits
-- the normal close-out transition (effective_to: null -> a real date) and
-- any other edit to a still-open row, since only that one restriction was
-- asked for. Does not affect INSERT at all — this is a BEFORE UPDATE
-- trigger, INSERT never fires it.

create or replace function public.protect_closed_organizational_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.effective_to is not null then
    raise exception 'organizational_assignments: row % is closed (effective_to = %) and cannot be modified — insert a new row instead', old.id, old.effective_to;
  end if;
  return new;
end;
$$;

create trigger trg_protect_closed_organizational_assignment
before update on organizational_assignments
for each row
execute function public.protect_closed_organizational_assignment();
