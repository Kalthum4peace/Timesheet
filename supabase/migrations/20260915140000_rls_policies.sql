-- Kalthum for Peace — Automated Timesheet System
-- Row Level Security policies (Phase 3 architecture review output)
-- DRY RUN — not yet applied. See CLAUDE.md standing rules: this is a real
-- write to a live dev database once run and requires explicit confirmation.

-- ============================================================
-- HELPER FUNCTIONS
--
-- security definer + stable: these read profiles/organizational_assignments/
-- approval_steps on behalf of the caller, bypassing THOSE tables' own RLS,
-- so they can be safely reused inside other tables' policies without
-- recursion or visibility gaps. Each is a narrow, read-only, deterministic
-- lookup — no side effects, nothing attacker-controlled beyond auth.uid()
-- and explicit uuid arguments.
--
-- Named current_profile_role() (not current_role()) to avoid colliding with
-- Postgres's built-in CURRENT_ROLE, which returns the session's SQL role
-- (authenticated/anon), not this app's profiles.role.
-- ============================================================

create or replace function public.current_profile_role()
returns role_type
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function public.profile_role(target_id uuid)
returns role_type
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = target_id;
$$;

create or replace function public.current_profile_department()
returns department_type
language sql
stable
security definer
set search_path = public
as $$
  select department from organizational_assignments
  where staff_id = auth.uid() and effective_to is null
  limit 1;
$$;

-- Team Lead: staff currently or historically assigned to them (no date
-- filter — existence across all history covers both).
create or replace function public.is_team_lead_of(target_staff uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from organizational_assignments
    where staff_id = target_staff and team_lead_id = auth.uid()
  );
$$;

-- Department Head: staff with a current-or-historical assignment row either
-- naming this person as department_head_id, or in this person's own current
-- department. The second clause is what lets a department head see their
-- OWN organizational_assignments row (which has department_head_id = null
-- per the schema) and is also the literal "or department matches theirs"
-- clause from the confirmed RLS design.
create or replace function public.is_department_head_of(target_staff uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from organizational_assignments
    where staff_id = target_staff
      and (
        department_head_id = auth.uid()
        or department = public.current_profile_department()
      )
  );
$$;

-- "Historical actor" check: was this person ever a named approver (any
-- cycle, any status) on this timesheet. Deliberately role-agnostic and
-- independent of organizational_assignments, per the confirmed design:
-- "historical-actor OR current-supervisor, as two separately OR'ed
-- conditions" — this is the historical-actor half.
create or replace function public.is_actor_on_timesheet(target_timesheet uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from approval_steps
    where timesheet_id = target_timesheet and approver_id = auth.uid()
  );
$$;

grant execute on function public.current_profile_role() to authenticated;
grant execute on function public.profile_role(uuid) to authenticated;
grant execute on function public.current_profile_department() to authenticated;
grant execute on function public.is_team_lead_of(uuid) to authenticated;
grant execute on function public.is_department_head_of(uuid) to authenticated;
grant execute on function public.is_actor_on_timesheet(uuid) to authenticated;

-- ============================================================
-- profiles
-- ============================================================

alter table profiles enable row level security;

create policy profiles_select on profiles
for select to authenticated
using (
  id = auth.uid()
  or public.is_team_lead_of(id)
  or public.is_department_head_of(id)
  or public.current_profile_role() in ('spm', 'hr', 'admin')
);

create policy profiles_insert_admin on profiles
for insert to authenticated
with check (public.current_profile_role() = 'admin');

create policy profiles_update_admin on profiles
for update to authenticated
using (public.current_profile_role() = 'admin')
with check (public.current_profile_role() = 'admin');

-- Self-promotion guard: RLS USING/WITH CHECK can't compare OLD vs NEW
-- column values in one expression, so this is enforced with a trigger
-- instead — the standard, unambiguous way to block "admin edits their own
-- role/active status" specifically (while still allowing admin to edit
-- everyone else's, and their own other fields).
create or replace function public.prevent_admin_self_privilege_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id = auth.uid()
     and (new.role is distinct from old.role or new.active is distinct from old.active) then
    raise exception 'Admins cannot change their own role or active status';
  end if;
  return new;
end;
$$;

create trigger trg_prevent_admin_self_privilege_change
before update on profiles
for each row
execute function public.prevent_admin_self_privilege_change();

-- No delete policy anywhere: deactivation uses `active = false`, rows are
-- never removed.

-- ============================================================
-- organizational_assignments
-- ============================================================

alter table organizational_assignments enable row level security;

create policy org_assignments_select on organizational_assignments
for select to authenticated
using (
  staff_id = auth.uid()
  or team_lead_id = auth.uid()
  or department_head_id = auth.uid()
  or department = public.current_profile_department()
  or public.current_profile_role() in ('spm', 'hr', 'admin')
);

create policy org_assignments_insert_admin on organizational_assignments
for insert to authenticated
with check (public.current_profile_role() = 'admin');

create policy org_assignments_update_admin on organizational_assignments
for update to authenticated
using (public.current_profile_role() = 'admin')
with check (public.current_profile_role() = 'admin');
-- Note: "insert new row + close out prior row's effective_to, never
-- update-in-place of an active range" is an application-layer write
-- discipline, not something this RLS policy enforces at the column level —
-- the confirmed RLS design for this table only specifies "Admin: full
-- read/write," with no behavioral test requested for the write-pattern
-- discipline itself. Flagging this so it isn't assumed to be DB-enforced.

-- No delete policy: history is permanent.

-- ============================================================
-- timesheets
-- ============================================================

alter table timesheets enable row level security;

-- Combined read policy. department in ('operations','medical') is always
-- true today (department_type has exactly those two values), so the SPM
-- clause is written out literally per the confirmed classification-aware
-- formula rather than collapsed to "true" — see chat report for why.
create policy timesheets_select on timesheets
for select to authenticated
using (
  staff_id = auth.uid()
  or public.is_actor_on_timesheet(id)
  or public.is_team_lead_of(staff_id)
  or public.is_department_head_of(staff_id)
  or public.current_profile_role() = 'hr'
  or (
    public.current_profile_role() = 'spm'
    and (
      department in ('operations', 'medical')
      or public.profile_role(staff_id) in ('team_lead', 'department_head', 'hr')
    )
  )
);

-- Staff write window. Scoping decision flagged in chat: this permits
-- editing content while draft/returning, but does NOT permit a raw client
-- update to advance status forward (e.g. to pending_team_lead) — that
-- transition is deferred to a Phase 4 server-side function, consistent
-- with "validate critical workflow transitions server-side" (section 21)
-- and with timesheet_actions requiring a server-side writer. Flagged for
-- confirmation, not assumed silently.
create policy timesheets_insert_staff on timesheets
for insert to authenticated
with check (staff_id = auth.uid() and status = 'draft');

create policy timesheets_update_staff on timesheets
for update to authenticated
using (staff_id = auth.uid() and status in ('draft', 'returning'))
with check (staff_id = auth.uid() and status in ('draft', 'returning'));

-- No policies for Team Lead / Department Head / SPM / HR / Admin write —
-- all explicitly no-write per the confirmed design. No delete policy.

-- ============================================================
-- attendance_entries
-- ============================================================

alter table attendance_entries enable row level security;

-- Read: delegates entirely to timesheets' own SELECT policy via EXISTS —
-- this row is visible iff the parent timesheet is visible to the caller.
-- No independent copy of the visibility conditions, per the confirmed
-- design ("do not write a parallel, independently maintained copy").
create policy attendance_entries_select on attendance_entries
for select to authenticated
using (
  exists (select 1 from timesheets t where t.id = attendance_entries.timesheet_id)
);

-- Write: timesheets' SELECT policy is too broad to delegate to for writes
-- (it includes approvers), so the staff write-window condition is restated
-- directly here — this mirrors timesheets_update_staff's own condition,
-- which is the one place that condition is defined; there's no RLS
-- mechanism to delegate to another table's UPDATE policy the way SELECT
-- can delegate via EXISTS.
create policy attendance_entries_insert_staff on attendance_entries
for insert to authenticated
with check (
  exists (
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
  exists (
    select 1 from timesheets t
    where t.id = attendance_entries.timesheet_id
      and t.staff_id = auth.uid()
      and t.status in ('draft', 'returning')
  )
);

-- ============================================================
-- public_holidays
-- ============================================================

alter table public_holidays enable row level security;

create policy public_holidays_select on public_holidays
for select to authenticated
using (true);

create policy public_holidays_insert_admin on public_holidays
for insert to authenticated
with check (public.current_profile_role() = 'admin' and scope = 'org');
-- National-scope rows only ever come from a seed migration run with
-- service_role (which bypasses RLS) — this policy deliberately excludes
-- scope = 'national' from client-facing inserts, admin included.

-- ============================================================
-- approval_steps
-- ============================================================

alter table approval_steps enable row level security;

create policy approval_steps_select on approval_steps
for select to authenticated
using (
  exists (
    select 1 from timesheets t
    where t.id = approval_steps.timesheet_id and t.staff_id = auth.uid()
  )
  -- approver_id = auth.uid() alone covers both "current pending" and
  -- "historically acted on" — it's a fixed snapshot value regardless of
  -- this row's current status.
  or approver_id = auth.uid()
);

create policy approval_steps_update_approver on approval_steps
for update to authenticated
using (
  approver_id = auth.uid()
  and status = 'pending'
  -- Self-approval prevention. Deliberately redundant with chain-generation
  -- logic never assigning this in the first place — both layers must be
  -- proven independently (per confirmed design), not treated as one
  -- making the other unnecessary.
  and exists (
    select 1 from timesheets t
    where t.id = approval_steps.timesheet_id and t.staff_id != auth.uid()
  )
  -- Step-ordering enforcement: every lower step_order in the same cycle
  -- must already be resolved (approved or skipped) before this one can be
  -- acted on.
  and not exists (
    select 1 from approval_steps prior
    where prior.timesheet_id = approval_steps.timesheet_id
      and prior.cycle_number = approval_steps.cycle_number
      and prior.step_order < approval_steps.step_order
      and prior.status = 'pending'
  )
)
with check (
  approver_id = auth.uid()
  and status in ('approved', 'declined')
);

-- No insert/delete policy for anyone: chain generation is server-side
-- (service_role, bypasses RLS), never a client-facing insert. No admin
-- policy at all: "no read or write access to this table."

-- ============================================================
-- timesheet_actions
-- ============================================================

alter table timesheet_actions enable row level security;

-- Read: delegates to timesheets' own SELECT policy, same pattern as
-- attendance_entries — "same access rule as timesheets read access."
create policy timesheet_actions_select on timesheet_actions
for select to authenticated
using (
  exists (select 1 from timesheets t where t.id = timesheet_actions.timesheet_id)
);

-- No insert/update/delete policy for anyone: strictly append-only via the
-- server-side function/transaction that also updates approval_steps, never
-- a direct client insert. No admin policy: "no access."

-- ============================================================
-- notifications
-- ============================================================

alter table notifications enable row level security;

create policy notifications_select on notifications
for select to authenticated
using (recipient_id = auth.uid());

-- Column-level grant restricts which columns an UPDATE can touch — this is
-- Postgres's native mechanism for "only this field is client-writable,"
-- cleaner than a trigger for this case since it's an unconditional
-- per-column restriction (unlike profiles' admin-self-role case, which is
-- row-conditional and needs a trigger instead). Supabase's default project
-- privileges grant broad UPDATE on new tables to `authenticated`, so the
-- revoke is necessary — without it, RLS would still gate row eligibility,
-- but every column would remain writable.
revoke update on notifications from authenticated;
grant update (read_at) on notifications to authenticated;

create policy notifications_update_own on notifications
for update to authenticated
using (recipient_id = auth.uid())
with check (recipient_id = auth.uid());

-- No insert/delete policy for anyone: system-generated only, same
-- reasoning as timesheet_actions. No special admin access.
