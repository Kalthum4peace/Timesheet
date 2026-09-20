// One-off behavioral test for decline_timesheet (Part 4).
// Three distinct chain shapes, each testing something the others don't:
//   A. Medical full chain — decline at the top (HR), verify the backward
//      path is correctly derivable hop-by-hop (department_head, then
//      team_lead), even though Part 5 (acknowledge) isn't built yet.
//   B. Team Lead's own short chain — decline at step_order=1 (the lowest
//      that exists), verify the path is genuinely empty, straight to staff.
//   C. Operations full chain, SPM-approved-then-HR-declines at the SAME
//      step_order — verify SPM's row is untouched and SPM is correctly
//      excluded from the backward path (which goes to department_head,
//      not to SPM, despite SPM being "adjacent").

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
  const email = `decline-test-${key}-${Date.now()}@kalthum-dev.test`;
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
async function notificationsFor(timesheetId, type) {
  const { data } = await admin.from('notifications').select('*').eq('timesheet_id', timesheetId).eq('type', type);
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
  const teamLeadOwn = await createPersona('teamLeadOwn', 'Femi TLOwn', 'team_lead');
  const staffOps = await createPersona('staffOps', 'Musa Ops', 'staff');
  const teamLeadOps = await createPersona('teamLeadOps', 'Ngozi TLOps', 'team_lead');
  const headOps = await createPersona('headOps', 'Chioma HeadOps', 'department_head');
  const allPersonas = [spm1, hr1, staffMedical, teamLeadMedical, headMedical, teamLeadOwn, staffOps, teamLeadOps, headOps];
  createdPersonaIds.push(...allPersonas.map(p => p.id));

  console.log('Creating organizational_assignments...');
  await admin.from('organizational_assignments').insert([
    { staff_id: staffMedical.id, team_lead_id: teamLeadMedical.id, department_head_id: headMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: headMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: staffOps.id, team_lead_id: teamLeadOps.id, department_head_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
  ]);

  console.log('Signing in...');
  const as = {};
  for (const p of allPersonas) as[p.key] = await signInAs(p);

  console.log('\n--- A: Medical full chain, decline at HR (step_order=3) ---\n');
  {
    const ts = await newDraftTimesheet(staffMedical.id, 'medical', 1, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 1);
    await as.staffMedical.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    await as.teamLeadMedical.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.headMedical.rpc('approve_timesheet', { p_timesheet_id: ts.id });

    const r = await as.hr1.rpc('decline_timesheet', { p_timesheet_id: ts.id, p_comment: 'Missing days for week 2.' });
    record('HR decline succeeds with a comment', !r.error, r.error?.message);

    const { data: tsAfter } = await admin.from('timesheets').select('status').eq('id', ts.id).single();
    record('Timesheet status -> returning', tsAfter.status === 'returning', tsAfter.status);

    const hrStep = await stepFor(ts.id, hr1.id);
    record('HR step -> declined with comment recorded', hrStep.status === 'declined' && hrStep.comment === 'Missing days for week 2.', hrStep.status);

    const returnedNotifs = await notificationsFor(ts.id, 'returned');
    record('Exactly 1 "returned" notification, recipient = department_head (first backward hop)',
      returnedNotifs.length === 1 && returnedNotifs[0].recipient_id === headMedical.id,
      JSON.stringify(returnedNotifs.map(n => n.recipient_id)));

    // Simulate what Part 5 will do: from department_head's own step_order,
    // find the NEXT hop back. Uses the admin/service client since
    // next_return_recipient is intentionally not exposed to authenticated.
    const { data: cycleRows } = await admin.from('approval_steps').select('cycle_number,step_order').eq('timesheet_id', ts.id).eq('approver_id', headMedical.id).single();
    const { data: secondHop, error: hopErr } = await admin.rpc('next_return_recipient', {
      p_timesheet_id: ts.id, p_cycle: cycleRows.cycle_number, p_from_step_order: cycleRows.step_order,
    });
    record('Second hop back from department_head correctly resolves to team_lead', !hopErr && secondHop === teamLeadMedical.id, hopErr?.message || secondHop);

    const { data: thirdHop } = await admin.rpc('next_return_recipient', {
      p_timesheet_id: ts.id, p_cycle: cycleRows.cycle_number, p_from_step_order: 1, // team_lead's own step_order
    });
    record('Third hop back from team_lead correctly resolves to NULL (reaches staff)', thirdHop === null, String(thirdHop));
  }

  console.log('\n--- B: Team Lead own timesheet, decline at step_order=1 (the lowest) ---\n');
  {
    const ts = await newDraftTimesheet(teamLeadOwn.id, 'operations', 1, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 1);
    await as.teamLeadOwn.rpc('submit_timesheet', { p_timesheet_id: ts.id });

    const r = await as.spm1.rpc('decline_timesheet', { p_timesheet_id: ts.id, p_comment: 'Please clarify entry for the 10th.' });
    record('SPM decline succeeds (no prior approval needed for this test)', !r.error, r.error?.message);

    // Since migration 20260919030000 the empty-path case notifies staff with the
    // richer 'declined' notification (who/stage/comment, "already back with you")
    // INSTEAD of the old generic 'returned' one, so staff never get two emails.
    const declinedNotifs = await notificationsFor(ts.id, 'declined');
    record('Exactly 1 "declined" notification, recipient = staff DIRECTLY (empty path, no intermediate)',
      declinedNotifs.length === 1 && declinedNotifs[0].recipient_id === teamLeadOwn.id,
      JSON.stringify(declinedNotifs.map(n => n.recipient_id)));
    const returnedNotifs = await notificationsFor(ts.id, 'returned');
    record('...and NO "returned" notification exists for it (no double-up)', returnedNotifs.length === 0, String(returnedNotifs.length));

    const { data: cycleRows } = await admin.from('approval_steps').select('cycle_number').eq('timesheet_id', ts.id).limit(1).single();
    const { data: hop } = await admin.rpc('next_return_recipient', { p_timesheet_id: ts.id, p_cycle: cycleRows.cycle_number, p_from_step_order: 1 });
    record('next_return_recipient from step_order=1 directly confirms NULL (nothing lower exists)', hop === null, String(hop));
  }

  console.log('\n--- C: Operations full chain, SPM approves then HR declines (same step_order) ---\n');
  {
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 1, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 1);
    await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    await as.teamLeadOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.headOps.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    const approveResult = await as.spm1.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    record('SPM approves their step at the parallel layer', !approveResult.error && approveResult.data === 'pending_final_review', approveResult.error?.message || approveResult.data);

    const declineResult = await as.hr1.rpc('decline_timesheet', { p_timesheet_id: ts.id, p_comment: 'Discrepancy with attendance records.' });
    record('HR declines their own step (SPM already approved theirs)', !declineResult.error, declineResult.error?.message);

    const spmStep = await stepFor(ts.id, spm1.id);
    record('SPM row remains approved, UNTOUCHED by HR\'s decline', spmStep.status === 'approved' && spmStep.acted_at !== null, spmStep.status);

    const hrStep = await stepFor(ts.id, hr1.id);
    record('HR row -> declined', hrStep.status === 'declined', hrStep.status);

    const returnedNotifs = await notificationsFor(ts.id, 'returned');
    record('Exactly 1 "returned" notification, recipient = department_head (NOT SPM, despite same step_order)',
      returnedNotifs.length === 1 && returnedNotifs[0].recipient_id === headOps.id,
      JSON.stringify(returnedNotifs.map(n => n.recipient_id)));
    record('SPM is NOT among the notification recipients', !returnedNotifs.some(n => n.recipient_id === spm1.id), 'checked');
  }

  console.log('\n--- D: redundant checks ---\n');
  {
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 2, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 2);
    await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    const r = await as.teamLeadOps.rpc('decline_timesheet', { p_timesheet_id: ts.id, p_comment: '' });
    record('Empty comment rejected', !!r.error && r.error.message.includes('comment is required'), r.error?.message);
    const r2 = await as.teamLeadOps.rpc('decline_timesheet', { p_timesheet_id: ts.id, p_comment: null });
    record('Null comment rejected', !!r2.error && r2.error.message.includes('comment is required'), r2.error?.message);
  }
  {
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 3, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 3);
    await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    const r = await as.headOps.rpc('decline_timesheet', { p_timesheet_id: ts.id, p_comment: 'skipping ahead' });
    record('Redundant step-ordering check rejects decline out of order', !!r.error && r.error.message.includes('earlier step'), r.error?.message);
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
