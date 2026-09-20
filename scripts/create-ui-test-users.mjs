// Creates persistent dev-only personas for manually exercising the UI
// against the real backend (unlike the test-*.mjs scripts, these are NOT
// torn down afterward — they're a standing fixture for this dev project).
// Safe to re-run: skips creating a persona if its email already exists.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(URL_, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// Hardcoded on purpose — this is a dev-only placeholder for 5 fixture
// accounts that only ever exist in the personal dev Supabase project, never
// a real credential. Deliberately shaped to not resemble a real password
// pattern someone might reuse. Delete these accounts (see
// scripts/delete-ui-test-users.mjs) before this project is ever pointed at
// Kalthum's real production Supabase project.
const PASSWORD = 'KfpDevTest1!';

const PERSONAS = [
  { key: 'staff', email: 'ui-test-staff@kalthum-dev.test', full_name: 'Amina UI-Test Staff', role: 'staff' },
  { key: 'team_lead', email: 'ui-test-teamlead@kalthum-dev.test', full_name: 'Bala UI-Test Team Lead', role: 'team_lead' },
  { key: 'department_head', email: 'ui-test-depthead@kalthum-dev.test', full_name: 'Chidi UI-Test Dept Head', role: 'department_head' },
  { key: 'spm', email: 'ui-test-spm@kalthum-dev.test', full_name: 'Deola UI-Test SPM', role: 'spm' },
  // admin_hr, not hr: plain hr is retired for new accounts (client decision,
  // round 2, 2026-09-18) and this fixture doubles as the demo HR login, so
  // it needs to reach Add Staff too — one login, both HR and Admin surfaces.
  { key: 'hr', email: 'ui-test-hr@kalthum-dev.test', full_name: 'Efe UI-Test HR', role: 'admin_hr' },
  // Deliberately has zero relationship to any other fixture's chain — no
  // organizational_assignments row, never named on anyone's approval_steps.
  // Exists to test authorization boundaries (e.g. current_return_recipient
  // must return NULL for a caller with no legitimate relationship).
  { key: 'outsider', email: 'ui-test-outsider@kalthum-dev.test', full_name: 'Grace UI-Test Outsider', role: 'staff' },
  { key: 'admin', email: 'ui-test-admin@kalthum-dev.test', full_name: 'Halima UI-Test Admin', role: 'admin' },
];

async function findOrCreate(persona) {
  const { data: existingProfile } = await admin.from('profiles').select('id').eq('email', persona.email).maybeSingle();
  if (existingProfile) {
    console.log(`exists — ${persona.email} (${existingProfile.id})`);
    return existingProfile.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: persona.email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser(${persona.email}): ${error.message}`);
  const id = data.user.id;
  const { error: profErr } = await admin.from('profiles').insert({
    id, full_name: persona.full_name, email: persona.email, location: 'Maiduguri', role: persona.role,
    // The column defaults to true for new profiles; standing dev fixtures share
    // a known password and must not be gated behind a change-password screen.
    must_change_password: false,
  });
  if (profErr) throw new Error(`profiles insert(${persona.email}): ${profErr.message}`);
  console.log(`created — ${persona.email} (${id})`);
  return id;
}

async function main() {
  const ids = {};
  for (const p of PERSONAS) {
    ids[p.key] = await findOrCreate(p);
  }

  const { data: existingAssignment } = await admin
    .from('organizational_assignments')
    .select('id')
    .eq('staff_id', ids.staff)
    .is('effective_to', null)
    .maybeSingle();

  if (existingAssignment) {
    console.log('organizational_assignments row already exists for ui-test-staff — skipping.');
  } else {
    const { error } = await admin.from('organizational_assignments').insert({
      staff_id: ids.staff,
      team_lead_id: ids.team_lead,
      department_head_id: ids.department_head,
      department: 'operations',
      effective_from: '2026-01-01',
      created_by: ids.department_head,
    });
    if (error) throw new Error('organizational_assignments insert: ' + error.message);
    console.log('organizational_assignments row created for ui-test-staff.');
  }

  console.log('\nDev UI test logins (all share the same password):');
  for (const p of PERSONAS) console.log(`  ${p.role.padEnd(16)} ${p.email}`);
  console.log(`  password: ${PASSWORD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
