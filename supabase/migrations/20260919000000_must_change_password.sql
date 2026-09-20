-- Kalthum for Peace — Automated Timesheet System
-- Mandatory change-password on first login.
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
--
-- profiles.must_change_password: true from the moment an account is created
-- with a temporary password, until the person sets a real one. The app
-- (middleware) refuses to show anything else while it is true; the server
-- action that changes the password clears it with the service role (no
-- profiles UPDATE policy exists for ordinary users, so a user can't clear it
-- themselves by any other route).
--
-- Two-step on purpose:
--   1. add the column DEFAULT false  -> every EXISTING row is false. Nobody
--      already using the system (fixtures, the real SPM account) gets locked
--      behind a gate they never agreed to.
--   2. then set the column default to TRUE -> every profile created from now
--      on, by ANY path (Add Staff, the bootstrap script, a hand-written
--      insert), starts gated unless the creator explicitly says otherwise.
--      Fail-safe direction: forgetting the flag can only ever make an account
--      stricter, never looser.
--
-- Not a database-enforced boundary: this gates the app. A gated user who
-- talks to the API directly with their own token is not blocked by this
-- column (they can still only do what RLS already lets their role do). The
-- protection it buys is that the temporary password — which the creating
-- admin knows — stops being a working credential after the first sign-in.

alter table profiles
  add column must_change_password boolean not null default false;

alter table profiles
  alter column must_change_password set default true;
