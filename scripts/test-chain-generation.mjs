// One-off behavioral test for generate_approval_chain (Part 1).
// Creates real personas/timesheets, calls the function via RPC, asserts
// resulting rows/status, then deletes everything it created.

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
  const email = `chain-test-${key}-${Date.now()}@kalthum-dev.test`;
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

async function main() {
  console.log('Creating personas...');
  const spm1 = await createPersona('spm1', 'Grace SPM', 'spm');
  const hr1 = await createPersona('hr1', 'Ibrahim HR', 'hr');
  const staffMedical = await createPersona('staffMedical', 'Amina Medical', 'staff');
  const teamLeadMedical = await createPersona('teamLeadMedical', 'Tunde TLMedical', 'team_lead');
  const headMedical = await createPersona('headMedical', 'Bello HeadMedical', 'department_head');
  const staffOps = await createPersona('staffOps', 'Musa Ops', 'staff');
  const teamLeadOps = await createPersona('teamLeadOps', 'Ngozi TLOps', 'team_lead');
  const headOps = await createPersona('headOps', 'Chioma HeadOps', 'department_head');
  const teamLeadOwn = await createPersona('teamLeadOwn', 'Femi TLOwn', 'team_lead');
  const allPersonas = [spm1, hr1, staffMedical, teamLeadMedical, headMedical, staffOps, teamLeadOps, headOps, teamLeadOwn];
  createdPersonaIds.push(...allPersonas.map(p => p.id));

  console.log('Creating organizational_assignments...');
  const { error: oaErr } = await admin.from('organizational_assignments').insert([
    { staff_id: staffMedical.id, team_lead_id: teamLeadMedical.id, department_head_id: headMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: headMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: staffOps.id, team_lead_id: teamLeadOps.id, department_head_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadOwn.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
  ]);
  if (oaErr) throw new Error('org_assignments: ' + oaErr.message);

  console.log('Creating draft timesheets...');
  const tsMedical = await newTimesheet(staffMedical.id, 'medical', 1);
  const tsOps = await newTimesheet(staffOps.id, 'operations', 1);
  const tsTeamLeadOwn = await newTimesheet(teamLeadOwn.id, 'operations', 1);
  const tsSpmOwn = await newTimesheet(spm1.id, 'operations', 1);
  const tsHrOwn = await newTimesheet(hr1.id, 'operations', 1);
  createdTimesheetIds.push(tsMedical.id, tsOps.id, tsTeamLeadOwn.id, tsSpmOwn.id, tsHrOwn.id);

  console.log('\n--- Calling generate_approval_chain ---\n');

  // A: medical staff chain
  {
    const { data: cycle, error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsMedical.id });
    record('Medical staff: RPC succeeds, cycle=1', !error && cycle === 1, error?.message);
    const steps = await stepsFor(tsMedical.id, 1);
    const shape = steps.map(s => `${s.step_order}:${s.approval_type}:${s.status}`).join(',');
    record('Medical staff: chain = team_lead(1) -> department_head(2) -> hr(3), no spm row',
      shape === `1:team_lead:pending,2:department_head:pending,3:hr:pending`, shape);
    const { data: ts } = await admin.from('timesheets').select('status').eq('id', tsMedical.id).single();
    record('Medical staff: timesheet status = pending_team_lead', ts.status === 'pending_team_lead', ts.status);
    const { count } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('timesheet_id', tsMedical.id);
    record('Medical staff: exactly 1 notification (to team lead only)', count === 1, String(count));
  }

  // B: operations staff chain
  {
    const { data: cycle, error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsOps.id });
    record('Operations staff: RPC succeeds, cycle=1', !error && cycle === 1, error?.message);
    const steps = await stepsFor(tsOps.id, 1);
    const shape = steps.map(s => `${s.step_order}:${s.approval_type}:${s.status}`).sort().join(',');
    const expected = ['1:team_lead:pending', '2:department_head:pending', '3:spm:pending', '3:hr:pending'].sort().join(',');
    record('Operations staff: chain = team_lead(1) -> dept_head(2) -> spm+hr(3) parallel', shape === expected, shape);
    const { data: ts } = await admin.from('timesheets').select('status').eq('id', tsOps.id).single();
    record('Operations staff: timesheet status = pending_team_lead', ts.status === 'pending_team_lead', ts.status);
  }

  // C: team lead's own timesheet — direct to SPM+HR, no self-match
  {
    const { data: cycle, error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsTeamLeadOwn.id });
    record('Team Lead own timesheet: RPC succeeds, cycle=1', !error && cycle === 1, error?.message);
    const steps = await stepsFor(tsTeamLeadOwn.id, 1);
    const shape = steps.map(s => `${s.step_order}:${s.approval_type}:${s.status}`).sort().join(',');
    const expected = ['1:spm:pending', '1:hr:pending'].sort().join(',');
    record('Team Lead own timesheet: chain = spm+hr parallel at step_order=1, both pending (no self-match)', shape === expected, shape);
    const { data: ts } = await admin.from('timesheets').select('status').eq('id', tsTeamLeadOwn.id).single();
    record('Team Lead own timesheet: status = pending_final_review', ts.status === 'pending_final_review', ts.status);
  }

  // D: SPM's own timesheet — self-approval substitution, spm row skipped
  {
    const { data: cycle, error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsSpmOwn.id });
    record('SPM own timesheet: RPC succeeds, cycle=1', !error && cycle === 1, error?.message);
    const steps = await stepsFor(tsSpmOwn.id, 1);
    const spmStep = steps.find(s => s.approval_type === 'spm');
    const hrStep = steps.find(s => s.approval_type === 'hr');
    record('SPM own timesheet: SPM row = skipped, no acted_at', spmStep.status === 'skipped' && spmStep.acted_at === null,
      `${spmStep.status}, acted_at=${spmStep.acted_at}`);
    record('SPM own timesheet: HR row = pending', hrStep.status === 'pending', hrStep.status);
    const { count } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('timesheet_id', tsSpmOwn.id);
    record('SPM own timesheet: exactly 1 notification (HR only, SPM not notified)', count === 1, String(count));
  }

  // E: HR's own timesheet — symmetric
  {
    const { data: cycle, error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsHrOwn.id });
    record('HR own timesheet: RPC succeeds, cycle=1', !error && cycle === 1, error?.message);
    const steps = await stepsFor(tsHrOwn.id, 1);
    const spmStep = steps.find(s => s.approval_type === 'spm');
    const hrStep = steps.find(s => s.approval_type === 'hr');
    record('HR own timesheet: HR row = skipped, SPM row = pending', hrStep.status === 'skipped' && spmStep.status === 'pending',
      `hr=${hrStep.status}, spm=${spmStep.status}`);
  }

  // F: SECURITY — direct RPC call as an authenticated (non-service) user must be rejected
  {
    const client = await signInAs(staffMedical);
    const { data, error } = await client.rpc('generate_approval_chain', { p_timesheet_id: tsOps.id });
    record('Direct RPC call as authenticated user is rejected (function not exposed to clients)', !!error, error?.message || 'no error — data: ' + JSON.stringify(data));
  }

  // G: RESUBMISSION — call again on the same timesheet
  {
    const { data: cycle2, error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsOps.id });
    record('Resubmission: RPC succeeds, cycle=2', !error && cycle2 === 2, error?.message);
    const cycle1Steps = await stepsFor(tsOps.id, 1);
    record('Resubmission: cycle 1 rows untouched (still 4 rows, all pending as before)',
      cycle1Steps.length === 4 && cycle1Steps.every(s => s.status === 'pending'),
      JSON.stringify(cycle1Steps.map(s => s.status)));
    const cycle2Steps = await stepsFor(tsOps.id, 2);
    record('Resubmission: cycle 2 has a fresh 4-row chain', cycle2Steps.length === 4, String(cycle2Steps.length));
    const { data: actions } = await admin.from('timesheet_actions').select('action,cycle_number').eq('timesheet_id', tsOps.id).order('cycle_number');
    const actionShape = actions.map(a => `${a.cycle_number}:${a.action}`).join(',');
    record('Resubmission: timesheet_actions = 1:submitted, 2:resubmitted', actionShape === '1:submitted,2:resubmitted', actionShape);
  }

  // H: HARD-FAIL — ambiguous SPM (2 active)
  {
    const spm2 = await createPersona('spm2', 'Second SPM', 'spm');
    createdPersonaIds.push(spm2.id);
    const tsExtra = await newTimesheet(staffMedical.id, 'medical', 2);
    createdTimesheetIds.push(tsExtra.id);
    const { error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsExtra.id });
    const msg = error?.message || '';
    record('Hard-fail: 2 active SPM profiles -> rejected, message names SPM and count=2',
      !!error && msg.includes('SPM') && msg.includes('2'), msg);
    await admin.from('profiles').delete().eq('id', spm2.id);
    await admin.auth.admin.deleteUser(spm2.id);
    createdPersonaIds.splice(createdPersonaIds.indexOf(spm2.id), 1);
  }

  // I: HARD-FAIL — no active HR (0 active)
  {
    await admin.from('profiles').update({ active: false }).eq('id', hr1.id);
    const tsExtra2 = await newTimesheet(staffMedical.id, 'medical', 3);
    createdTimesheetIds.push(tsExtra2.id);
    const { error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsExtra2.id });
    const msg = error?.message || '';
    record('Hard-fail: 0 active HR profiles -> rejected, message names HR and count=0',
      !!error && msg.includes('HR') && msg.includes('0'), msg);
    await admin.from('profiles').update({ active: true }).eq('id', hr1.id);
  }

  // J: HARD-FAIL — staff with no current organizational_assignments row
  {
    const orphan = await createPersona('orphan', 'No Assignment', 'staff');
    createdPersonaIds.push(orphan.id);
    const tsOrphan = await newTimesheet(orphan.id, 'medical', 1);
    createdTimesheetIds.push(tsOrphan.id);
    const { error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsOrphan.id });
    const msg = error?.message || '';
    record('Hard-fail: staff with no organizational_assignments row -> rejected with THE SPECIFIC message',
      !!error && msg.includes('organizational_assignments row'), msg);
  }

  // K: HARD-FAIL — assignment row missing team_lead_id
  {
    const noTl = await createPersona('noTeamLead', 'Missing TL', 'staff');
    createdPersonaIds.push(noTl.id);
    await admin.from('organizational_assignments').insert({
      staff_id: noTl.id, team_lead_id: null, department_head_id: headMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id,
    });
    const tsNoTl = await newTimesheet(noTl.id, 'medical', 1);
    createdTimesheetIds.push(tsNoTl.id);
    const { error } = await admin.rpc('generate_approval_chain', { p_timesheet_id: tsNoTl.id });
    record('Hard-fail: assignment missing team_lead_id -> rejected', !!error, error?.message);
  }

  console.log('\n--- Cleanup ---\n');
  await admin.from('notifications').delete().in('timesheet_id', createdTimesheetIds);
  await admin.from('approval_steps').delete().in('timesheet_id', createdTimesheetIds);
  await admin.from('timesheet_actions').delete().in('timesheet_id', createdTimesheetIds);
  await admin.from('timesheets').delete().in('id', createdTimesheetIds);
  await admin.from('organizational_assignments').delete().in('staff_id', createdPersonaIds);
  await admin.from('profiles').delete().in('id', createdPersonaIds);
  for (const id of createdPersonaIds) await admin.auth.admin.deleteUser(id);
  console.log('Deleted.');

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error('\nSCRIPT ERROR (test data may not be fully cleaned up):', e.message);
  process.exit(1);
});
