-- Kalthum for Peace — Automated Timesheet System
-- Initial schema migration (Phases 1-3 architecture review output)
-- DRY RUN — not yet applied to any database. See CLAUDE.md standing rules.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ============================================================
-- ENUMS
-- ============================================================

create type role_type as enum (
  'staff', 'team_lead', 'department_head', 'spm', 'hr', 'admin'
);

create type department_type as enum (
  'medical', 'operations'
);

create type attendance_status as enum (
  'present', 'absent', 'public_holiday', 'leave'
);

create type timesheet_status as enum (
  'draft', 'pending_team_lead', 'pending_department_head',
  'pending_final_review', 'returning', 'approved'
);

create type approval_type as enum (
  'team_lead', 'department_head', 'spm', 'hr'
);

create type step_status as enum (
  'pending', 'approved', 'declined', 'skipped'
);

create type action_type as enum (
  'submitted', 'approved', 'declined', 'return_acknowledged',
  'edited', 'resubmitted'
);

create type notification_type as enum (
  'submission', 'approval_required', 'approved', 'declined',
  'returned', 'return_acknowledged', 'resubmitted', 'final_approval'
);

-- ============================================================
-- profiles
-- ============================================================

create table profiles (
  id uuid primary key references auth.users(id),
  full_name text not null,
  email text not null unique,
  location text not null,
  role role_type not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- No `department` column: current department is derived by querying the
-- open-ended row in organizational_assignments, never stored redundantly here.

-- ============================================================
-- organizational_assignments
-- ============================================================

create table organizational_assignments (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references profiles(id),
  team_lead_id uuid references profiles(id),
  department_head_id uuid references profiles(id),
  department department_type not null,
  effective_from date not null,
  effective_to date,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),

  -- Prevent overlapping active-date ranges for the same staff member.
  -- effective_to = null is treated as an open (unbounded) upper end by
  -- daterange(), so a currently-active row correctly excludes any other
  -- row overlapping it.
  constraint organizational_assignments_no_overlap
    exclude using gist (
      staff_id with =,
      daterange(effective_from, effective_to) with &&
    )
);
-- Writes are always INSERT of a new row + closing out the prior row's
-- effective_to — never UPDATE-in-place of an active assignment's date range.

-- ============================================================
-- timesheets
-- ============================================================

create table timesheets (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references profiles(id),
  location text not null,     -- snapshot at creation, not derived
  department department_type not null,  -- snapshot at creation, not derived
  month smallint not null check (month between 1 and 12),
  year smallint not null check (year >= 2020),
  status timesheet_status not null default 'draft',
  submitted_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint timesheets_one_per_staff_month unique (staff_id, month, year)
);

-- ============================================================
-- attendance_entries
-- ============================================================

create table attendance_entries (
  id uuid primary key default gen_random_uuid(),
  timesheet_id uuid not null references timesheets(id) on delete cascade,
  date date not null,
  status attendance_status not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint attendance_entries_one_per_day unique (timesheet_id, date)
);

-- ============================================================
-- public_holidays
-- ============================================================

create table public_holidays (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  name text not null,
  scope text not null check (scope in ('national', 'org')),
  created_by uuid references profiles(id),  -- null for national/seed data
  created_at timestamptz not null default now(),

  constraint public_holidays_unique_per_scope unique (date, scope)
);

-- ============================================================
-- approval_steps
-- ============================================================

create table approval_steps (
  id uuid primary key default gen_random_uuid(),
  timesheet_id uuid not null references timesheets(id) on delete cascade,
  cycle_number smallint not null,
  step_order smallint not null,
  approval_type approval_type not null,
  approver_id uuid not null references profiles(id),
  status step_status not null default 'pending',
  comment text,
  acted_at timestamptz,
  created_at timestamptz not null default now(),

  -- approval_type is part of the key (not just timesheet_id, cycle_number,
  -- step_order) so that the Operations dual-approval pair — SPM and HR
  -- sharing the same step_order within a cycle — can coexist as two rows,
  -- while true duplicates at the same step/type are still blocked.
  constraint approval_steps_unique_step
    unique (timesheet_id, cycle_number, step_order, approval_type)
);
-- cycle_number is the resubmission mechanism (1 = original submission, a
-- decline-and-resubmit produces a new cycle with entirely new rows). The
-- timesheet's current cycle = max(cycle_number) for that timesheet — derived,
-- never stored separately.

-- ============================================================
-- timesheet_actions (append-only, forever, across all cycles)
-- ============================================================

create table timesheet_actions (
  id uuid primary key default gen_random_uuid(),
  timesheet_id uuid not null references timesheets(id) on delete cascade,
  cycle_number smallint not null,
  actor_id uuid not null references profiles(id),
  action action_type not null,
  comment text,
  created_at timestamptz not null default now()
);
-- Rows here must only ever be created by the same server-side function/
-- transaction that updates an approval_steps row — never a direct client
-- insert. Enforced later via RLS (no client-facing INSERT policy) + a
-- Postgres function/trigger — not part of this migration.

-- ============================================================
-- notifications
-- ============================================================

create table notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references profiles(id),
  timesheet_id uuid references timesheets(id) on delete set null,
  type notification_type not null,
  title text not null,
  message text not null,
  read_at timestamptz,
  email_sent_at timestamptz,
  created_at timestamptz not null default now()
);
-- on delete set null (not cascade): a notification is a historical fact
-- about the recipient and shouldn't vanish if a timesheet row is ever
-- hard-deleted (should essentially never happen given the immutability
-- principle, but the FK is defensive anyway).

-- ============================================================
-- Recommended indexes
-- ============================================================

create index idx_org_assignments_staff_range
  on organizational_assignments (staff_id, effective_from, effective_to);

create index idx_approval_steps_approver_status
  on approval_steps (approver_id, status);

create index idx_timesheets_staff_status
  on timesheets (staff_id, status);

create index idx_timesheets_department_status
  on timesheets (department, status);

create index idx_timesheet_actions_timesheet_cycle
  on timesheet_actions (timesheet_id, cycle_number);

create index idx_notifications_recipient_read
  on notifications (recipient_id, read_at);
