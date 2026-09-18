// Deletes the 5 dev-only ui-test-* fixture accounts created by
// create-ui-test-users.mjs, plus any timesheet data they generated.
// Run this before this project is ever pointed at Kalthum's real production
// Supabase project — these accounts must not exist there.
//
// Deletes in FK dependency order (children before parents; profiles before
// the auth.users row they reference, since that FK has no ON DELETE CASCADE):
//   notifications -> timesheets (cascades to attendance_entries,
//   approval_steps, timesheet_actions) -> organizational_assignments ->
//   profiles -> auth.users.
//
// Safe to re-run: each step is a no-op once its rows are gone.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const EMAILS = [
  'ui-test-staff@kalthum-dev.test',
  'ui-test-teamlead@kalthum-dev.test',
  'ui-test-depthead@kalthum-dev.test',
  'ui-test-spm@kalthum-dev.test',
  'ui-test-hr@kalthum-dev.test',
  'ui-test-outsider@kalthum-dev.test',
  'ui-test-admin@kalthum-dev.test',
  // Created through the real admin UI flow during testing, not by
  // create-ui-test-users.mjs — still needs cleaning up before production.
  'ui-test-medical-staff@kalthum-dev.test',
  // Throwaway fixture from the header/calendar accent pass — needed a
  // genuinely in-progress (partially filled) draft to screenshot, since
  // every existing fixture's timesheet was already either fully filled or
  // blocked by the future-month lock. Deleted immediately after use, same
  // discipline as ui-test-outsider above.
  'ui-test-progress@kalthum-dev.test',
];

async function main() {
  const { data: profiles, error: profilesError } = await admin
    .from('profiles')
    .select('id, email')
    .in('email', EMAILS);
  if (profilesError) throw new Error('fetch profiles: ' + profilesError.message);

  if (profiles.length === 0) {
    console.log('No ui-test-* profiles found — already clean.');
    return;
  }

  const ids = profiles.map((p) => p.id);
  console.log(`Found ${profiles.length} ui-test-* profile(s):`, profiles.map((p) => p.email));

  const { error: notifErr, count: notifCount } = await admin
    .from('notifications')
    .delete({ count: 'exact' })
    .in('recipient_id', ids);
  if (notifErr) throw new Error('delete notifications: ' + notifErr.message);
  console.log(`Deleted ${notifCount ?? 0} notification(s).`);

  // Cascades to attendance_entries, approval_steps, timesheet_actions for
  // these timesheets (all declared ON DELETE CASCADE from timesheet_id).
  const { error: tsErr, count: tsCount } = await admin
    .from('timesheets')
    .delete({ count: 'exact' })
    .in('staff_id', ids);
  if (tsErr) throw new Error('delete timesheets: ' + tsErr.message);
  console.log(`Deleted ${tsCount ?? 0} timesheet(s) (and their cascaded rows).`);

  // Any approval_steps where one of these ids was the approver on someone
  // ELSE's timesheet (not caught by the staff_id delete above).
  const { error: stepsErr, count: stepsCount } = await admin
    .from('approval_steps')
    .delete({ count: 'exact' })
    .in('approver_id', ids);
  if (stepsErr) throw new Error('delete approval_steps: ' + stepsErr.message);
  console.log(`Deleted ${stepsCount ?? 0} additional approval_steps row(s) as approver.`);

  const { error: oaErr, count: oaCount } = await admin
    .from('organizational_assignments')
    .delete({ count: 'exact' })
    .or(
      `staff_id.in.(${ids.join(',')}),team_lead_id.in.(${ids.join(',')}),department_head_id.in.(${ids.join(',')}),created_by.in.(${ids.join(',')})`,
    );
  if (oaErr) throw new Error('delete organizational_assignments: ' + oaErr.message);
  console.log(`Deleted ${oaCount ?? 0} organizational_assignments row(s).`);

  const { error: profErr, count: profCount } = await admin
    .from('profiles')
    .delete({ count: 'exact' })
    .in('id', ids);
  if (profErr) throw new Error('delete profiles: ' + profErr.message);
  console.log(`Deleted ${profCount ?? 0} profile(s).`);

  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw new Error(`deleteUser(${id}): ${error.message}`);
  }
  console.log(`Deleted ${ids.length} auth user(s).`);

  console.log('\nAll ui-test-* fixtures removed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
