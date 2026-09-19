// Behavioral test for pending_final_approvers (client feedback round 2,
// 2026-09-18, Part 4 — role-aware "awaiting final review" labels).
// Migration: supabase/migrations/20260918050000_pending_final_approvers.sql
//
// Builds approval_steps states DIRECTLY (service role) instead of going
// through generate_approval_chain: chain generation requires exactly one
// active SPM and one active HR profile in the whole database, which the real
// dev project already satisfies with its own accounts, so this test's SPM/HR
// personas are created active=false to leave that invariant alone. (Neither
// current_profile_role() nor the RLS helpers look at `active`.)
//
// Two things matter most here:
//   1. The label rule — pending rows at the lowest pending step_order of the
//      NEWEST cycle, including the stale-cycle trap (a declined earlier
//      cycle can leave 'pending' rows behind; they must not count).
//   2. Authorization parity — this SECURITY DEFINER function's visibility
//      predicate is a copy of timesheets_select, so for every persona and
//      every timesheet, "function returns rows" must equal "a direct
//      SELECT on timesheets returns the row". If timesheets_select ever
//      changes, this test is what catches the drift.
//
// Creates real personas/timesheets, deletes everything it created.
// Run with: node scripts/test-pending-final-approvers.mjs

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

async function createPersona(key, full_name, role, { active = true } = {}) {
  const email = `pfa-test-${key}-${Date.now()}@kalthum-dev.test`;
  const password = 'Test-' + Math.random().toString(36).slice(2) + 'Aa1!';
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${key}): ${error.message}`);
  const id = data.user.id;
  const { error: profErr } = await admin.from('profiles').insert({ id, full_name, email, location: 'Maiduguri', role, active });
  if (profErr) throw new Error(`profiles insert(${key}): ${profErr.message}`);
  return { key, id, email, password };
}
async function signInAs(persona) {
  const client = createClient(URL_, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: persona.email, password: persona.password });
  if (error) throw new Error(`signIn(${persona.key}): ${error.message}`);
  return client;
}
async function newTimesheet(staffId, department, month, status) {
  const { data, error } = await admin.from('timesheets').insert({
    staff_id: staffId, location: 'Maiduguri', department, month, year: 2026, status,
  }).select().single();
  if (error) throw new Error('timesheet insert: ' + error.message);
  return data;
}
async function steps(timesheetId, rows) {
  const { error } = await admin.from('approval_steps').insert(
    rows.map(([cycle_number, step_order, approval_type, approver_id, status]) => ({
      timesheet_id: timesheetId, cycle_number, step_order, approval_type, approver_id, status,
    })),
  );
  if (error) throw new Error('approval_steps insert: ' + error.message);
}

const personaIds = [];
const timesheetIds = [];

async function pendingFor(client, ids) {
  const { data, error } = await client.rpc('pending_final_approvers', { p_timesheet_ids: ids });
  if (error) return { error: error.message, map: {} };
  const map = {};
  for (const row of data) (map[row.ts_id] ??= []).push(row.pending_type);
  for (const k of Object.keys(map)) map[k].sort();
  return { error: null, map };
}
const same = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

async function main() {
  console.log('Creating personas...');
  const adminP = await createPersona('admin', 'Admin P', 'admin', { active: true });
  const spmP = await createPersona('spm', 'SPM P', 'spm', { active: false });
  const hrP = await createPersona('hr', 'HR P', 'hr', { active: false });
  const adminHrP = await createPersona('adminhr', 'AdminHR P', 'admin_hr', { active: false });
  const staffOps = await createPersona('staffOps', 'Staff Ops', 'staff');
  const tlOps = await createPersona('tlOps', 'TL Ops', 'team_lead');
  const dhOps = await createPersona('dhOps', 'DH Ops', 'department_head');
  const staffMed = await createPersona('staffMed', 'Staff Med', 'staff');
  const tlMed = await createPersona('tlMed', 'TL Med', 'team_lead');
  const dhMed = await createPersona('dhMed', 'DH Med', 'department_head');
  const outsider = await createPersona('outsider', 'Outsider', 'staff');
  const all = [adminP, spmP, hrP, adminHrP, staffOps, tlOps, dhOps, staffMed, tlMed, dhMed, outsider];
  personaIds.push(...all.map((p) => p.id));

  const base = { effective_from: '2026-01-01', created_by: adminP.id };
  await admin.from('organizational_assignments').insert([
    { staff_id: staffOps.id, team_lead_id: tlOps.id, department_head_id: dhOps.id, department: 'operations', ...base },
    { staff_id: tlOps.id, department: 'operations', ...base },
    { staff_id: dhOps.id, department: 'operations', ...base },
    { staff_id: staffMed.id, team_lead_id: tlMed.id, department_head_id: dhMed.id, department: 'medical', ...base },
    { staff_id: tlMed.id, department: 'medical', ...base },
    { staff_id: dhMed.id, department: 'medical', ...base },
  ]).then((r) => { if (r.error) throw new Error('org assignments: ' + r.error.message); });

  const as = {};
  for (const p of all) as[p.key] = await signInAs(p);
  const anon = createClient(URL_, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const S = spmP.id, H = hrP.id;
  const mk = async (staff, dept, month, status = 'pending_final_review') => {
    const ts = await newTimesheet(staff.id, dept, month, status);
    timesheetIds.push(ts.id);
    return ts;
  };

  console.log('\n--- A: the label rule ---\n');

  const t1 = await mk(staffOps, 'operations', 1);
  await steps(t1.id, [[1, 1, 'team_lead', tlOps.id, 'approved'], [1, 2, 'department_head', dhOps.id, 'approved'], [1, 3, 'spm', S, 'pending'], [1, 3, 'hr', H, 'pending']]);
  const t2 = await mk(staffOps, 'operations', 2);
  await steps(t2.id, [[1, 1, 'team_lead', tlOps.id, 'approved'], [1, 2, 'department_head', dhOps.id, 'approved'], [1, 3, 'spm', S, 'approved'], [1, 3, 'hr', H, 'pending']]);
  const t3 = await mk(staffOps, 'operations', 3);
  await steps(t3.id, [[1, 1, 'team_lead', tlOps.id, 'approved'], [1, 2, 'department_head', dhOps.id, 'approved'], [1, 3, 'spm', S, 'pending'], [1, 3, 'hr', H, 'approved']]);
  const t4 = await mk(staffMed, 'medical', 4);
  await steps(t4.id, [[1, 1, 'team_lead', tlMed.id, 'approved'], [1, 2, 'department_head', dhMed.id, 'approved'], [1, 3, 'hr', H, 'pending']]);
  const t5 = await mk(staffOps, 'operations', 5);
  await steps(t5.id, [[1, 1, 'team_lead', tlOps.id, 'approved'], [1, 2, 'department_head', dhOps.id, 'approved'], [1, 3, 'spm', S, 'skipped'], [1, 3, 'hr', H, 'pending']]);
  // Stale-cycle trap: cycle 1 was declined at HR and left SPM 'pending'
  // behind; cycle 2 has SPM already approved and HR pending. Only HR is
  // actually still pending — counting cycle 1's leftover would wrongly add SPM.
  const t6 = await mk(staffOps, 'operations', 6);
  await steps(t6.id, [
    [1, 1, 'team_lead', tlOps.id, 'approved'], [1, 2, 'department_head', dhOps.id, 'approved'], [1, 3, 'spm', S, 'pending'], [1, 3, 'hr', H, 'declined'],
    [2, 1, 'team_lead', tlOps.id, 'approved'], [2, 2, 'department_head', dhOps.id, 'approved'], [2, 3, 'spm', S, 'approved'], [2, 3, 'hr', H, 'pending'],
  ]);
  // Not at final review: pending rows exist but status says otherwise.
  const t7 = await mk(staffOps, 'operations', 7, 'pending_department_head');
  await steps(t7.id, [[1, 1, 'team_lead', tlOps.id, 'approved'], [1, 2, 'department_head', dhOps.id, 'pending'], [1, 3, 'spm', S, 'pending'], [1, 3, 'hr', H, 'pending']]);
  // Nothing pending (both approved) while still nominally at final review.
  const t8 = await mk(staffOps, 'operations', 8);
  await steps(t8.id, [[1, 1, 'team_lead', tlOps.id, 'approved'], [1, 2, 'department_head', dhOps.id, 'approved'], [1, 3, 'spm', S, 'approved'], [1, 3, 'hr', H, 'approved']]);

  const r = await pendingFor(as.staffOps, [t1.id, t2.id, t3.id, t5.id, t6.id, t7.id, t8.id]);
  record('function is callable and returns no error for the timesheet owner', r.error === null, r.error);
  record('Operations, SPM and HR both pending -> [hr, spm]', same(r.map[t1.id], ['hr', 'spm']), JSON.stringify(r.map[t1.id]));
  record('Operations, SPM already approved -> [hr] only', same(r.map[t2.id], ['hr']), JSON.stringify(r.map[t2.id]));
  record('Operations, HR already approved -> [spm] only', same(r.map[t3.id], ['spm']), JSON.stringify(r.map[t3.id]));
  record('Operations, SPM self-skipped -> [hr] only', same(r.map[t5.id], ['hr']), JSON.stringify(r.map[t5.id]));
  record('Stale earlier cycle ignored (cycle-1 SPM leftover not counted) -> [hr] only', same(r.map[t6.id], ['hr']), JSON.stringify(r.map[t6.id]));
  record('Not at pending_final_review -> no rows even though pending rows exist', !r.map[t7.id], JSON.stringify(r.map[t7.id]));
  record('Nothing pending -> no rows', !r.map[t8.id], JSON.stringify(r.map[t8.id]));

  const rm = await pendingFor(as.staffMed, [t4.id]);
  record('Medical, HR is sole final approver -> [hr]', same(rm.map[t4.id], ['hr']), JSON.stringify(rm.map[t4.id]));

  console.log('\n--- B: batch scoping ---\n');
  const rb = await pendingFor(as.staffOps, [t1.id, t4.id]);
  record('Batch call returns only timesheets the caller can see (own Ops one, not the Medical one)', same(rb.map[t1.id], ['hr', 'spm']) && !rb.map[t4.id], JSON.stringify(rb.map));

  console.log('\n--- C: authorization — who may learn this ---\n');
  const expectSee = { staffOps: true, tlOps: true, dhOps: true, spmP: true, hrP: true, adminHrP: true, adminP: false, outsider: false, staffMed: false, tlMed: false, dhMed: false };
  const keyToClient = { staffOps: as.staffOps, tlOps: as.tlOps, dhOps: as.dhOps, spmP: as.spm, hrP: as.hr, adminHrP: as.adminhr, adminP: as.admin, outsider: as.outsider, staffMed: as.staffMed, tlMed: as.tlMed, dhMed: as.dhMed };
  for (const [who, want] of Object.entries(expectSee)) {
    const rr = await pendingFor(keyToClient[who], [t1.id]);
    const got = !!rr.map[t1.id];
    record(`${who} ${want ? 'CAN' : 'CANNOT'} see pending approvers on an Operations timesheet`, got === want && rr.error === null, rr.error ?? `got=${got}`);
  }

  console.log('\n--- D: parity with timesheets_select (drift guard) ---\n');
  const testIds = [t1.id, t2.id, t3.id, t4.id, t5.id, t6.id];
  for (const [who, client] of Object.entries(keyToClient)) {
    let mismatches = [];
    for (const id of testIds) {
      const direct = await client.from('timesheets').select('id').eq('id', id);
      const canSelect = (direct.data ?? []).length > 0;
      const rr = await pendingFor(client, [id]);
      const fnSees = !!rr.map[id];
      if (canSelect !== fnSees) mismatches.push(`${id.slice(0, 6)}: select=${canSelect} fn=${fnSees}`);
    }
    record(`${who}: function visibility == direct timesheets SELECT across ${testIds.length} timesheets`, mismatches.length === 0, mismatches.join('; '));
  }

  console.log('\n--- E: not callable without a session ---\n');
  const ra = await anon.rpc('pending_final_approvers', { p_timesheet_ids: [t1.id] });
  record('anon (no session) is denied EXECUTE', !!ra.error, ra.error?.message ?? 'no error — grant not revoked!');
}

async function cleanup() {
  console.log('\nCleaning up...');
  if (timesheetIds.length) await admin.from('timesheets').delete().in('id', timesheetIds);
  if (personaIds.length) {
    await admin.from('notifications').delete().in('recipient_id', personaIds);
    await admin.from('organizational_assignments').delete().in('staff_id', personaIds);
    await admin.from('profiles').delete().in('id', personaIds);
    for (const id of personaIds) await admin.auth.admin.deleteUser(id);
  }
  const { data: leftovers } = await admin.from('profiles').select('id').in('id', personaIds.length ? personaIds : ['00000000-0000-0000-0000-000000000000']);
  console.log(`Cleanup verified: ${leftovers?.length ?? 0} test profile(s) remain.`);
}

main()
  .catch((e) => { console.error('\nTEST HARNESS ERROR:', e.message); results.push({ label: 'harness', pass: false }); })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((x) => !x.pass).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  });
