// Behavioral test for the merged admin_hr role (client feedback, demo
// 2026-09-18, Part 2). Creates real personas/timesheets, exercises the
// widened RLS policies and generate_approval_chain's HR-slot resolution,
// then deletes everything it created.
//
// This is ADDITIONAL coverage, not a replacement for re-running
// scripts/test-chain-generation.mjs and scripts/test-rls.mjs unmodified —
// those two prove the existing admin/hr behavior didn't regress; this one
// proves the new admin_hr behavior is correct.
//
// Run with: node scripts/test-admin-hr.mjs

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
  results.push({ label, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${label}${detail ? '  (' + detail + ')' : ''}`);
}

async function createPersona(key, full_name, role) {
  const email = `admin-hr-test-${key}-${Date.now()}@kalthum-dev.test`;
  const password = 'Test-' + Math.random().toString(36).slice(2) + 'Aa1!';
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${key}): ${error.message}`);
  const id = data.user.id;
  const { error: profErr } = await admin.from('profiles').insert({ id, full_name, email, location: 'Maiduguri', role });
  if (profErr) throw new Error(`profiles insert(${key}): ${profErr.message}`);
  return { key, id, email, password };
}
async function signInAs(persona) {
  const client = createClient(URL_, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: persona.email, password: persona.password });
  if (error) throw new Error(`signIn(${persona.key}): ${error.message}`);
  return client;
}
async function newTimesheet(staffId, department, month) {
  const { data, error } = await admin.from('timesheets').insert({
    staff_id: staffId, location: 'Maiduguri', department, month, year: 2026, status: 'draft',
  }).select().single();
  if (error) throw new Error('timesheet insert: ' + error.message);
  return data;
}
async function stepsFor(timesheetId, cycle) {
  const { data } = await admin.from('approval_steps').select('*').eq('timesheet_id', timesheetId).eq('cycle_number', cycle).order('step_order');
  return data;
}

const createdPersonaIds = [];
const createdTimesheetIds = [];
let deactivatedExistingHrIds = [];

async function main() {
  // This dev project has persistent ui-test-hr/ui-test-spm fixtures (and
  // possibly leftover personas from a crashed prior run) that would make
  // "admin_hr is the only active HR-equivalent" untrue by accident — and
  // this script also creates its OWN throwaway spm1 persona, which
  // generate_approval_chain requires to be the sole active SPM too. Found
  // 2026-09-18: a real SPM account can now coexist in this same dev
  // database, which would otherwise break every RPC call in this script
  // with "expected exactly one active SPM profile, found N". Temporarily
  // deactivate every OTHER currently-active spm/hr/admin_hr FIXTURE profile
  // for the duration of this script, and restore them in cleanup — never
  // delete them, they're not this script's to own. Scoped strictly to the
  // @kalthum-dev.test fixture domain — NEVER by role alone. A real profile
  // (e.g. a client's actual SPM/HR, on a real email domain) must never be
  // touched by this guard, even temporarily: if one coexists with a
  // fixture at the same role, this correctly leaves it alone and lets the
  // run fail with the genuine "found N" ambiguity error instead.
  const { data: existingHr } = await admin.from('profiles').select('id').in('role', ['spm', 'hr', 'admin_hr']).eq('active', true).like('email', '%@kalthum-dev.test');
  deactivatedExistingHrIds = (existingHr ?? []).map((p) => p.id);
  if (deactivatedExistingHrIds.length > 0) {
    console.log(`Temporarily deactivating ${deactivatedExistingHrIds.length} existing spm/hr/admin_hr profile(s) for this run...`);
    await admin.from('profiles').update({ active: false }).in('id', deactivatedExistingHrIds);
  }

  console.log('Creating personas...');
  const spm1 = await createPersona('spm1', 'Grace SPM', 'spm');
  const adminHr1 = await createPersona('adminhr1', 'Yakubu AdminHR', 'admin_hr');
  const staffOps = await createPersona('staffOps', 'Musa Ops', 'staff');
  const teamLeadOps = await createPersona('teamLeadOps', 'Ngozi TLOps', 'team_lead');
  const headOps = await createPersona('headOps', 'Chioma HeadOps', 'department_head');
  const outsider = await createPersona('outsider', 'Grace Outsider', 'staff');
  const allPersonas = [spm1, adminHr1, staffOps, teamLeadOps, headOps, outsider];
  createdPersonaIds.push(...allPersonas.map((p) => p.id));

  console.log('Creating organizational_assignments...');
  const { error: oaErr } = await admin.from('organizational_assignments').insert([
    { staff_id: staffOps.id, team_lead_id: teamLeadOps.id, department_head_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
  ]);
  if (oaErr) throw new Error('org_assignments: ' + oaErr.message);

  // --- A: admin_hr as the SOLE HR-equivalent (no plain 'hr' profile exists
  // at all in this dev project right now, other than any pre-existing
  // fixture — so this also doubles as a real-world check, not just a
  // synthetic one) ---
  {
    const tsOps = await newTimesheet(staffOps.id, 'operations', 6);
    createdTimesheetIds.push(tsOps.id);
    const { data: cycle, error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsOps.id });
    record('Chain generation succeeds with admin_hr as the only active HR-equivalent', !error, error?.message);
    if (!error) {
      const steps = await stepsFor(tsOps.id, cycle);
      const hrStep = steps.find((s) => s.approval_type === 'hr');
      record('HR slot resolves to the admin_hr account specifically', hrStep?.approver_id === adminHr1.id, hrStep?.approver_id);
    }
  }

  // --- B: hard-fail when BOTH a plain 'hr' and an 'admin_hr' are active at
  // once — genuinely ambiguous, must still be rejected, not silently
  // resolved to either one ---
  {
    const hrExtra = await createPersona('hrExtra', 'Second HR', 'hr');
    createdPersonaIds.push(hrExtra.id);
    const tsExtra = await newTimesheet(staffOps.id, 'operations', 7);
    createdTimesheetIds.push(tsExtra.id);
    const { error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsExtra.id });
    const msg = error?.message || '';
    record('Hard-fail: hr + admin_hr both active at once -> rejected, count=2',
      !!error && msg.includes('HR') && msg.includes('2'), msg);
    await admin.from('profiles').delete().eq('id', hrExtra.id);
    await admin.auth.admin.deleteUser(hrExtra.id);
    createdPersonaIds.splice(createdPersonaIds.indexOf(hrExtra.id), 1);
  }

  // --- C: admin_hr's OWN timesheet gets a real chain (not the "no chain
  // rule defined for role admin" dead-end plain admin hits) ---
  {
    const tsOwn = await newTimesheet(adminHr1.id, 'operations', 6);
    createdTimesheetIds.push(tsOwn.id);
    const { data: cycle, error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsOwn.id });
    record('admin_hr\'s own timesheet: chain generation succeeds (no dead-end)', !error, error?.message);
    if (!error) {
      const steps = await stepsFor(tsOwn.id, cycle);
      const spmStep = steps.find((s) => s.approval_type === 'spm');
      const hrStep = steps.find((s) => s.approval_type === 'hr');
      record('admin_hr\'s own timesheet: SPM row pending, HR row self-skipped', spmStep?.status === 'pending' && hrStep?.status === 'skipped',
        `spm=${spmStep?.status}, hr=${hrStep?.status}`);
      const { data: ts } = await admin.from('timesheets').select('status').eq('id', tsOwn.id).single();
      record('admin_hr\'s own timesheet: status = pending_final_review', ts.status === 'pending_final_review', ts.status);
    }
  }

  // --- D: Admin write-boundary granted to admin_hr — same enumerated
  // boundary as plain admin (profiles/organizational_assignments/
  // public_holidays only), not a blanket bypass ---
  const tsForRls = await newTimesheet(staffOps.id, 'operations', 8);
  createdTimesheetIds.push(tsForRls.id);
  const asAdminHr = await signInAs(adminHr1);
  {
    const { data, error } = await asAdminHr.from('profiles').update({ active: false }).eq('id', outsider.id).select();
    record('admin_hr UPDATE on profiles (another user) succeeds — admin capability granted', !error && data.length === 1, error?.message);
    await admin.from('profiles').update({ active: true }).eq('id', outsider.id);
  }
  {
    const { data, error } = await asAdminHr.from('timesheets').update({ location: 'Hacked' }).eq('id', tsForRls.id).select();
    record('admin_hr UPDATE on timesheets is rejected (not a blanket bypass)', !error && data.length === 0, error?.message);
  }
  {
    const { data, error } = await asAdminHr.from('attendance_entries')
      .insert({ timesheet_id: tsForRls.id, date: '2026-08-05', status: 'present' }).select();
    record('admin_hr INSERT on attendance_entries is rejected', !!error, error?.message || 'no error, ' + data?.length + ' row(s) inserted');
  }
  {
    const { data, error } = await asAdminHr.from('profiles').update({ role: 'admin' }).eq('id', adminHr1.id).select();
    record('admin_hr cannot change their OWN role (self-promotion trigger still applies)', !!error, error?.message || 'no error, ' + data?.length + ' row(s) updated');
  }

  // --- E: admin_hr inherits HR's broad timesheets read access ---
  {
    const { data, error } = await asAdminHr.from('timesheets').select('id').eq('id', tsForRls.id);
    record('admin_hr can READ an arbitrary staff timesheet (HR-equivalent broad visibility)', !error && data.length === 1, error?.message);
  }

  // --- F: self-approval rejection for admin_hr, same as any hr account ---
  {
    const tsSelf = await newTimesheet(adminHr1.id, 'operations', 9);
    createdTimesheetIds.push(tsSelf.id);
    const { data: badStep, error: badStepErr } = await admin.from('approval_steps').insert({
      timesheet_id: tsSelf.id, cycle_number: 1, step_order: 1, approval_type: 'hr', approver_id: adminHr1.id, status: 'pending',
    }).select().single();
    if (badStepErr) throw new Error('bad self-approval step: ' + badStepErr.message);

    const { data, error } = await asAdminHr.from('approval_steps').update({ status: 'approved' }).eq('id', badStep.id).select();
    record('Self-approval UPDATE by admin_hr is rejected by RLS', !error && data.length === 0, error?.message);

    const { error: rpcError } = await asAdminHr.rpc('approve_timesheet', { p_timesheet_id: tsSelf.id, p_comment: null });
    record('approve_timesheet RPC also rejects admin_hr approving their own timesheet', !!rpcError, rpcError?.message);
  }

  // --- H: positive control — admin_hr genuinely approving a real assigned
  // step (not just "rejected everywhere") ---
  {
    const { data: cycle } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsForRls.id });
    const steps = await stepsFor(tsForRls.id, cycle);
    // Resolve the chain down to the hr step: approve team_lead then
    // department_head as service role directly (bypassing RLS) so only the
    // hr step is left pending for admin_hr to act on.
    const tlStep = steps.find((s) => s.approval_type === 'team_lead');
    const dhStep = steps.find((s) => s.approval_type === 'department_head');
    await admin.from('approval_steps').update({ status: 'approved', acted_at: new Date().toISOString() }).eq('id', tlStep.id);
    await admin.from('approval_steps').update({ status: 'approved', acted_at: new Date().toISOString() }).eq('id', dhStep.id);
    await admin.from('timesheets').update({ status: 'pending_final_review' }).eq('id', tsForRls.id);

    const { error: rpcError } = await asAdminHr.rpc('approve_timesheet', { p_timesheet_id: tsForRls.id, p_comment: 'looks good' });
    record('admin_hr can approve their genuinely assigned HR step', !rpcError, rpcError?.message);
  }

  console.log('\n--- Cleanup ---\n');
  if (deactivatedExistingHrIds.length > 0) {
    await admin.from('profiles').update({ active: true }).in('id', deactivatedExistingHrIds);
    console.log(`Restored ${deactivatedExistingHrIds.length} existing spm/hr/admin_hr profile(s) to active.`);
  }
  await admin.from('notifications').delete().in('timesheet_id', createdTimesheetIds);
  await admin.from('timesheet_actions').delete().in('timesheet_id', createdTimesheetIds);
  await admin.from('approval_steps').delete().in('timesheet_id', createdTimesheetIds);
  await admin.from('timesheets').delete().in('id', createdTimesheetIds);
  await admin.from('organizational_assignments').delete().in('staff_id', createdPersonaIds);
  await admin.from('profiles').delete().in('id', createdPersonaIds);
  for (const id of createdPersonaIds) await admin.auth.admin.deleteUser(id);
  console.log('Deleted.');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.label}`);
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error('\nSCRIPT ERROR (test data may not be fully cleaned up, and any existing hr/admin_hr profiles this run deactivated may still be inactive — check profiles.active manually):', e.message);
  process.exit(1);
});
