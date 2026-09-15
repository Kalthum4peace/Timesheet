// One-off RLS behavioral verification script — NOT application code.
// Creates real auth users + rows in the dev Supabase project, signs in as
// each persona, attempts the specific accesses the Phase 3 design requires
// to succeed or fail, then deletes everything it created.
//
// Run with: node scripts/test-rls.mjs
// Reads NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY from .env (no framework env-loading available
// yet, so this parses .env directly).

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(URL_, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const results = [];
function record(label, pass, detail) {
  results.push({ label, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${label}${detail ? '  (' + detail + ')' : ''}`);
}

async function createPersona(key, full_name, role) {
  const email = `rls-test-${key}-${Date.now()}@kalthum-dev.test`;
  const password = 'Test-' + Math.random().toString(36).slice(2) + 'Aa1!';
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${key}): ${error.message}`);
  const id = data.user.id;
  const { error: profErr } = await admin.from('profiles').insert({
    id, full_name, email, location: 'Maiduguri', role,
  });
  if (profErr) throw new Error(`profiles insert(${key}): ${profErr.message}`);
  return { key, id, email, password };
}

async function signInAs(persona) {
  const client = createClient(URL_, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: persona.email, password: persona.password });
  if (error) throw new Error(`signIn(${persona.key}): ${error.message}`);
  return client;
}

async function main() {
  console.log('Creating personas...');
  const staff1 = await createPersona('staff1', 'Amina Staff', 'staff');
  const teamLead1 = await createPersona('teamlead1', 'Tunde TeamLead', 'team_lead');
  const headOps1 = await createPersona('headops1', 'Chioma HeadOps', 'department_head');
  const headMedical1 = await createPersona('headmed1', 'Bello HeadMedical', 'department_head');
  const spm1 = await createPersona('spm1', 'Grace SPM', 'spm');
  const hr1 = await createPersona('hr1', 'Ibrahim HR', 'hr');
  const admin1 = await createPersona('admin1', 'Yusuf Admin', 'admin');
  const allPersonas = [staff1, teamLead1, headOps1, headMedical1, spm1, hr1, admin1];

  console.log('Creating organizational_assignments...');
  const { error: oaErr } = await admin.from('organizational_assignments').insert([
    { staff_id: staff1.id, team_lead_id: teamLead1.id, department_head_id: headOps1.id, department: 'operations', effective_from: '2026-01-01', created_by: admin1.id },
    { staff_id: teamLead1.id, team_lead_id: null, department_head_id: headOps1.id, department: 'operations', effective_from: '2026-01-01', created_by: admin1.id },
    { staff_id: headOps1.id, team_lead_id: null, department_head_id: null, department: 'operations', effective_from: '2026-01-01', created_by: admin1.id },
    { staff_id: headMedical1.id, team_lead_id: null, department_head_id: null, department: 'medical', effective_from: '2026-01-01', created_by: admin1.id },
  ]);
  if (oaErr) throw new Error('org_assignments insert: ' + oaErr.message);

  console.log('Creating timesheets + approval_steps...');
  const { data: ts1, error: ts1Err } = await admin.from('timesheets').insert({
    staff_id: staff1.id, location: 'Maiduguri', department: 'operations', month: 1, year: 2026, status: 'pending_team_lead',
  }).select().single();
  if (ts1Err) throw new Error('timesheet ts1: ' + ts1Err.message);

  const { error: as1Err } = await admin.from('approval_steps').insert([
    { timesheet_id: ts1.id, cycle_number: 1, step_order: 1, approval_type: 'team_lead', approver_id: teamLead1.id, status: 'pending' },
    { timesheet_id: ts1.id, cycle_number: 1, step_order: 2, approval_type: 'department_head', approver_id: headOps1.id, status: 'pending' },
    { timesheet_id: ts1.id, cycle_number: 1, step_order: 3, approval_type: 'spm', approver_id: spm1.id, status: 'pending' },
    { timesheet_id: ts1.id, cycle_number: 1, step_order: 3, approval_type: 'hr', approver_id: hr1.id, status: 'pending' },
  ]);
  if (as1Err) throw new Error('approval_steps ts1: ' + as1Err.message);

  const { data: ts2, error: ts2Err } = await admin.from('timesheets').insert({
    staff_id: staff1.id, location: 'Maiduguri', department: 'operations', month: 2, year: 2026, status: 'pending_team_lead',
  }).select().single();
  if (ts2Err) throw new Error('timesheet ts2: ' + ts2Err.message);
  const { data: badStep, error: badStepErr } = await admin.from('approval_steps').insert({
    timesheet_id: ts2.id, cycle_number: 1, step_order: 1, approval_type: 'team_lead', approver_id: staff1.id, status: 'pending',
  }).select().single();
  if (badStepErr) throw new Error('bad self-approval step: ' + badStepErr.message);

  const { data: tsMed, error: tsMedErr } = await admin.from('timesheets').insert({
    staff_id: headMedical1.id, location: 'Maiduguri', department: 'medical', month: 1, year: 2026, status: 'pending_final_review',
  }).select().single();
  if (tsMedErr) throw new Error('timesheet tsMed: ' + tsMedErr.message);
  const { data: medSteps, error: medStepsErr } = await admin.from('approval_steps').insert([
    { timesheet_id: tsMed.id, cycle_number: 1, step_order: 1, approval_type: 'spm', approver_id: spm1.id, status: 'pending' },
    { timesheet_id: tsMed.id, cycle_number: 1, step_order: 1, approval_type: 'hr', approver_id: hr1.id, status: 'pending' },
  ]).select();
  if (medStepsErr) throw new Error('approval_steps tsMed: ' + medStepsErr.message);
  const spmStepOnMed = medSteps.find(s => s.approval_type === 'spm');

  const { data: notif, error: notifErr } = await admin.from('notifications').insert({
    recipient_id: staff1.id, timesheet_id: ts1.id, type: 'submission', title: 'Test', message: 'Test notification',
  }).select().single();
  if (notifErr) throw new Error('notification insert: ' + notifErr.message);

  console.log('Signing in as each persona...');
  const as = {};
  for (const p of allPersonas) as[p.key] = await signInAs(p);

  console.log('\n--- Running behavioral tests ---\n');

  // 1. SPM classification rule: Head of Medical's own timesheet (department=medical)
  //    must be readable AND actionable by SPM despite department != operations.
  {
    const { data, error } = await as.spm1.from('timesheets').select('id').eq('id', tsMed.id);
    record('SPM can READ Head-of-Medical\'s own timesheet (dept=medical)', !error && data.length === 1, error?.message);
  }
  {
    const { data, error } = await as.spm1.from('approval_steps')
      .update({ status: 'approved' }).eq('id', spmStepOnMed.id).select();
    record('SPM can APPROVE their step on Head-of-Medical\'s own timesheet', !error && data.length === 1 && data[0].status === 'approved', error?.message);
  }
  {
    const hrStepOnMed = medSteps.find(s => s.approval_type === 'hr');
    const { data, error } = await as.hr1.from('approval_steps')
      .update({ status: 'approved' }).eq('id', hrStepOnMed.id).select();
    record('HR can APPROVE their parallel step on the same timesheet', !error && data.length === 1, error?.message);
  }

  // 2. Self-approval rejection: staff1 is (deliberately, wrongly) listed as
  //    approver_id on their own timesheet's step — update must be rejected.
  {
    const { data, error } = await as.staff1.from('approval_steps')
      .update({ status: 'approved' }).eq('id', badStep.id).select();
    record('Self-approval UPDATE is rejected by the database', !error && data.length === 0, error?.message);
  }

  // 3. Step-ordering enforcement: approving step_order=2 while step_order=1
  //    (same cycle) is still pending must be rejected.
  const step2 = await admin.from('approval_steps').select('id').eq('timesheet_id', ts1.id).eq('step_order', 2).single();
  {
    const { data, error } = await as.headOps1.from('approval_steps')
      .update({ status: 'approved' }).eq('id', step2.data.id).select();
    record('Approving step_order=2 while step_order=1 pending is rejected', !error && data.length === 0, error?.message);
  }
  // Positive control: the legitimate step_order=1 approval must succeed...
  const step1 = await admin.from('approval_steps').select('id').eq('timesheet_id', ts1.id).eq('step_order', 1).single();
  {
    const { data, error } = await as.teamLead1.from('approval_steps')
      .update({ status: 'approved' }).eq('id', step1.data.id).select();
    record('Legitimate step_order=1 approval by the correct approver succeeds', !error && data.length === 1, error?.message);
  }
  // ...and now step_order=2 should be approvable, proving the earlier
  // rejection was really about ordering, not a blanket-deny bug.
  {
    const { data, error } = await as.headOps1.from('approval_steps')
      .update({ status: 'approved' }).eq('id', step2.data.id).select();
    record('Step_order=2 now approvable once step_order=1 is resolved', !error && data.length === 1, error?.message);
  }

  // 4. timesheet_actions: no direct client INSERT for anyone.
  {
    const { data, error } = await as.staff1.from('timesheet_actions')
      .insert({ timesheet_id: ts1.id, cycle_number: 1, actor_id: staff1.id, action: 'submitted' }).select();
    record('Direct client INSERT into timesheet_actions is rejected', !!error, error?.message || 'no error, ' + data?.length + ' row(s) inserted');
  }

  // 5. notifications: no direct client INSERT for anyone; only read_at is
  //    writable on existing rows.
  {
    const { data, error } = await as.staff1.from('notifications')
      .insert({ recipient_id: staff1.id, type: 'submission', title: 'x', message: 'x' }).select();
    record('Direct client INSERT into notifications is rejected', !!error, error?.message || 'no error, ' + data?.length + ' row(s) inserted');
  }
  {
    const { data, error } = await as.staff1.from('notifications')
      .update({ title: 'hacked' }).eq('id', notif.id).select();
    record('Updating a non-read_at column on own notification is rejected', !!error, error?.message || 'no error, ' + data?.length + ' row(s) updated');
  }
  {
    const { data, error } = await as.staff1.from('notifications')
      .update({ read_at: new Date().toISOString() }).eq('id', notif.id).select();
    record('Updating read_at on own notification succeeds', !error && data.length === 1, error?.message);
  }

  // 6. Admin's write boundary: enumerated to profiles + organizational_assignments
  //    + public_holidays only — must be rejected everywhere else.
  {
    const { data, error } = await as.admin1.from('timesheets')
      .update({ location: 'Hacked' }).eq('id', ts1.id).select();
    record('Admin UPDATE on timesheets is rejected', !error && data.length === 0, error?.message);
  }
  {
    const { data, error } = await as.admin1.from('approval_steps')
      .update({ status: 'approved' }).eq('id', step2.data.id).select();
    record('Admin UPDATE on approval_steps is rejected', !error && data.length === 0, error?.message);
  }
  {
    const { data, error } = await as.admin1.from('attendance_entries')
      .insert({ timesheet_id: ts1.id, date: '2026-01-05', status: 'present' }).select();
    record('Admin INSERT on attendance_entries is rejected', !!error, error?.message || 'no error, ' + data?.length + ' row(s) inserted');
  }
  // Positive control: admin CAN write profiles (the one table it owns)...
  {
    const { data, error } = await as.admin1.from('profiles')
      .update({ active: false }).eq('id', staff1.id).select();
    record('Admin UPDATE on profiles (another user) succeeds', !error && data.length === 1, error?.message);
    await admin.from('profiles').update({ active: true }).eq('id', staff1.id); // restore
  }
  // ...but cannot change their OWN role/active (self-promotion guard, via trigger).
  {
    const { data, error } = await as.admin1.from('profiles')
      .update({ role: 'hr' }).eq('id', admin1.id).select();
    record('Admin cannot change their OWN role (self-promotion trigger)', !!error, error?.message || 'no error, ' + data?.length + ' row(s) updated');
  }

  console.log('\n--- Cleanup ---\n');
  await admin.from('notifications').delete().eq('id', notif.id);
  await admin.from('approval_steps').delete().in('timesheet_id', [ts1.id, ts2.id, tsMed.id]);
  await admin.from('timesheets').delete().in('id', [ts1.id, ts2.id, tsMed.id]);
  await admin.from('organizational_assignments').delete().in('staff_id', [staff1.id, teamLead1.id, headOps1.id, headMedical1.id]);
  await admin.from('profiles').delete().in('id', allPersonas.map(p => p.id));
  for (const p of allPersonas) await admin.auth.admin.deleteUser(p.id);
  console.log('Test data and users deleted.');

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`);
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error('\nSCRIPT ERROR (test data may not be fully cleaned up):', e.message);
  process.exit(1);
});
