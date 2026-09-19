// Behavioral test for the "at most one active HR-position profile" partial
// unique index (supabase/migrations/20260918060000_one_active_hr_position.sql).
//
// The application-layer guard in createStaffMember is a check-then-insert and
// can't be race-proof; this proves the DATABASE closes the gap. Same pattern
// as the SPM+HR race in scripts/test-approve.mjs: genuinely concurrent
// (Promise.all — never sequential awaits), repeated, asserting exactly one
// winner.
//
// Runs at the profiles-table level (service role), not through the Next.js
// server action, because a server action can't be fired concurrently from a
// script — and the constraint, not the action, is what's under test.
//
// The dev project already has a real active HR-position profile
// (ui-test-hr), which would make EVERY insert here fail and prove nothing
// about "exactly one wins". So this temporarily deactivates it and restores
// it in `finally`, after deleting every test row (order matters: reactivating
// it while a test HR is still active would itself violate the index).
//
// Before the migration is applied this test is EXPECTED to fail — both racers
// succeed. That failure is the demonstration of the race window.
//
// Run with: node scripts/test-one-active-hr.mjs

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const INDEX = 'profiles_one_active_hr_position';
const FIXTURE_HR = 'ui-test-hr@kalthum-dev.test';

const results = [];
function record(label, pass, detail) {
  results.push({ label, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${label}${detail ? '  (' + detail + ')' : ''}`);
}

const createdIds = [];
async function newUser(tag) {
  const email = `one-hr-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@kalthum-dev.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password: 'Test-' + Math.random().toString(36).slice(2) + 'Aa1!', email_confirm: true,
  });
  if (error) throw new Error(`createUser(${tag}): ${error.message}`);
  createdIds.push(data.user.id);
  return { id: data.user.id, email };
}
const insertProfile = (u, role, active) =>
  admin.from('profiles').insert({ id: u.id, full_name: `OneHR ${role}`, email: u.email, location: 'Yola', role, active });
const isIndexViolation = (err) => !!err && err.code === '23505' && String(err.message).includes(INDEX);
async function activeHrPositions() {
  const { data } = await admin.from('profiles').select('email,role').in('role', ['hr', 'admin_hr']).eq('active', true);
  return data ?? [];
}

let fixtureWasActive = false;

async function main() {
  const { data: fixture } = await admin.from('profiles').select('id,active').eq('email', FIXTURE_HR).single();
  fixtureWasActive = !!fixture?.active;
  if (fixtureWasActive) {
    await admin.from('profiles').update({ active: false }).eq('email', FIXTURE_HR);
    console.log(`(temporarily deactivated ${FIXTURE_HR}; restored at the end)\n`);
  }
  const pre = await activeHrPositions();
  record('precondition: no active HR-position profile before the test starts', pre.length === 0, pre.map((p) => p.email).join(', '));

  console.log('\n--- A: two-way races (Promise.all), 3 rounds ---\n');
  for (let round = 1; round <= 3; round++) {
    const a = await newUser(`r${round}a`), b = await newUser(`r${round}b`);
    const [ra, rb] = await Promise.all([insertProfile(a, 'admin_hr', true), insertProfile(b, 'admin_hr', true)]);
    const wins = [ra, rb].filter((r) => !r.error).length;
    const losers = [ra, rb].filter((r) => r.error);
    record(`round ${round}: exactly one of two simultaneous creations succeeds`, wins === 1, `successes=${wins}`);
    record(`round ${round}: the loser is rejected by the index itself (23505 ${INDEX})`,
      losers.length === 1 && isIndexViolation(losers[0].error), losers[0]?.error ? `${losers[0].error.code}: ${losers[0].error.message}` : 'no loser');
    record(`round ${round}: exactly one active HR-position profile exists afterward`, (await activeHrPositions()).length === 1);
    await admin.from('profiles').delete().in('id', [a.id, b.id]);
  }

  console.log('\n--- B: four-way race ---\n');
  {
    const four = [];
    for (let i = 0; i < 4; i++) four.push(await newUser(`f${i}`));
    const rs = await Promise.all(four.map((u) => insertProfile(u, 'admin_hr', true)));
    const wins = rs.filter((r) => !r.error).length;
    record('exactly one of four simultaneous creations succeeds', wins === 1, `successes=${wins}`);
    const losers4 = rs.filter((r) => r.error);
    record('there are exactly three losers and every one is an index violation',
      losers4.length === 3 && losers4.every((r) => isIndexViolation(r.error)), `losers=${losers4.length}`);
    await admin.from('profiles').delete().in('id', four.map((u) => u.id));
  }

  console.log('\n--- C: rule semantics (sequential) ---\n');
  const w = await newUser('winner');
  const rW = await insertProfile(w, 'admin_hr', true);
  record('first active admin_hr is accepted', !rW.error, rW.error?.message);

  // Separate user from `x` below so this step's outcome can't affect later ones.
  const cross = await newUser('cross');
  const rCross = await insertProfile(cross, 'hr', true);
  record("a plain 'hr' is rejected while an 'admin_hr' is active (roles collide with EACH OTHER — a unique index on the role column would have missed this)",
    isIndexViolation(rCross.error), rCross.error?.message ?? 'was accepted');

  const x = await newUser('x');
  const rInactive = await insertProfile(x, 'hr', false);
  record('an INACTIVE hr profile is fine alongside an active admin_hr', !rInactive.error, rInactive.error?.message);

  const rReact = await admin.from('profiles').update({ active: true }).eq('id', x.id);
  record('reactivating that inactive hr is rejected while the admin_hr is active', isIndexViolation(rReact.error), rReact.error?.message ?? 'was accepted');

  const s = await newUser('staff');
  const rStaff = await insertProfile(s, 'staff', true);
  record('ordinary active staff profiles are unaffected', !rStaff.error, rStaff.error?.message);

  await admin.from('profiles').update({ active: false }).eq('id', w.id);
  const rSwap = await admin.from('profiles').update({ active: true }).eq('id', x.id);
  record('after deactivating the active one, the other can be activated (the intended replace-HR path)', !rSwap.error, rSwap.error?.message);

  const rBack = await admin.from('profiles').update({ active: true }).eq('id', w.id);
  record('and the first one can no longer be reactivated over it', isIndexViolation(rBack.error), rBack.error?.message ?? 'was accepted');

  const rRole = await admin.from('profiles').update({ role: 'admin_hr' }).eq('id', x.id);
  record('changing the active one hr -> admin_hr (same row) is unaffected', !rRole.error, rRole.error?.message);

  const finalActive = await activeHrPositions();
  record('exactly one active HR-position profile at the end of the test', finalActive.length === 1, finalActive.map((p) => p.email).join(', '));
}

async function cleanup() {
  console.log('\nCleaning up...');
  if (createdIds.length) {
    await admin.from('notifications').delete().in('recipient_id', createdIds);
    await admin.from('profiles').delete().in('id', createdIds);
    for (const id of createdIds) await admin.auth.admin.deleteUser(id);
  }
  if (fixtureWasActive) {
    const r = await admin.from('profiles').update({ active: true }).eq('email', FIXTURE_HR).select('email,role,active');
    console.log('Restored fixture:', JSON.stringify(r.data), r.error ? 'ERROR ' + r.error.message : '');
  }
  const { data: left } = await admin.from('profiles').select('id').in('id', createdIds.length ? createdIds : ['00000000-0000-0000-0000-000000000000']);
  const hr = await activeHrPositions();
  console.log(`Cleanup verified: ${left?.length ?? 0} test profile(s) remain; active HR-position profiles now: ${hr.length} (${hr.map((p) => p.email).join(', ')})`);
}

main()
  .catch((e) => { console.error('\nTEST HARNESS ERROR:', e.message); results.push({ label: 'harness', pass: false }); })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  });
