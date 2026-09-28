// Behavioral test for scripts/bulk-import-medical.mjs, run against the DEV
// project (never production). Runs the REAL script as a child process with
// KFP_SUPABASE_URL / KFP_SUPABASE_SECRET_KEY pointed at dev, using ephemeral
// `bulk-test-*` fixtures that are deleted in `finally`.
//
// Proves: the dry run writes nothing and shows resolved team lead / dept head
// names; every execute gate refuses (missing/wrong --expect-create,
// credentials file inside the repo); an existing email is reported and left
// alone; malformed / unresolvable / wrong-role rows are reported and skipped
// without blocking the rest; a genuine mid-batch failure does not stop the
// batch; created accounts have the exact profile + assignment rows, can sign
// in with the generated password, and the password is never printed; a second
// run is idempotent.
//
// Run with: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-bulk-import.mjs

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const REPO = fileURLToPath(new URL('..', import.meta.url));

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const HOST = new URL(URL_).host;
const admin = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0, failn = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${!ok && detail ? '  (' + detail + ')' : ''}`);
  ok ? pass++ : failn++;
};

const tmp = mkdtempSync(join(tmpdir(), 'bulk-test-'));
const DOMAIN = '@kalthum-dev.test';
const createdEmails = new Set();

const run = (args) => {
  const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/bulk-import-medical.mjs', ...args], {
    cwd: REPO,
    env: { ...process.env, KFP_SUPABASE_URL: URL_, KFP_SUPABASE_SECRET_KEY: env.SUPABASE_SERVICE_ROLE_KEY },
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const profileCount = async () => (await admin.from('profiles').select('id', { count: 'exact', head: true })).count;
const authCount = async () => (await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.length;
const writeCsv = (name, lines) => {
  const p = join(tmp, name);
  writeFileSync(p, ['Name,Email,Position,Location,role,department,team_lead_id,department_head_id', ...lines].join('\n') + '\n');
  return p;
};

async function cleanup() {
  const { data: profs } = await admin.from('profiles').select('id, email').like('email', 'bulk-test-%');
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const ids = new Set((profs ?? []).map((p) => p.id));
  for (const u of users.users) if ((u.email ?? '').startsWith('bulk-test-') || createdEmails.has(u.email)) ids.add(u.id);
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

try {
  const q = async (email) => (await admin.from('profiles').select('id, full_name, role, active').eq('email', email).single()).data;
  const tl = await q('ui-test-teamlead' + DOMAIN);
  const dh = await q('ui-test-depthead' + DOMAIN);
  const hr = await q('ui-test-hr' + DOMAIN);
  if (!tl || !dh || !hr || hr.role !== 'admin_hr' || !hr.active) throw new Error('dev fixtures missing/inactive (need ui-test-teamlead, ui-test-depthead, active admin_hr ui-test-hr)');
  const base = ['--confirm-host', HOST, '--created-by', hr.id];
  const row = (n, e, tlId = tl.id, dhId = dh.id, extra = {}) =>
    `${n},${e},${extra.pos ?? 'TRIAGER'},${extra.loc ?? 'MAIDUGURI'},${extra.role ?? 'staff'},${extra.dept ?? 'medical'},${tlId},${dhId}`;

  await cleanup();

  // ---------- 1. dry run ----------
  const csv1 = writeCsv('one.csv', [
    row('Test Alpha', 'bulk-test-a' + DOMAIN),
    row('Test Bravo', 'bulk-test-b' + DOMAIN),
    row('Existing Person', 'ui-test-staff' + DOMAIN),
    row('Underscore Gmail', '_bulk-test@gmail.com'),
    row('Bad Lead', 'bulk-test-c' + DOMAIN, randomUUID()),
    row('Wrong Role Lead', 'bulk-test-d' + DOMAIN, dh.id),
    row('Dup Alpha', 'bulk-test-a' + DOMAIN),
    row('Not Staff', 'bulk-test-g' + DOMAIN, tl.id, dh.id, { role: 'team_lead' }),
  ]);
  const pBefore = await profileCount(), aBefore = await authCount();
  const d = run(['--csv', csv1, ...base]);
  check('D1 dry run exits 0 and says nothing was written', d.code === 0 && d.out.includes('DRY RUN — nothing was written.'), d.out.slice(-300));
  check('D2 dry run wrote NOTHING (profile + auth counts unchanged)', (await profileCount()) === pBefore && (await authCount()) === aBefore);
  check('D3 shows the resolved team lead and department head NAMES on the rows', d.out.includes(tl.full_name) && d.out.includes(dh.full_name));
  check('D4 summary: 2 would be created, 1 exists, 5 invalid', d.out.includes('2 would be CREATED, 1 already EXIST (untouched), 5 INVALID'), d.out.match(/Summary:.*/)?.[0]);
  check('D5 existing email is reported (not silently skipped) and left untouched', d.out.includes('profile already exists') && d.out.includes('left untouched'));
  check('D6 Gmail underscore row is flagged as a probable typo', d.out.includes('cannot be a real Gmail address'));
  check('D7 unresolvable team lead id reported', d.out.includes('is not a profile on'));
  check('D8 wrong-role team lead reported', d.out.includes('has role department_head, not team_lead'));
  check('D9 in-CSV duplicate reported', d.out.includes('duplicates CSV line 2'));
  check('D10 non-staff role reported', d.out.includes('this script only creates role=staff'));
  check('D11 report is grouped by team lead with a count', d.out.includes(`${tl.full_name}`) && /→\s+\d+ staff/.test(d.out));

  // ---------- 2. execute gates ----------
  const cred1 = join(tmp, 'cred1.csv');
  let g = run(['--csv', csv1, ...base, '--execute', '--credentials-out', cred1]);
  check('G1 --execute without --expect-create refuses', g.code === 1 && g.out.includes('needs --expect-create'));
  g = run(['--csv', csv1, ...base, '--execute', '--expect-create', '5', '--credentials-out', cred1]);
  check('G2 wrong --expect-create refuses (data differs from the reviewed dry run)', g.code === 1 && g.out.includes('a fresh read now says 2'));
  g = run(['--csv', csv1, ...base, '--execute', '--expect-create', '2', '--credentials-out', join(REPO, 'leak.csv')]);
  check('G3 credentials file INSIDE the repo is refused', g.code === 1 && g.out.includes('must be OUTSIDE the repository') && !existsSync(join(REPO, 'leak.csv')));
  g = run(['--csv', csv1, '--confirm-host', 'wrong.example.com', '--created-by', hr.id]);
  check('G4 wrong --confirm-host refuses', g.code === 1 && g.out.includes('does not match the target host'));
  g = run(['--csv', csv1, '--confirm-host', HOST, '--created-by', tl.id]);
  check('G5 --created-by that is not an admin refuses', g.code === 1 && g.out.includes('must be an ACTIVE admin or admin_hr'));
  check('G6 none of the refusals wrote anything', (await profileCount()) === pBefore && (await authCount()) === aBefore && !existsSync(cred1));

  // ---------- 3. real execute ----------
  const e1 = run(['--csv', csv1, ...base, '--execute', '--expect-create', '2', '--credentials-out', cred1]);
  const creds = existsSync(cred1) ? readFileSync(cred1, 'utf8').trim().split('\n') : [];
  check('E1 execute: 2 created, 0 failed, exit 0', e1.code === 0 && e1.out.includes('RESULT: 2 created, 0 failed, 1 already existed (untouched), 5 invalid (skipped).'), e1.out.slice(-500));
  check('E2 fresh-read verification passed for every created row', e1.out.includes('all created rows verified.'));
  check('E3 credentials file has header + 2 rows', creds.length === 3 && creds[0] === 'name,email,temporary_password', String(creds.length));
  const passwords = creds.slice(1).map((l) => l.split(',').pop());
  check('E4 generated passwords are NEVER printed', passwords.length === 2 && passwords.every((p) => p.length === 14 && !e1.out.includes(p)));
  for (const em of ['bulk-test-a' + DOMAIN, 'bulk-test-b' + DOMAIN]) createdEmails.add(em);
  const pa = await q('bulk-test-a' + DOMAIN);
  const { data: fullA } = await admin.from('profiles').select('role, must_change_password, location, active').eq('id', pa.id).single();
  const { data: oaA } = await admin.from('organizational_assignments').select('*').eq('staff_id', pa.id);
  check('E5 profile: role staff, must_change_password true, location as in CSV, active', fullA.role === 'staff' && fullA.must_change_password === true && fullA.location === 'MAIDUGURI' && fullA.active === true, JSON.stringify(fullA));
  check('E6 assignment: medical, right team lead + dept head, effective_to null, created_by = acting admin',
    oaA.length === 1 && oaA[0].department === 'medical' && oaA[0].team_lead_id === tl.id && oaA[0].department_head_id === dh.id && oaA[0].effective_to === null && oaA[0].created_by === hr.id, JSON.stringify(oaA));
  const anon = createClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const si = await anon.auth.signInWithPassword({ email: 'bulk-test-a' + DOMAIN, password: passwords[0] });
  check('E7 the generated password actually signs the new person in', !si.error && !!si.data.session, si.error?.message);
  check('E8 the invalid / existing rows created nothing', !(await q('bulk-test-c' + DOMAIN)) && !(await q('bulk-test-d' + DOMAIN)) && !(await q('bulk-test-g' + DOMAIN)));

  // ---------- 4. idempotency ----------
  const again = run(['--csv', csv1, ...base]);
  check('I1 second dry run: the two now EXIST (same name), 0 to create', again.out.includes('0 would be CREATED, 4 already EXIST') && again.out.includes('(same name)'), again.out.match(/Summary:.*/)?.[0]);
  const pMid = await profileCount();
  const again2 = run(['--csv', csv1, ...base, '--execute', '--expect-create', '0', '--credentials-out', join(tmp, 'cred2.csv')]);
  check('I2 second execute refuses ("nothing to create") and writes nothing', again2.code === 1 && again2.out.includes('nothing to create') && (await profileCount()) === pMid && !existsSync(join(tmp, 'cred2.csv')));

  // ---------- 5. one genuinely failing row does not stop the batch ----------
  // "-bad-" as a domain label passes the script's own format check but is
  // rejected by Supabase Auth at creation time, so this fails INSIDE
  // createStaffAccount (probed against dev: "Unable to validate email
  // address: invalid format").
  const badEmail = 'bulk-test-h@-bad-.test';
  const csv2 = writeCsv('two.csv', [
    row('Batch One', 'bulk-test-e' + DOMAIN),
    row('Batch Bad', badEmail),
    row('Batch Three', 'bulk-test-f' + DOMAIN),
  ]);
  const cred3 = join(tmp, 'cred3.csv');
  const f = run(['--csv', csv2, ...base, '--execute', '--expect-create', '3', '--credentials-out', cred3]);
  const bulkE = await q('bulk-test-e' + DOMAIN), bulkF = await q('bulk-test-f' + DOMAIN);
  check('F1 the failing row is reported as FAILED with its reason', f.out.includes('FAILED   Batch Bad') && f.out.includes('invalid format') && f.out.includes('needs a manual look: Batch Bad'), f.out.slice(-700));
  check('F2 the row BEFORE and the row AFTER it were both still created (batch not stopped)', !!bulkE && !!bulkF);
  check('F3 result line is 2 created, 1 failed and the exit code is 1', f.out.includes('RESULT: 2 created, 1 failed') && f.code === 1);
  const credLines = existsSync(cred3) ? readFileSync(cred3, 'utf8').trim().split('\n') : [];
  check('F4 credentials file lists exactly the 2 created people (not the failed one)', credLines.length === 3 && !credLines.join('\n').includes('-bad-'), String(credLines.length));
  check('F5 the failed row left no orphan login or profile behind',
    !(await q(badEmail)) && !(await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.some((u) => (u.email ?? '') === badEmail));

  // ---------- 6. reporting-line rule (20260926000000): Medical team lead optional ----------
  const csv3 = writeCsv('three.csv', [
    row('Direct Report', 'bulk-test-i' + DOMAIN, '', dh.id),                       // medical, no team lead  -> CREATE
    row('No Head', 'bulk-test-j' + DOMAIN, tl.id, ''),                             // medical, no dept head  -> INVALID
    row('Neither', 'bulk-test-k' + DOMAIN, '', ''),                                // medical, both blank    -> INVALID
    row('Ops None', 'bulk-test-l' + DOMAIN, '', '', { dept: 'operations' }),       // operations, both blank -> CREATE
    row('Ops Half', 'bulk-test-m' + DOMAIN, tl.id, '', { dept: 'operations' }),    // operations, one blank  -> INVALID
    row('Normal Med', 'bulk-test-n' + DOMAIN),                                     // medical, both set      -> CREATE (regression)
  ]);
  const pBefore3 = await profileCount(), aBefore3 = await authCount();
  const d3 = run(['--csv', csv3, ...base]);
  check('R1 dry run: 3 would be created (blank-TL medical, blank/blank operations, normal medical), 3 invalid', d3.out.includes('3 would be CREATED, 0 already EXIST (untouched), 3 INVALID'), d3.out.match(/Summary:.*/)?.[0]);
  check('R2 blank-team-lead Medical row shows "(none)" and the direct-report note, not a UUID error', d3.out.includes('no team lead: reports directly to the department head') && !d3.out.includes('team_lead_id is not a UUID'));
  check('R3 Medical with no department head is rejected with the medical message', d3.out.includes('Medical staff need a department head'));
  check('R4 Operations with exactly one blank is rejected with the pair message', d3.out.includes('Operations staff need either both a team lead and a department head, or neither.'));
  check('R5 report groups the blank-TL person under "NO TEAM LEAD"', d3.out.includes('NO TEAM LEAD (reports directly to the department head)'));
  check('R6 that dry run wrote nothing', (await profileCount()) === pBefore3 && (await authCount()) === aBefore3);
  const cred4 = join(tmp, 'cred4.csv');
  const e3 = run(['--csv', csv3, ...base, '--execute', '--expect-create', '3', '--credentials-out', cred4]);
  for (const em of ['i', 'l', 'n']) createdEmails.add('bulk-test-' + em + DOMAIN);
  check('R7 execute: 3 created, 0 failed, every row passes the fresh-read verification (blank compared as NULL)', e3.code === 0 && e3.out.includes('RESULT: 3 created, 0 failed') && e3.out.includes('all created rows verified.'), e3.out.slice(-600));
  const pI = await q('bulk-test-i' + DOMAIN), pL = await q('bulk-test-l' + DOMAIN), pN = await q('bulk-test-n' + DOMAIN);
  const oa = async (p) => (await admin.from('organizational_assignments').select('department, team_lead_id, department_head_id, effective_to').eq('staff_id', p.id)).data;
  const [oI, oL, oN] = [await oa(pI), await oa(pL), await oa(pN)];
  check('R8 blank-TL Medical: assignment medical, team_lead_id NULL, department_head_id = dh', oI.length === 1 && oI[0].department === 'medical' && oI[0].team_lead_id === null && oI[0].department_head_id === dh.id && oI[0].effective_to === null, JSON.stringify(oI));
  check('R9 Operations blank/blank: both NULL (unchanged behaviour)', oL.length === 1 && oL[0].department === 'operations' && oL[0].team_lead_id === null && oL[0].department_head_id === null, JSON.stringify(oL));
  check('R10 normal Medical (both set): unchanged - both ids stored', oN.length === 1 && oN[0].team_lead_id === tl.id && oN[0].department_head_id === dh.id, JSON.stringify(oN));
  check('R11 the invalid rows created nothing', !(await q('bulk-test-j' + DOMAIN)) && !(await q('bulk-test-k' + DOMAIN)) && !(await q('bulk-test-m' + DOMAIN)));
} finally {
  await cleanup();
  const { data: left } = await admin.from('profiles').select('id').like('email', 'bulk-test-%');
  const users = (await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.filter((u) => (u.email ?? '').startsWith('bulk-test-'));
  check('Z1 cleanup: zero bulk-test fixtures left (profiles + logins)', (left?.length ?? 0) === 0 && users.length === 0, `${left?.length} profiles, ${users.length} logins`);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass}/${pass + failn} passed`);
  process.exitCode = failn ? 1 : 0;
}
