// Behavioral tests for staff deactivation (lib/staffAdmin.ts -> deactivateStaff,
// the exact code behind the Admin screen's Deactivate button).
//
// Runs the REAL function with REAL signed-in callers (anon key + password
// sign-in, so RLS and auth.uid() behave exactly as in the app) against the
// dev project, using ephemeral `deact-test-*` fixtures that are deleted in
// `finally`. Requires Node >= 22.18 (runs the .ts file directly).
//
// Proves:
//   - only admin/admin_hr can deactivate; a non-admin and an admin whose own
//     flag was cleared are both refused; self-deactivation is refused, and
//     the database's own trigger refuses it independently
//   - the in-flight-work guard (pending approvals in the CURRENT cycle,
//     current supervisor of active staff), incl. the stale-earlier-cycle trap
//   - deactivation revokes login (Auth ban) and NEVER touches history:
//     approval_steps / timesheet_actions / timesheets / attendance /
//     organizational_assignments are byte-identical before vs after
//   - a failed ban rolls the flag back (flag and login never disagree)
//   - deactivate-then-replace for the HR position, end to end through chain
//     generation (the path profiles_one_active_hr_position was built for)
//   - the real SPM account is never modified (row + auth ban state snapshot)
//
// It temporarily deactivates the standing fixture ui-test-hr (only one
// active HR-position profile may exist) and restores it in `finally`, after
// every throwaway HR row is gone. If the script is hard-killed mid-run,
// ui-test-hr may be left inactive — re-run to restore, or set it by hand.
//
// Run with: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-deactivate.mjs
// (the flag only silences Node's note that package.json has no "type";
// adding one would change how the rest of the Next.js project loads.)

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { deactivateStaff } from '../lib/staffAdmin.ts';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(URL_, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const anonClient = () => createClient(URL_, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const FIXTURE_HR = 'ui-test-hr@kalthum-dev.test';
const HR_INDEX = 'profiles_one_active_hr_position';

const results = [];
function record(label, pass, detail) {
  results.push({ label, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${label}${detail ? '  (' + detail + ')' : ''}`);
}
const info = (msg) => console.log(`INFO — ${msg}`);

const personas = [];
const timesheetIds = [];
async function mk(key, full_name, role) {
  const email = `deact-test-${key}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}@kalthum-dev.test`;
  const password = 'Test-' + Math.random().toString(36).slice(2) + 'Aa1!';
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${key}): ${error.message}`);
  const p = { key, id: data.user.id, email, password, full_name };
  personas.push(p);
  const { error: profErr } = await admin.from('profiles').insert({ id: p.id, full_name, email, location: 'Yola', role });
  if (profErr) throw new Error(`profiles insert(${key}): ${profErr.message}`);
  return p;
}
async function signInAs(p) {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email: p.email, password: p.password });
  if (error) throw new Error(`signIn(${p.key}): ${error.message}`);
  return client;
}
async function canSignIn(p) {
  const { error } = await anonClient().auth.signInWithPassword({ email: p.email, password: p.password });
  return { ok: !error, message: error?.message };
}
const profileOf = async (id) => (await admin.from('profiles').select('*').eq('id', id).single()).data;

function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
async function newSubmittableTimesheet(staff, department, month, year) {
  const { data: ts, error } = await admin.from('timesheets')
    .insert({ staff_id: staff.id, location: 'Yola', department, month, year, status: 'draft' }).select().single();
  if (error) throw new Error('timesheet insert: ' + error.message);
  timesheetIds.push(ts.id);
  const rows = [];
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    rows.push({ timesheet_id: ts.id, date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`, status: 'present' });
  }
  const { error: e2 } = await admin.from('attendance_entries').insert(rows);
  if (e2) throw new Error('attendance insert: ' + e2.message);
  return ts;
}
async function assign(staff, tl, dh, department, from, createdBy) {
  const { error } = await admin.from('organizational_assignments').insert({
    staff_id: staff.id, team_lead_id: tl.id, department_head_id: dh.id, department, effective_from: from, created_by: createdBy,
  });
  if (error) throw new Error('assignment insert: ' + error.message);
}
const rpc = async (client, fn, args) => {
  const r = await client.rpc(fn, args);
  if (r.error) throw new Error(`${fn}: ${r.error.message}`);
  return r.data;
};

// Everything a deactivation must never change, for every test timesheet.
async function historySnapshot() {
  const ids = timesheetIds.length ? timesheetIds : ['00000000-0000-0000-0000-000000000000'];
  const personaIds = personas.map((p) => p.id);
  const [steps, actions, sheets, atts, assigns] = await Promise.all([
    admin.from('approval_steps').select('*').in('timesheet_id', ids).order('timesheet_id').order('cycle_number').order('step_order').order('approver_id'),
    admin.from('timesheet_actions').select('*').in('timesheet_id', ids).order('created_at').order('id'),
    admin.from('timesheets').select('*').in('id', ids).order('id'),
    admin.from('attendance_entries').select('*').in('timesheet_id', ids).order('timesheet_id').order('date'),
    admin.from('organizational_assignments').select('*').in('staff_id', personaIds).order('staff_id').order('effective_from'),
  ]);
  return JSON.stringify({ steps: steps.data, actions: actions.data, sheets: sheets.data, atts: atts.data, assigns: assigns.data });
}

// Transport-flake guard. deactivateStaff correctly reports "Not signed in."
// (fail closed) when getUser() can't reach the auth server. In THIS test every
// caller is legitimately signed in, so that message can only mean a transient
// network/socket failure (seen intermittently against the dev project, e.g.
// "fetch failed" on a reused idle connection; not reproducible in isolation).
// Retry a few times, but LOG every retry so a real defect would show up as a
// visible, repeating pattern instead of being silently absorbed.
async function deactivate(caller, adminClient, targetId) {
  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = await deactivateStaff(caller, adminClient, targetId);
    if (r.ok || r.error !== 'Not signed in.') return r;
    console.log(`INFO — transient "Not signed in." from getUser (attempt ${attempt}/3); retrying`);
    await new Promise((res) => setTimeout(res, 1500 * attempt));
  }
  return r;
}

const staffMsgIncludes = (r, s) => !r.ok && r.error.includes(s);

let fixtureHrWasActive = false;
let realSpmBefore = null;

async function main() {
  // ---- guard rails on the standing dev data ----
  const { data: spmRows } = await admin.from('profiles').select('*').eq('role', 'spm').eq('active', true);
  if (spmRows.length !== 1) throw new Error(`expected exactly 1 active SPM in dev, found ${spmRows.length}`);
  const realSpm = spmRows[0];
  const { data: spmAuth } = await admin.auth.admin.getUserById(realSpm.id);
  realSpmBefore = JSON.stringify({ profile: realSpm, banned_until: spmAuth.user.banned_until ?? null });

  const { data: hrNow } = await admin.from('profiles').select('email').in('role', ['hr', 'admin_hr']).eq('active', true);
  if (hrNow.length !== 1 || hrNow[0].email !== FIXTURE_HR) {
    throw new Error(`precondition: expected ${FIXTURE_HR} to be the only active HR-position profile, found [${hrNow.map((h) => h.email)}] — nothing was changed`);
  }
  const { data: fx } = await admin.from('profiles').select('id,active').eq('email', FIXTURE_HR).single();
  fixtureHrWasActive = !!fx?.active;
  if (fixtureHrWasActive) {
    await admin.from('profiles').update({ active: false }).eq('email', FIXTURE_HR);
    info(`temporarily deactivated ${FIXTURE_HR} (DB flag only); restored at the end`);
  }

  console.log('\nCreating personas...');
  const adminA = await mk('adminA', 'Admin A', 'admin');
  const adminB = await mk('adminB', 'Admin B', 'admin');
  const hrT = await mk('hrT', 'HR Throwaway', 'admin_hr');
  const s1 = await mk('s1', 'Staff One', 'staff');
  const sPlain = await mk('splain', 'Staff Plain', 'staff');
  const tl1 = await mk('tl1', 'TL One', 'team_lead');
  const dh1 = await mk('dh1', 'DH One', 'department_head');
  const tl2 = await mk('tl2', 'TL Two', 'team_lead');
  const dh2 = await mk('dh2', 'DH Two', 'department_head');
  const s3 = await mk('s3', 'Staff Three', 'staff');
  const tl3 = await mk('tl3', 'TL Three', 'team_lead');
  const dh3 = await mk('dh3', 'DH Three', 'department_head');

  await assign(s1, tl1, dh1, 'operations', '2026-01-01', adminA.id);
  await assign(sPlain, tl1, dh1, 'operations', '2026-01-01', adminA.id);
  await assign(s3, tl3, dh3, 'operations', '2026-01-01', adminA.id);

  const as = {};
  for (const p of [adminA, adminB, s1, sPlain, tl1, dh1, tl3, dh3, hrT, s3]) as[p.key] = await signInAs(p);

  console.log('\n--- A: authorization and self-protection ---\n');

  let r = await deactivate(as.s1, admin, sPlain.id);
  record('non-admin caller is refused', staffMsgIncludes(r, 'Only an admin'), r.error);
  record('  ...and the target is untouched (still active, can still sign in)',
    (await profileOf(sPlain.id)).active === true && (await canSignIn(sPlain)).ok);

  r = await deactivate(as.adminA, admin, adminA.id);
  record('admin cannot deactivate their own account', staffMsgIncludes(r, "can't deactivate your own"), r.error);
  const direct = await as.adminA.from('profiles').update({ active: false }).eq('id', adminA.id).select();
  record('  ...and the DATABASE independently refuses the same self-change (trigger backstop)',
    !!direct.error && direct.error.message.includes('cannot change their own role or active status'), direct.error?.message);
  record('  ...admin A is still active', (await profileOf(adminA.id)).active === true);

  r = await deactivate(as.adminA, admin, 'not-a-uuid');
  record('malformed target id is rejected', !r.ok, r.error);
  r = await deactivate(as.adminA, admin, '11111111-1111-4111-8111-111111111111');
  record('unknown (well-formed) target id is rejected', staffMsgIncludes(r, "doesn't exist"), r.error);

  // admin B keeps a valid token but is deactivated at the flag level (no ban)
  // -> the function must still refuse to act for them.
  await admin.from('profiles').update({ active: false }).eq('id', adminB.id);
  r = await deactivate(as.adminB, admin, sPlain.id);
  record('a caller whose own account is deactivated is refused (valid token, active=false)',
    staffMsgIncludes(r, 'Only an admin'), r.error);
  await admin.from('profiles').update({ active: true }).eq('id', adminB.id);

  console.log('\n--- B: in-flight-work guard (Operations chain: TL -> DH -> SPM + HR) ---\n');

  const ts1 = await newSubmittableTimesheet(s1, 'operations', 1, 2026);
  await rpc(as.s1, 'submit_timesheet', { p_timesheet_id: ts1.id });

  r = await deactivate(as.adminA, admin, tl1.id);
  record('team lead with a pending approval AND active staff is refused for both reasons',
    staffMsgIncludes(r, 'waiting on their approval') && staffMsgIncludes(r, 'currently the team lead or department head for 2 active'), r.error);
  record('  ...and is untouched (active, can sign in)', (await profileOf(tl1.id)).active === true && (await canSignIn(tl1)).ok);

  await rpc(as.tl1, 'approve_timesheet', { p_timesheet_id: ts1.id });
  r = await deactivate(as.adminA, admin, tl1.id);
  record('after approving, team lead is STILL refused — now only as current supervisor of 2 active staff',
    staffMsgIncludes(r, 'currently the team lead or department head for 2 active') && !r.error.includes('waiting on their approval'), r.error);

  r = await deactivate(as.adminA, admin, dh1.id);
  record('department head with a pending step is refused', staffMsgIncludes(r, 'waiting on their approval'), r.error);

  // ---- ban rollback: a failed ban must undo the flag ----
  const failingAdmin = new Proxy(admin, {
    get(t, p) {
      if (p === 'auth') return { admin: { updateUserById: async () => ({ error: { message: 'simulated ban failure' } }) } };
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  r = await deactivate(as.adminA, failingAdmin, sPlain.id);
  const afterFail = await profileOf(sPlain.id);
  record('if revoking login fails, the flag is rolled back (nothing half-applied)',
    !r.ok && r.error.includes('nothing was changed') && afterFail.active === true && (await canSignIn(sPlain)).ok, r.error);

  // ---- a staff member with no duties: deactivation succeeds ----
  const snapBeforePlain = await historySnapshot();
  r = await deactivate(as.adminA, admin, sPlain.id);
  record('a plain staff member with no approver duties is deactivated', r.ok, r.error);
  const plainAfter = await profileOf(sPlain.id);
  const plainLogin = await canSignIn(sPlain);
  record('  ...flag is off', plainAfter.active === false);
  record('  ...login is blocked at the Auth layer', !plainLogin.ok && /banned/i.test(plainLogin.message), plainLogin.message);
  record('  ...history is byte-identical before vs after', (await historySnapshot()) === snapBeforePlain);

  r = await deactivate(as.adminA, admin, sPlain.id);
  record('deactivating an already-deactivated account is refused', staffMsgIncludes(r, 'already deactivated'), r.error);

  r = await deactivate(as.adminA, admin, tl1.id);
  record('a deactivated staff member no longer counts toward the supervisor guard (2 -> 1 active)',
    staffMsgIncludes(r, 'currently the team lead or department head for 1 active staff member'), r.error);

  // ---- reassign the remaining staff away, clear pending duties, then succeed ----
  const { data: openRow } = await admin.from('organizational_assignments')
    .select('id').eq('staff_id', s1.id).is('effective_to', null).single();
  const closed = await admin.from('organizational_assignments').update({ effective_to: '2026-01-31' }).eq('id', openRow.id).select();
  if (closed.error || closed.data.length !== 1) throw new Error('could not close s1 assignment: ' + closed.error?.message);
  await assign(s1, tl2, dh2, 'operations', '2026-02-01', adminA.id);
  await rpc(as.dh1, 'approve_timesheet', { p_timesheet_id: ts1.id });

  const { data: ts1Now } = await admin.from('timesheets').select('status').eq('id', ts1.id).single();
  record('setup: timesheet advanced to final review; TL1/DH1 approved, no pending, no active staff',
    ts1Now.status === 'pending_final_review');

  const snapBefore = await historySnapshot();
  const tl1Token = (await as.tl1.auth.getSession()).data.session.access_token;

  r = await deactivate(as.adminA, admin, tl1.id);
  record('team lead with only APPROVED history and no live duties is deactivated', r.ok, r.error);
  r = await deactivate(as.adminA, admin, dh1.id);
  record('department head with only APPROVED history and no live duties is deactivated', r.ok, r.error);

  for (const p of [tl1, dh1]) {
    const prof = await profileOf(p.id);
    const login = await canSignIn(p);
    record(`  ...${p.key}: flag off and login blocked`, prof.active === false && !login.ok && /banned/i.test(login.message), login.message);
  }
  record('  ...history (steps, actions, timesheets, attendance, assignments) byte-identical before vs after',
    (await historySnapshot()) === snapBefore);
  const { data: tl1Steps } = await admin.from('approval_steps').select('status').eq('approver_id', tl1.id);
  record('  ...the deactivated approver\'s approved step is still there, still "approved"',
    tl1Steps.length === 1 && tl1Steps[0].status === 'approved');

  // What an already-signed-in browser can still do (informational).
  const tokenClient = createClient(URL_, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${tl1Token}` } },
  });
  const viaGetUser = await anonClient().auth.getUser(tl1Token);
  const viaRest = await tokenClient.from('profiles').select('role').eq('id', tl1.id).maybeSingle();
  info(`already-issued access token after deactivation: getUser -> ${viaGetUser.error ? 'REJECTED (' + viaGetUser.error.message + ')' : 'accepted'}; direct PostgREST read -> ${viaRest.error ? 'rejected' : viaRest.data ? 'STILL ACCEPTED until the JWT expires' : 'no rows'}`);

  console.log('\n--- C: HR position — deactivate, then replace (chain generation end to end) ---\n');

  const dupe = await mk('hrDupe', 'HR Dupe', 'staff');
  const dupeIns = await admin.from('profiles').update({ role: 'admin_hr' }).eq('id', dupe.id);
  record('while HR-T is active a second active HR/Admin is rejected by the DB index',
    !!dupeIns.error && dupeIns.error.message.includes(HR_INDEX), dupeIns.error?.message);

  const ts3 = await newSubmittableTimesheet(s3, 'operations', 1, 2026);
  await rpc(as.s3, 'submit_timesheet', { p_timesheet_id: ts3.id });
  await rpc(as.tl3, 'approve_timesheet', { p_timesheet_id: ts3.id });
  await rpc(as.dh3, 'decline_timesheet', { p_timesheet_id: ts3.id, p_comment: 'Recount the leave days.' });
  await rpc(as.tl3, 'acknowledge_return_timesheet', { p_timesheet_id: ts3.id });
  const c2 = await rpc(as.s3, 'resubmit_timesheet', { p_timesheet_id: ts3.id });
  record('setup: cycle 1 declined at DH (HR-T left a STALE pending row), staff resubmitted -> cycle 2', c2 === 2);

  r = await deactivate(as.adminA, admin, hrT.id);
  record('HR with a pending approval in the live cycle is refused', staffMsgIncludes(r, 'waiting on their approval'), r.error);

  await rpc(as.tl3, 'approve_timesheet', { p_timesheet_id: ts3.id });
  await rpc(as.dh3, 'approve_timesheet', { p_timesheet_id: ts3.id });
  await rpc(as.hrT, 'approve_timesheet', { p_timesheet_id: ts3.id });

  // HR-T was also the HR on section B's timesheet, still at final review with
  // HR-T pending — real live work, which the guard (correctly) counted above
  // as "2 timesheets". Clear it too, exactly as an admin would have to ask
  // the outgoing HR to do.
  r = await deactivate(as.adminA, admin, hrT.id);
  record('HR is STILL refused while the earlier section-B timesheet is waiting on them',
    staffMsgIncludes(r, '1 timesheet waiting on their approval'), r.error);
  await rpc(as.hrT, 'approve_timesheet', { p_timesheet_id: ts1.id });

  const { data: hrSteps } = await admin.from('approval_steps').select('cycle_number,status').eq('approver_id', hrT.id).eq('timesheet_id', ts3.id).order('cycle_number');
  record('setup: on ts3, HR-T has a stale PENDING row in cycle 1 and an APPROVED row in cycle 2',
    hrSteps.length === 2 && hrSteps[0].cycle_number === 1 && hrSteps[0].status === 'pending' && hrSteps[1].status === 'approved',
    JSON.stringify(hrSteps));

  const snapHr = await historySnapshot();
  r = await deactivate(as.adminA, admin, hrT.id);
  record('HR-T IS deactivated — the stale earlier-cycle pending row does not block', r.ok, r.error);
  record('  ...history byte-identical before vs after (incl. the stale row and the approved row)', (await historySnapshot()) === snapHr);
  const hrLogin = await canSignIn(hrT);
  record('  ...HR-T login is blocked', !hrLogin.ok && /banned/i.test(hrLogin.message), hrLogin.message);

  const s4 = await mk('s4', 'Staff Four', 'staff');
  await assign(s4, tl3, dh3, 'operations', '2026-01-01', adminA.id);
  const ts4 = await newSubmittableTimesheet(s4, 'operations', 1, 2026);
  const as4 = await signInAs(s4);
  const gapReal = await as4.rpc('submit_timesheet', { p_timesheet_id: ts4.id });
  record('in the gap with NO active HR, submission fails loudly (documented transitional state)',
    !!gapReal.error && gapReal.error.message.includes('expected exactly one active HR profile, found 0'), gapReal.error?.message);

  const hrU = await mk('hrU', 'HR Replacement', 'admin_hr');
  record('a replacement HR/Admin can now be created (index allows it)', !!hrU.id);
  const gapAfter = await as4.rpc('submit_timesheet', { p_timesheet_id: ts4.id });
  record('submission works again once the replacement exists', !gapAfter.error, gapAfter.error?.message);
  const { data: ts4Steps } = await admin.from('approval_steps').select('approval_type,approver_id').eq('timesheet_id', ts4.id).eq('approval_type', 'hr');
  record('  ...the new chain routes the HR step to the REPLACEMENT, not the deactivated HR',
    ts4Steps.length === 1 && ts4Steps[0].approver_id === hrU.id, JSON.stringify(ts4Steps));
  record('  ...replacement can sign in', (await canSignIn(hrU)).ok);
}

// Each cleanup step is retried: a transient network error here once left the
// standing fixture ui-test-hr deactivated (a failed cleanup silently breaks the
// next chain generation), so failures are retried and then reported loudly.
async function step(label, fn) {
  let last = 'unknown';
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fn();
      if (!r || !r.error) return true;
      last = r.error.message;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((res) => setTimeout(res, 1500 * i));
  }
  console.error(`!! CLEANUP STEP FAILED after retries: ${label} (${last}) — check dev by hand (leftover deact-test-* rows? ui-test-hr active?)`);
  return false;
}

async function cleanup() {
  console.log('\nCleaning up...');
  const personaIds = personas.map((p) => p.id);
  if (timesheetIds.length) {
    await step('notifications by timesheet', () => admin.from('notifications').delete().in('timesheet_id', timesheetIds));
    await step('approval_steps', () => admin.from('approval_steps').delete().in('timesheet_id', timesheetIds));
    await step('timesheet_actions', () => admin.from('timesheet_actions').delete().in('timesheet_id', timesheetIds));
    await step('attendance_entries', () => admin.from('attendance_entries').delete().in('timesheet_id', timesheetIds));
    await step('timesheets', () => admin.from('timesheets').delete().in('id', timesheetIds));
  }
  if (personaIds.length) {
    await step('notifications by recipient', () => admin.from('notifications').delete().in('recipient_id', personaIds));
    await step('organizational_assignments', () => admin.from('organizational_assignments').delete().in('staff_id', personaIds));
    await step('profiles', () => admin.from('profiles').delete().in('id', personaIds));
    for (const id of personaIds) await step('auth user ' + id, () => admin.auth.admin.deleteUser(id));
  }
  // Only after every throwaway HR row is gone, or this would violate the index.
  if (fixtureHrWasActive) {
    await step('restore ui-test-hr', () => admin.from('profiles').update({ active: true }).eq('email', FIXTURE_HR));
  }

  const left = {
    profiles: (await admin.from('profiles').select('id').in('id', personaIds)).data?.length ?? 0,
    timesheets: timesheetIds.length ? (await admin.from('timesheets').select('id').in('id', timesheetIds)).data?.length ?? 0 : 0,
    steps: timesheetIds.length ? (await admin.from('approval_steps').select('id').in('timesheet_id', timesheetIds)).data?.length ?? 0 : 0,
  };
  const { data: hrActive } = await admin.from('profiles').select('email').in('role', ['hr', 'admin_hr']).eq('active', true);
  record('cleanup: zero leftover profiles / timesheets / approval_steps', left.profiles === 0 && left.timesheets === 0 && left.steps === 0, JSON.stringify(left));
  record('cleanup: exactly one active HR-position profile remains, and it is ui-test-hr',
    hrActive.length === 1 && hrActive[0].email === FIXTURE_HR, hrActive.map((h) => h.email).join(', '));

  if (realSpmBefore) {
    const { data: spmRows } = await admin.from('profiles').select('*').eq('role', 'spm').eq('active', true);
    const { data: spmAuth } = await admin.auth.admin.getUserById(spmRows[0].id);
    const after = JSON.stringify({ profile: spmRows[0], banned_until: spmAuth.user.banned_until ?? null });
    record('the real SPM account (profile row + auth ban state) is byte-identical to before the run', after === realSpmBefore);
  }
}

let failure = null;
try {
  await main();
} catch (e) {
  failure = e;
  console.error('\nABORTED:', e.message);
} finally {
  await cleanup();
}

const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed${failure ? '  (run ABORTED early — see above)' : ''}`);
// exitCode, not process.exit(): exiting while HTTP handles are still closing
// trips a libuv assertion on Node/Windows and reports 127 instead of 0/1.
process.exitCode = failed || failure ? 1 : 0;
