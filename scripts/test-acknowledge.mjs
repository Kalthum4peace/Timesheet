// One-off behavioral test for acknowledge_return_timesheet (Part 5).

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
  const email = `ack-test-${key}-${Date.now()}@kalthum-dev.test`;
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
async function actionsFor(timesheetId) {
  const { data } = await admin.from('timesheet_actions').select('*').eq('timesheet_id', timesheetId).order('created_at');
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
  const allPersonas = [spm1, hr1, staffMedical, teamLeadMedical, headMedical, teamLeadOwn];
  createdPersonaIds.push(...allPersonas.map(p => p.id));

  console.log('Creating organizational_assignments...');
  await admin.from('organizational_assignments').insert([
    { staff_id: staffMedical.id, team_lead_id: teamLeadMedical.id, department_head_id: headMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: headMedical.id, department: 'medical', effective_from: '2026-01-01', created_by: spm1.id },
  ]);

  console.log('Signing in...');
  const as = {};
  for (const p of allPersonas) as[p.key] = await signInAs(p);

  console.log('\n--- A: Full Medical chain, 2 real acknowledgment hops ---\n');
  let ts;
  {
    ts = await newDraftTimesheet(staffMedical.id, 'medical', 1, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 1);
    await as.staffMedical.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    await as.teamLeadMedical.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.headMedical.rpc('approve_timesheet', { p_timesheet_id: ts.id });
    await as.hr1.rpc('decline_timesheet', { p_timesheet_id: ts.id, p_comment: 'Discrepancy in week 3.' });

    // OUT OF TURN: team_lead tries to acknowledge before department_head has.
    const outOfTurn = await as.teamLeadMedical.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });
    record('Out-of-turn acknowledgment (team_lead before department_head) rejected',
      !!outOfTurn.error && outOfTurn.error.message.includes('not the current expected recipient'), outOfTurn.error?.message);

    // Hop 1: department_head acknowledges (correct turn).
    const hop1 = await as.headMedical.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });
    record('Hop 1: department_head acknowledges successfully', !hop1.error, hop1.error?.message);

    // DOUBLE ACK: department_head tries again.
    const doubleAck = await as.headMedical.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });
    record('Double-acknowledgment by department_head (again) rejected',
      !!doubleAck.error && doubleAck.error.message.includes('not the current expected recipient'), doubleAck.error?.message);

    const returnedAfterHop1 = await notificationsFor(ts.id, 'returned');
    // decline's own notification (to dept head) + hop1's new notification (to team_lead) = 2 so far
    record('After hop 1, team_lead is now among the "returned" notification recipients',
      returnedAfterHop1.some(n => n.recipient_id === teamLeadMedical.id), JSON.stringify(returnedAfterHop1.map(n => n.recipient_id)));

    // Hop 2: team_lead acknowledges (correct turn now) — this is the LAST intermediate, should notify staff.
    const hop2 = await as.teamLeadMedical.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });
    record('Hop 2: team_lead acknowledges successfully (last intermediate)', !hop2.error, hop2.error?.message);

    const returnedAfterHop2 = await notificationsFor(ts.id, 'returned');
    record('After hop 2, staff is now among the "returned" notification recipients',
      returnedAfterHop2.some(n => n.recipient_id === staffMedical.id), JSON.stringify(returnedAfterHop2.map(n => n.recipient_id)));

    // Nothing left — calling acknowledge again (by anyone) must be rejected.
    const afterEnd = await as.spm1.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts.id });
    record('Acknowledging after the path is fully exhausted is rejected ("nothing left")',
      !!afterEnd.error && afterEnd.error.message.includes('nothing left to acknowledge'), afterEnd.error?.message);

    const actions = await actionsFor(ts.id);
    const ackActions = actions.filter(a => a.action === 'return_acknowledged');
    record('Exactly 2 return_acknowledged actions recorded (department_head, team_lead)',
      ackActions.length === 2 && ackActions.map(a => a.actor_id).sort().join(',') === [headMedical.id, teamLeadMedical.id].sort().join(','),
      JSON.stringify(ackActions.map(a => a.actor_id)));
    record('NO return_acknowledged action exists for staff', !ackActions.some(a => a.actor_id === staffMedical.id), 'checked');

    const stepsUntouched = await admin.from('approval_steps').select('status').eq('timesheet_id', ts.id);
    const statuses = stepsUntouched.data.map(s => s.status).sort();
    record('approval_steps statuses unchanged by acknowledgment (still approved/approved/declined)',
      JSON.stringify(statuses) === JSON.stringify(['approved', 'approved', 'declined']), JSON.stringify(statuses));

    const { data: tsFinal } = await admin.from('timesheets').select('status').eq('id', ts.id).single();
    record('Timesheet status still "returning" throughout (acknowledgment never changes it)', tsFinal.status === 'returning', tsFinal.status);
  }

  console.log('\n--- B: 0-intermediate chain — nobody has standing to acknowledge at all ---\n');
  {
    const ts2 = await newDraftTimesheet(teamLeadOwn.id, 'operations', 1, 2026);
    createdTimesheetIds.push(ts2.id);
    await fillAllDays(ts2.id, 2026, 1);
    await as.teamLeadOwn.rpc('submit_timesheet', { p_timesheet_id: ts2.id });
    await as.spm1.rpc('decline_timesheet', { p_timesheet_id: ts2.id, p_comment: 'Please clarify.' });

    const attempt = await as.hr1.rpc('acknowledge_return_timesheet', { p_timesheet_id: ts2.id });
    record('Acknowledge attempt on a 0-intermediate chain is rejected ("nothing left")',
      !!attempt.error && attempt.error.message.includes('nothing left to acknowledge'), attempt.error?.message);

    const actions2 = await actionsFor(ts2.id);
    record('No return_acknowledged action exists for this timesheet at all', !actions2.some(a => a.action === 'return_acknowledged'), 'checked');
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
