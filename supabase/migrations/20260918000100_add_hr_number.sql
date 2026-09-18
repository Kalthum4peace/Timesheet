-- Kalthum for Peace — Automated Timesheet System
-- Client feedback (demo, 2026-09-18), Part 1 item 5: optional "HR Number"
-- field on staff profiles — a search/autocomplete convenience for looking
-- up a staff member, NOT a login credential (login stays email-based).
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
--
-- Nullable (not every profile will have one, and it's opt-in per the
-- client's own framing). Unique among the rows that DO have one — an HR
-- number that collided with someone else's would defeat the whole point of
-- using it as a lookup key. Partial index (where hr_number is not null) so
-- the many profiles without one don't collide with each other on null.
--
-- No RLS change needed: profiles_select already governs row-level
-- visibility (self, team lead/department head of the subject, spm/hr/admin)
-- and there's no column-level restriction on profiles SELECT to extend —
-- unlike notifications' read_at case, every column profiles exposes is
-- already visible to whoever can see the row at all. Writes go through the
-- existing profiles_update_admin policy — admin can already write any
-- column on any (non-self-privilege) row.

alter table profiles add column hr_number text;

create unique index profiles_hr_number_unique
  on profiles (hr_number)
  where hr_number is not null;
