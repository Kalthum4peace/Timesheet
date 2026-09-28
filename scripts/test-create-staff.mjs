// Behavioral test for lib/createStaff.ts (the reporting-line rule), run against
// the DEV project only (reads .env, exactly like the other test-*.mjs scripts —
// never point this at production). Calls the REAL createStaffAccount with the
// service-role client, then reads the database back. Ephemeral `cs-test-*`
// fixtures, deleted in `finally`.
//
// Covers the rule from 20260926000000: for Medical the department head is
// required and the team lead is optional; Operations is both-or-neither.
//
// Run with: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-create-staff.mjs

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { createStaffAccount, reportingLineError } from '../lib/createStaff.ts';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0, failn = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${!ok && detail ? '  (' + detail + ')' : ''}`);
  ok ? pass++ : failn++;
};

const DOMAIN = '@kalthum-dev.test';
const PW = 'cs-test-Temp-1234';
const MSG_MED = 'Medical staff need a department head. A team lead is optional — leave it blank if they report directly to the department head.';
const MSG_OPS = 'Operations staff need either both a team lead and a department head, or neither.';

async function cleanup() {
  const { data: profs } = await admin.from('profiles').select('id, email').like('email', 'cs-test-%');
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const ids = new Set((profs ?? []).map((p) => p.id));
  for (const u of users.users) if ((u.email ?? '').startsWith('cs-test-')) ids.add(u.id);
  for (const id of ids) {
    for (const step of [
      () => admin.from('notifications').delete().eq('recipient_id', id),
      () => admin.from('organizational_assignments').delete().eq('staff_id', id),
      () => admin.from('profiles').delete().eq('id', id),
      () => admin.auth.admin.deleteUser(id),
    ]) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await step(); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
      }
    }
  }
}
const counts = async () => ({
  profiles: (await admin.from('profiles').select('id', { count: 'exact', head: true })).count,
  users: (await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.length,
  assignments: (await admin.from('organizational_assignments').select('id', { count: 'exact', head: true })).count,
});

try {
  const q = async (email) => (await admin.from('profiles').select('id, role, active').eq('email', email).single()).data;
  const tl = await q('ui-test-teamlead' + DOMAIN);
  const dh = await q('ui-test-depthead' + DOMAIN);
  const hr = await q('ui-test-hr' + DOMAIN);
  if (!tl || !dh || !hr) throw new Error('dev fixtures missing (ui-test-teamlead / ui-test-depthead / ui-test-hr)');
  await cleanup();

  // Pure rule first (no database).
  const rule = [
    ['medical', 'tl', 'dh', null], ['medical', '', 'dh', null], ['medical', 'tl', '', MSG_MED], ['medical', '', '', MSG_MED],
    ['operations', 'tl', 'dh', null], ['operations', '', '', null], ['operations', 'tl', '', MSG_OPS], ['operations', '', 'dh', MSG_OPS],
  ];
  check('P1 reportingLineError truth table (8 combinations, medical + operations)',
    rule.every(([d, t, h, exp]) => reportingLineError(d, t, h) === exp),
    rule.map(([d, t, h, exp]) => `${d}/${t || '-'}/${h || '-'}=${reportingLineError(d, t, h) === exp ? 'ok' : 'BAD'}`).join(' '));

  const make = (n, department, teamLeadId, departmentHeadId) =>
    createStaffAccount(admin, {
      fullName: `CS Test ${n}`, email: `cs-test-${n}${DOMAIN}`, location: 'Yola', role: 'staff', password: PW,
      department, teamLeadId, departmentHeadId,
    }, hr.id);
  const assignment = async (n) => {
    const p = await q(`cs-test-${n}${DOMAIN}`);
    if (!p) return { profile: null, oa: [] };
    return { profile: p, oa: (await admin.from('organizational_assignments').select('department, team_lead_id, department_head_id, effective_to, created_by').eq('staff_id', p.id)).data };
  };
  const nothingCreated = async (n, before) => {
    const a = await assignment(n), c = await counts();
    return !a.profile && a.oa.length === 0 && c.profiles === before.profiles && c.users === before.users && c.assignments === before.assignments;
  };

  // 1. Medical, both present (regression)
  let r = await make('m-both', 'medical', tl.id, dh.id);
  let a = await assignment('m-both');
  check('1  Medical, both ids present -> succeeds', r.ok, r.error);
  check('1b   ...assignment stores both ids, medical, open-ended, created_by = acting admin',
    a.oa.length === 1 && a.oa[0].department === 'medical' && a.oa[0].team_lead_id === tl.id && a.oa[0].department_head_id === dh.id && a.oa[0].effective_to === null && a.oa[0].created_by === hr.id, JSON.stringify(a.oa));

  // 2. Medical, department head only (the new case)
  r = await make('m-dhonly', 'medical', '', dh.id);
  a = await assignment('m-dhonly');
  check('2  Medical, department_head present + team_lead blank -> succeeds', r.ok, r.error);
  check('2b   ...assignment has team_lead_id NULL (not ""), department_head_id set, department medical',
    a.oa.length === 1 && a.oa[0].team_lead_id === null && a.oa[0].department_head_id === dh.id && a.oa[0].department === 'medical', JSON.stringify(a.oa));
  check('2c   ...profile is role staff and gated (must_change_password)', a.profile?.role === 'staff' &&
    (await admin.from('profiles').select('must_change_password').eq('id', a.profile.id).single()).data.must_change_password === true);
  const si = await createClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
    .auth.signInWithPassword({ email: 'cs-test-m-dhonly' + DOMAIN, password: PW });
  check('2d   ...the new account can sign in with the temporary password', !si.error && !!si.data.session, si.error?.message);

  // 3. Medical, team lead present, department head missing -> still rejected
  let before = await counts();
  r = await make('m-tlonly', 'medical', tl.id, '');
  check('3  Medical, team_lead present + department_head blank -> REJECTED with the medical message', !r.ok && r.error === MSG_MED, r.error);
  check('3b   ...nothing written (no login, profile or assignment)', await nothingCreated('m-tlonly', before));

  // 4. Medical, both blank -> still rejected
  before = await counts();
  r = await make('m-none', 'medical', '', '');
  check('4  Medical, both blank -> REJECTED with the medical message', !r.ok && r.error === MSG_MED, r.error);
  check('4b   ...nothing written', await nothingCreated('m-none', before));

  // 5. Operations unaffected
  r = await make('o-none', 'operations', '', '');
  a = await assignment('o-none');
  check('5  Operations, both blank -> succeeds, both ids NULL', r.ok && a.oa.length === 1 && a.oa[0].team_lead_id === null && a.oa[0].department_head_id === null, r.error ?? JSON.stringify(a.oa));
  r = await make('o-both', 'operations', tl.id, dh.id);
  a = await assignment('o-both');
  check('5b Operations, both set -> succeeds, both ids stored', r.ok && a.oa[0]?.team_lead_id === tl.id && a.oa[0]?.department_head_id === dh.id, r.error);
  before = await counts();
  r = await make('o-tlonly', 'operations', tl.id, '');
  check('5c Operations, only team lead -> still rejected (pair rule), nothing written', !r.ok && r.error === MSG_OPS && (await nothingCreated('o-tlonly', before)), r.error);
  before = await counts();
  r = await make('o-dhonly', 'operations', '', dh.id);
  check('5d Operations, only department head -> still rejected (pair rule), nothing written', !r.ok && r.error === MSG_OPS && (await nothingCreated('o-dhonly', before)), r.error);

  // Other roles are untouched by the rule (no assignment row is created for them)
  r = await createStaffAccount(admin, { fullName: 'CS Test tl', email: 'cs-test-tl' + DOMAIN, location: 'Yola', role: 'team_lead', password: PW }, hr.id);
  a = await assignment('tl');
  check('6  role=team_lead still needs no department/reporting line and gets no assignment row', r.ok && a.oa.length === 0, r.error);
} finally {
  await cleanup();
  const { data: left } = await admin.from('profiles').select('id').like('email', 'cs-test-%');
  const users = (await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.filter((u) => (u.email ?? '').startsWith('cs-test-'));
  check('Z1 cleanup: zero cs-test fixtures left (profiles + logins)', (left?.length ?? 0) === 0 && users.length === 0, `${left?.length} profiles, ${users.length} logins`);
  console.log(`\n${pass}/${pass + failn} passed`);
  process.exitCode = failn ? 1 : 0;
}
