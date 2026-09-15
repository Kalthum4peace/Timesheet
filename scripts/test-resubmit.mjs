// Behavioral tests for resubmit_timesheet (Part 6), plus the first full
// six-part end-to-end round trip.

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
  const email = `resubmit-test-${key}-${Date.now()}@kalthum-dev.test`;
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
  const teamLeadA = await createPersona('teamLeadA', 'Tunde TLA', 'team_lead');
  const teamLeadB = await createPersona('teamLeadB', 'Kemi TLB', 'team_lead');
  const headMedical = await createPersona('headMedical', 'Bello HeadMedical', 'department_head');
  const staffOps = await createPersona('staffOps', 'Musa Ops', 'staff');
  const teamLeadOps = await createPersona('teamLeadOps', 'Ngozi TLOps', 'team_lead');
  const headOps = await createPersona('headOps', 'Chioma HeadOps', 'department_head');
  const allPersonas = [spm1, hr1, staffMedical, teamLeadA, teamLeadB, headMedical, staffOps, teamLeadOps, headOps];
  createdPersonaIds.push(...allPersonas.map(p => p.id));

  console.log('Creating organizational_assignments...');
  await admin.from('organizational_assignments').insert([
    { staff_id: staffMedical.id, team_lead_id: teamLeadA.id, department_head_id: headMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadA.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadB.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: headMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: staffOps.id, team_lead_id: teamLeadOps.id, department_head_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
  ]);

  console.log('Signing in...');
  const as = {};
  for (const p of allPersonas) as[p.key] = await signInAs(p);

  console.log('\n--- A: Early resubmit rejected mid-acknowledgment ---\n');
  {
    const ts = await newDraftTimesheet(staffMedical.id, 'medical', 1, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 1);
    await as.staffMedical.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    await as.teamLeadA.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.headMedical.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.hr1.rpc('decline_timesheet', { p_timesheet_id: ts.id, p_comment: 'Needs review.' });

    const tooEarly1 = await as.staffMedical.rpc('resubmit_timesheet', { p_timesheet_id: ts.id });
    record('Resubmit rejected before ANY acknowledgment (department_head still owes one)',
      !!tooEarly1.error && tooEarly1.error.message.includes('still needs to acknowledge'), tooEarly1.error?.message);

    await as.headMedical.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });

    const tooEarly2 = await as.staffMedical.rpc('resubmit_timesheet', { p_timesheet_id: ts.id });
    record('Resubmit STILL rejected after only 1 of 2 acknowledgments (team_lead still owes one)',
      !!tooEarly2.error && tooEarly2.error.message.includes('still needs to acknowledge'), tooEarly2.error?.message);

    await as.teamLeadA.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });

    const nowOk = await as.staffMedical.rpc('resubmit_timesheet', { p_timesheet_id: ts.id });
    record('Resubmit succeeds once the path has genuinely reached staff', !nowOk.error && nowOk.data === 2, nowOk.error?.message || nowOk.data);
  }

  console.log('\n--- B: THE critical test — org assignment changes between decline and resubmit ---\n');
  {
    const ts = await newDraftTimesheet(staffMedical.id, 'medical', 2, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 2);
    await as.staffMedical.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    await as.teamLeadA.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.headMedical.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.hr1.rpc('decline_timesheet', { p_timesheet_id: ts.id, p_comment: 'Needs review.' });
    await as.headMedical.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });
    await as.teamLeadA.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });

    const cycle1Before = await stepsFor(ts.id, 1);

    // Reassign staffMedical's team lead from A to B — via the proper
    // close-out-then-insert pattern the Part 0 trigger enforces.
    const { data: activeRow } = await admin.from('organizational_assignments')
      .select('id').eq('staff_id', staffMedical.id).is('effective_to', null).single();
    const closeResult = await admin.from('organizational_assignments')
      .update({ effective_to: '2026-01-31' }).eq('id', activeRow.id).select();
    record('Close out old assignment succeeds (exercising Part 0 trigger for real)', !closeResult.error && closeResult.data.length === 1, closeResult.error?.message);
    const insertResult = await admin.from('organizational_assignments').insert({
      staff_id: staffMedical.id, team_lead_id: teamLeadB.id, department_head_id: headMedical.id,
      department: 'medical', effective_from: '2026-02-01', created_by: spm1.id,
    });
    record('Insert new assignment (new team lead) succeeds', !insertResult.error, insertResult.error?.message);

    // Edit: touch one attendance entry (represents staff correcting something).
    await admin.from('attendance_entries').update({ status: 'leave' }).eq('timesheet_id', ts.id).eq('date', '2026-02-10');

    const resubmitResult = await as.staffMedical.rpc('resubmit_timesheet', { p_timesheet_id: ts.id });
    record('Resubmit succeeds after org change', !resubmitResult.error && resubmitResult.data === 2, resubmitResult.error?.message);

    const cycle2 = await stepsFor(ts.id, 2);
    const cycle2TeamLead = cycle2.find(s => s.approval_type === 'team_lead');
    record('Cycle 2 team_lead step reflects the NEW team lead (B, not A)', cycle2TeamLead?.approver_id === teamLeadB.id, cycle2TeamLead?.approver_id);

    const cycle1After = await stepsFor(ts.id, 1);
    record('Cycle 1 rows completely unchanged after resubmit (still team lead A, still approved, same acted_at)',
      JSON.stringify(cycle1Before) === JSON.stringify(cycle1After), 'compared full row snapshots');

    const { data: actions } = await admin.from('timesheet_actions').select('action,cycle_number').eq('timesheet_id', ts.id).order('cycle_number');
    const resubmittedAction = actions.find(a => a.cycle_number === 2);
    record('New cycle\'s timesheet_actions row is action=resubmitted, not submitted', resubmittedAction?.action === 'resubmitted', resubmittedAction?.action);
  }

  console.log('\n--- C: missing-days check queries CURRENT data, not cycle-1-cached ---\n');
  {
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 1, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 1);
    await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    await as.teamLeadOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.headOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.spm1.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.hr1.rpc('decline_timesheet', { p_timesheet_id: ts.id, p_comment: 'Fix this.' });
    await as.headOps.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });
    await as.teamLeadOps.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });

    // Remove one day's entry — simulating a gap.
    await admin.from('attendance_entries').delete().eq('timesheet_id', ts.id).eq('date', '2026-01-15');

    const rejected = await as.staffOps.rpc('resubmit_timesheet', { p_timesheet_id: ts.id });
    record('Resubmit rejected when a day is now missing (fresh check, not cycle-1 cached)',
      !!rejected.error && rejected.error.message.includes('missing 1 day'), rejected.error?.message);

    await admin.from('attendance_entries').insert({ timesheet_id: ts.id, date: '2026-01-15', status: 'present' });
    const nowOk = await as.staffOps.rpc('resubmit_timesheet', { p_timesheet_id: ts.id });
    record('Resubmit succeeds once the day is filled back in', !nowOk.error && nowOk.data === 2, nowOk.error?.message);
  }

  console.log('\n--- D: ownership and status checks ---\n');
  {
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 2, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 2);
    const r1 = await as.teamLeadOps.rpc('resubmit_timesheet', { p_timesheet_id: ts.id }); // still draft, wrong status AND wrong owner
    record('Resubmit on a draft timesheet (wrong status) rejected', !!r1.error, r1.error?.message);

    await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id }); // now pending_team_lead
    const r2 = await as.staffOps.rpc('resubmit_timesheet', { p_timesheet_id: ts.id });
    record('Resubmit on a pending (not returning) timesheet rejected', !!r2.error && r2.error.message.includes('not in returning status'), r2.error?.message);
  }

  console.log('\n--- E: FULL END-TO-END ROUND TRIP (all 6 parts in sequence) ---\n');
  {
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 3, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 3);

    const sub = await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    record('E2E: submit succeeds (cycle 1)', !sub.error && sub.data === 1, sub.error?.message);

    await as.teamLeadOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.headOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.spm1.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    const dec = await as.hr1.rpc('decline_timesheet', { p_timesheet_id: ts.id, p_comment: 'One more check needed.' });
    record('E2E: HR declines at the final layer', !dec.error, dec.error?.message);

    const ack1 = await as.headOps.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });
    record('E2E: department_head acknowledges (hop 1)', !ack1.error, ack1.error?.message);
    const ack2 = await as.teamLeadOps.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });
    record('E2E: team_lead acknowledges (hop 2, last intermediate)', !ack2.error, ack2.error?.message);

    // Edit.
    await admin.from('attendance_entries').update({ status: 'leave' }).eq('timesheet_id', ts.id).eq('date', '2026-03-05');

    const resub = await as.staffOps.rpc('resubmit_timesheet', { p_timesheet_id: ts.id });
    record('E2E: resubmit succeeds (cycle 2)', !resub.error && resub.data === 2, resub.error?.message);

    const a1 = await as.teamLeadOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('E2E cycle 2: team_lead approves', !a1.error && a1.data === 'pending_department_head', a1.error?.message || a1.data);
    const a2 = await as.headOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('E2E cycle 2: department_head approves', !a2.error && a2.data === 'pending_final_review', a2.error?.message || a2.data);
    const a3 = await as.spm1.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('E2E cycle 2: SPM approves', !a3.error && a3.data === 'pending_final_review', a3.error?.message || a3.data);
    const a4 = await as.hr1.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('E2E cycle 2: HR approves -> fully approved', !a4.error && a4.data === 'approved', a4.error?.message || a4.data);

    const { data: tsFinal } = await admin.from('timesheets').select('status,approved_at').eq('id', ts.id).single();
    record('E2E: final timesheet status = approved, approved_at set', tsFinal.status === 'approved' && tsFinal.approved_at !== null, tsFinal.status);

    const cycle1Steps = await stepsFor(ts.id, 1);
    record('E2E: cycle 1 approval_steps preserved (full history of the declined attempt)', cycle1Steps.length === 4, cycle1Steps.length);
    const { data: allActions } = await admin.from('timesheet_actions').select('action,cycle_number').eq('timesheet_id', ts.id).order('created_at');
    const actionSeq = allActions.map(a => `${a.cycle_number}:${a.action}`).join(',');
    // Every individual approve_timesheet call logs its own 'approved' row
    // (Part 3's own design) — 3 approvals precede the cycle-1 decline
    // (team_lead, department_head, SPM all approved before HR declined),
    // then 2 acknowledgments, then 4 approvals close out cycle 2.
    const expected = '1:submitted,1:approved,1:approved,1:approved,1:declined,1:return_acknowledged,1:return_acknowledged,2:resubmitted,2:approved,2:approved,2:approved,2:approved';
    record('E2E: full audit trail in order, every action individually logged', actionSeq === expected, actionSeq);
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
