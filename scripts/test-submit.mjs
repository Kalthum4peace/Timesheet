// One-off behavioral test for submit_timesheet (Part 2).

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
  const email = `submit-test-${key}-${Date.now()}@kalthum-dev.test`;
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
async function newDraftTimesheet(staffId, department, month, year) {
  const { data, error } = await admin.from('timesheets').insert({
    staff_id: staffId, location: 'Maiduguri', department, month, year, status: 'draft',
  }).select().single();
  if (error) throw new Error('timesheet insert: ' + error.message);
  return data;
}
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
async function fillAllDays(timesheetId, year, month) {
  const n = daysInMonth(year, month);
  const rows = [];
  for (let d = 1; d <= n; d++) {
    rows.push({ timesheet_id: timesheetId, date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`, status: 'present' });
  }
  const { error } = await admin.from('attendance_entries').insert(rows);
  if (error) throw new Error('fillAllDays: ' + error.message);
}
async function fillPartialDays(timesheetId, year, month, count) {
  const rows = [];
  for (let d = 1; d <= count; d++) {
    rows.push({ timesheet_id: timesheetId, date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`, status: 'present' });
  }
  const { error } = await admin.from('attendance_entries').insert(rows);
  if (error) throw new Error('fillPartialDays: ' + error.message);
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
  const teamLeadOwn = await createPersona('teamLeadOwn', 'Femi TLOwn', 'team_lead');
  const intruder = await createPersona('intruder', 'Not Owner', 'staff');
  const allPersonas = [spm1, hr1, staffOps, teamLeadOps, headOps, teamLeadOwn, intruder];
  createdPersonaIds.push(...allPersonas.map(p => p.id));

  console.log('Creating organizational_assignments...');
  const { error: oaErr } = await admin.from('organizational_assignments').insert([
    { staff_id: staffOps.id, team_lead_id: teamLeadOps.id, department_head_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: teamLeadOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
    { staff_id: intruder.id, team_lead_id: teamLeadOps.id, department_head_id: headOps.id, department: 'operations', effective_from: '2026-01-01', created_by: spm1.id },
  ]);
  if (oaErr) throw new Error('org_assignments: ' + oaErr.message);

  console.log('Signing in as each persona...');
  const as = {};
  for (const p of allPersonas) as[p.key] = await signInAs(p);

  console.log('\n--- Test 1: full submission (all days filled) ---\n');
  {
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 1, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 1);
    const { data: cycle, error } = await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    record('Full submission succeeds, returns cycle=1', !error && cycle === 1, error?.message);
    const { data: tsAfter } = await admin.from('timesheets').select('status').eq('id', ts.id).single();
    record('Status becomes pending_team_lead', tsAfter.status === 'pending_team_lead', tsAfter.status);
    const { count } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('timesheet_id', ts.id);
    record('Exactly 1 notification (team lead)', count === 1, String(count));
  }

  console.log('\n--- Test 2: missing days rejected ---\n');
  {
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 2, 2026);
    createdTimesheetIds.push(ts.id);
    await fillPartialDays(ts.id, 2026, 2, 20); // Feb 2026 has 28 days, only fill 20
    const { data, error } = await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    const msg = error?.message || '';
    record('Missing-days submission rejected with specific count', !!error && msg.includes('8 day'), msg);
    const { data: tsAfter } = await admin.from('timesheets').select('status').eq('id', ts.id).single();
    record('Status remains draft (no partial chain created)', tsAfter.status === 'draft', tsAfter.status);
  }

  console.log('\n--- Test 3: Team Lead own timesheet -> straight to pending_final_review ---\n');
  {
    const ts = await newDraftTimesheet(teamLeadOwn.id, 'operations', 1, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 1);
    const { data: cycle, error } = await as.teamLeadOwn.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    record('Team Lead own submission succeeds', !error && cycle === 1, error?.message);
    const { data: tsAfter } = await admin.from('timesheets').select('status').eq('id', ts.id).single();
    record('Status = pending_final_review (skips team_lead/department_head)', tsAfter.status === 'pending_final_review', tsAfter.status);
    const { data: steps } = await admin.from('approval_steps').select('approval_type,step_order').eq('timesheet_id', ts.id).eq('cycle_number', 1);
    const types = steps.map(s => s.approval_type).sort().join(',');
    record('Chain = only spm+hr at step_order 1, no team_lead/department_head rows', types === 'hr,spm' && steps.every(s => s.step_order === 1), types);
  }

  console.log('\n--- Test 4: ownership check ---\n');
  {
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 3, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 3);
    const { data, error } = await as.intruder.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    record('Non-owner submission rejected', !!error, error?.message || 'no error, cycle=' + data);
    const { data: tsAfter } = await admin.from('timesheets').select('status').eq('id', ts.id).single();
    record('Status remains draft after rejected non-owner attempt', tsAfter.status === 'draft', tsAfter.status);
  }

  console.log('\n--- Test 5: status check (double-submit) ---\n');
  {
    const ts = await newDraftTimesheet(staffOps.id, 'operations', 4, 2026);
    createdTimesheetIds.push(ts.id);
    await fillAllDays(ts.id, 2026, 4);
    const first = await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    record('First submission succeeds', !first.error, first.error?.message);
    const second = await as.staffOps.rpc('submit_timesheet', { p_timesheet_id: ts.id });
    const msg = second.error?.message || '';
    record('Second submission (already pending_team_lead) rejected with specific status message',
      !!second.error && msg.includes('not in draft status'), msg);
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
