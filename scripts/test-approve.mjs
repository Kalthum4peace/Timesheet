// One-off behavioral test for approve_timesheet (Part 3), including a
// genuinely concurrent SPM+HR race via Promise.all (not sequential awaits).

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
  const email = `approve-test-${key}-${Date.now()}@kalthum-dev.test`;
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
function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
async function newDraftTimesheet(staffId, department, month, year) {
  const { data, error } = await admin.from('timesheets').insert({ staff_id: staffId, location: 'Maiduguri', department, month, year, status: 'draft' }).select().single();
  if (error) throw new Error('timesheet insert: ' + error.message);
  return data;
}
async function fillAllDays(timesheetId, year, month) {
  const n = daysInMonth(year, month);
  const rows = [];
  for (let d = 1; d <= n; d++) rows.push({ timesheet_id: timesheetId, date: `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`, status: 'present' });
  const { error } = await admin.from('attendance_entries').insert(rows);
  if (error) throw new Error('fillAllDays: ' + error.message);
}
async function stepFor(timesheetId, approverId) {
  const { data } = await admin.from('approval_steps').select('*').eq('timesheet_id', timesheetId).eq('approver_id', approverId).order('cycle_number', { ascending: false }).limit(1).single();
  return data;
}

const createdPersonaIds = [];
const createdTimesheetIds = [];

async function main() {
  console.log('Creating personas...');
  const spm1 = await createPersona('spm1', 'Grace SPM', 'spm');
  const hr1 = await createPersona('hr1', 'Ibrahim HR', 'hr');
  const staffOps = await createPersona('staffOps', 'Musa Ops', 'staff');
  const teamLeadOps = await createPersona('teamLeadOps', 'Ngozi TLOps', 'team_lead');
  const headOps = await createPersona('headOps', 'Chioma HeadOps', 'department_head');
  const staffMedical = await createPersona('staffMedical', 'Amina Medical', 'staff');
  const teamLeadMedical = await createPersona('teamLeadMedical', 'Tunde TLMedical', 'team_lead');
  const headMedical = await createPersona('headMedical', 'Bello HeadMedical', 'department_head');
  const allPersonas = [spm1, hr1, staffOps, teamLeadOps, headOps, staffMedical, teamLeadMedical, headMedical];
  createdPersonaIds.push(...allPersonas.map(p => p.id));

  console.log('Creating organizational_assignments...');
  await admin.from('organizational_assignments').insert([
    { staff_id: staffOps.id, team_lead_id: teamLeadOps.id, department_head_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: staffMedical.id, team_lead_id: teamLeadMedical.id, department_head_id: headMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: headMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
  ]);

  console.log('Signing in...');
  const as = {};
  for (const p of allPersonas) as[p.key] = await signInAs(p);

  console.log('\n--- A: Full sequential Operations chain, ending in a genuine race ---\n');
  {
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 1, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 1);
    await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });

    const r1 = await as.teamLeadOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('Team Lead approves -> pending_department_head', !r1.error && r1.data === 'pending_department_head', r1.error?.message || r1.data);

    const r2 = await as.headOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('Head of Ops approves -> pending_final_review', !r2.error && r2.data === 'pending_final_review', r2.error?.message || r2.data);

    // GENUINE CONCURRENCY: fire both without awaiting one before the other.
    const [rSpm, rHr] = await Promise.all([
      as.spm1.rpc('approve_timesheet', { p_timesheet_id: ts.id }),
      as.hr1.rpc('approve_timesheet', { p_timesheet_id: ts.id }),
    ]);
    record('Concurrent SPM approve succeeds (no error)', !rSpm.error, rSpm.error?.message);
    record('Concurrent HR approve succeeds (no error)', !rHr.error, rHr.error?.message);

    const spmStep = await stepFor(ts.id, spm1.id);
    const hrStep = await stepFor(ts.id, hr1.id);
    record('Both approval_steps rows end up approved (not double-processed)', spmStep.status === 'approved' && hrStep.status === 'approved',
      `spm=${spmStep.status}, hr=${hrStep.status}`);

    const { data: tsAfter } = await admin.from('timesheets').select('status,approved_at').eq('id', ts.id).single();
    record('Timesheet ends up approved exactly once (not stuck)', tsAfter.status === 'approved' && tsAfter.approved_at !== null,
      `status=${tsAfter.status}, approved_at=${tsAfter.approved_at}`);

    const { count } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('timesheet_id', ts.id).eq('type', 'final_approval');
    record('Exactly one final_approval notification (not duplicated by the race)', count === 1, String(count));
  }

  console.log('\n--- B: Medical chain, HR-only final step (no SPM row at all) ---\n');
  {
    const ts = await newDraftTimesheet(staffMedical.id, 'medical', 1, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 1);
    await as.staffMedical.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    await as.teamLeadMedical.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    const r2 = await as.headMedical.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('Head of Medical approves -> pending_final_review', !r2.error && r2.data === 'pending_final_review', r2.error?.message || r2.data);

    const r3 = await as.hr1.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('HR approves the ONLY row at this step_order -> approved directly', !r3.error && r3.data === 'approved', r3.error?.message || r3.data);
  }

  console.log('\n--- C: SPM own timesheet, self-skip means HR alone completes the layer ---\n');
  {
    const ts = await newDraftTimesheet(spm1.id, 'operations', 1, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 1);
    const sub = await as.spm1.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    record('SPM submits own timesheet successfully', !sub.error, sub.error?.message);
    const r = await as.hr1.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('HR approves (SPM row pre-skipped) -> approved directly', !r.error && r.data === 'approved', r.error?.message || r.data);
  }

  console.log('\n--- D: redundant checks ---\n');
  {
    // Self-approval: deliberately malformed row.
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 2, 2026);
    createdTimesheetIds.push(ts.id);
    await admin.from('approval_steps').insert({ timesheet_id: ts.id, cycle_number: 1, step_order: 1, approval_type: 'team_lead', approver_id: staffOps.id, status: 'pending' });
    const r = await as.staffOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('Redundant self-approval check rejects (function-level, independent of RLS)', !!r.error && r.error.message.includes('cannot approve their own'), r.error?.message);
  }
  {
    // Step-ordering: approve step 2 while step 1 pending.
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 3, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 3);
    await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    // headOps has step_order=2; team_lead (step_order=1) hasn't acted yet.
    const r = await as.headOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('Redundant step-ordering check rejects (function-level)', !!r.error && r.error.message.includes('earlier step'), r.error?.message);
    // Cleanup this one now since it's a distinct sub-scenario not reused below.
  }
  {
    // Already acted on: approve twice.
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 4, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 4);
    await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    const first = await as.teamLeadOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('First approval on this step succeeds', !first.error, first.error?.message);
    const second = await as.teamLeadOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('Second approval on the SAME step is rejected with "already ... approved"', !!second.error && second.error.message.includes('already') && second.error.message.includes('approved'), second.error?.message);
  }

  console.log('\n--- Cleanup ---\n');
  await admin.from('notifications').delete().in('timesheet_id', createdTimesheetIds);
  await admin.from('approval_steps').delete().in('timesheet_id', createdTimesheetIds);
  await admin.from('timesheet_actions').delete().in('timesheet_id', createdTimesheetIds);
  await admin.from('attendance_entries').delete().in('timesheet_id', createdTimesheetIds);
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
