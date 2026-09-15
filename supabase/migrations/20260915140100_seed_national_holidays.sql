-- Kalthum for Peace — Automated Timesheet System
-- Seed data: Nigerian national public holidays (scope = 'national')
-- DRY RUN — not yet applied.
--
-- Covers 2026-2027. Fixed-date holidays are standard. Good Friday and
-- Easter Monday were computed via the standard Gregorian Easter algorithm
-- (Meeus/Jones/Butcher) for each year, not guessed:
--   2026: Easter Sunday 2026-04-05 -> Good Friday 2026-04-03, Easter Monday 2026-04-06
--   2027: Easter Sunday 2027-03-28 -> Good Friday 2027-03-26, Easter Monday 2027-03-29
--
-- FLAGGED, DELIBERATELY NOT INCLUDED — Nigeria's Islamic-calendar public
-- holidays: Eid al-Fitr, Eid al-Kabir (Eid al-Adha), and Eid al-Mawlid
-- (Maulud). These are moveable, lunar-sighting-dependent dates announced
-- by Nigeria's National Moon Sighting Committee shortly before each
-- occurrence — they cannot be reliably computed or predicted this far in
-- advance. They need manual entry each year once officially announced;
-- do not invent dates for them. See CLAUDE.md status section.

insert into public_holidays (date, name, scope, created_by) values
  ('2026-01-01', 'New Year''s Day', 'national', null),
  ('2026-04-03', 'Good Friday', 'national', null),
  ('2026-04-06', 'Easter Monday', 'national', null),
  ('2026-05-01', 'Workers'' Day', 'national', null),
  ('2026-06-12', 'Democracy Day', 'national', null),
  ('2026-10-01', 'Independence Day', 'national', null),
  ('2026-12-25', 'Christmas Day', 'national', null),
  ('2026-12-26', 'Boxing Day', 'national', null),

  ('2027-01-01', 'New Year''s Day', 'national', null),
  ('2027-03-26', 'Good Friday', 'national', null),
  ('2027-03-29', 'Easter Monday', 'national', null),
  ('2027-05-01', 'Workers'' Day', 'national', null),
  ('2027-06-12', 'Democracy Day', 'national', null),
  ('2027-10-01', 'Independence Day', 'national', null),
  ('2027-12-25', 'Christmas Day', 'national', null),
  ('2027-12-26', 'Boxing Day', 'national', null)
on conflict (date, scope) do nothing;
