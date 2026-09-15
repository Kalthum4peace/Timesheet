// One-off behavioral test for the organizational_assignments append-only
// trigger (Part 0). Creates one real test profile + a couple of assignment
// rows, exercises both required cases, then deletes everything it created.

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

function record(label, pass, detail) {
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${label}${detail ? '  (' + detail + ')' : ''}`);
}

async function main() {
  const email = `trigger-test-${Date.now()}@kalthum-dev.test`;
  const { data: authUser, error: authErr } = await admin.auth.admin.createUser({ email, password: 'Test-Aa1!' + Math.random(), email_confirm: true });
  if (authErr) throw new Error('createUser: ' + authErr.message);
  const staffId = authUser.user.id;

  const { error: profErr } = await admin.from('profiles').insert({ id: staffId, full_name: 'Trigger Test Staff', email, location: 'Maiduguri', role: 'staff' });
  if (profErr) throw new Error('profile insert: ' + profErr.message);

  // Row 1: active assignment (effective_to = null)
  const { data: row1, error: r1Err } = await admin.from('organizational_assignments').insert({
    staff_id: staffId, department: 'operations', effective_from: '2026-01-01', created_by: staffId,
  }).select().single();
  if (r1Err) throw new Error('row1 insert: ' + r1Err.message);

  // Test A: normal close-out (effective_to: null -> a date) must succeed.
  const { data: closed, error: closeErr } = await admin.from('organizational_assignments')
    .update({ effective_to: '2026-06-30' }).eq('id', row1.id).select();
  record('Close-out UPDATE (effective_to null -> date) succeeds', !closeErr && closed?.length === 1, closeErr?.message);

  // Test B: inserting the replacement row after close-out must succeed
  // (trigger must not affect INSERT at all).
  const { data: row2, error: r2Err } = await admin.from('organizational_assignments').insert({
    staff_id: staffId, department: 'medical', effective_from: '2026-07-01', created_by: staffId,
  }).select().single();
  record('INSERT of replacement row after close-out succeeds', !r2Err && !!row2, r2Err?.message);

  // Test C: re-editing the now-closed row must be REJECTED.
  const { data: reEdit, error: reEditErr } = await admin.from('organizational_assignments')
    .update({ effective_to: '2026-12-31' }).eq('id', row1.id).select();
  record('Re-editing an already-closed row is rejected', !!reEditErr, reEditErr?.message || 'no error, ' + reEdit?.length + ' row(s) updated');

  // Test D: editing an unrelated field on the same closed row must also be rejected.
  const { data: reEdit2, error: reEditErr2 } = await admin.from('organizational_assignments')
    .update({ department: 'medical' }).eq('id', row1.id).select();
  record('Editing any field on a closed row is rejected (not just effective_to)', !!reEditErr2, reEditErr2?.message || 'no error, ' + reEdit2?.length + ' row(s) updated');

  console.log('\nCleaning up...');
  await admin.from('organizational_assignments').delete().in('id', [row1.id, row2?.id].filter(Boolean));
  await admin.from('profiles').delete().eq('id', staffId);
  await admin.auth.admin.deleteUser(staffId);
  console.log('Done.');
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e.message);
  process.exit(1);
});
