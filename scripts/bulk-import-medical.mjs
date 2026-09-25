// One-time bulk onboarding of Medical staff from a CSV.
//
// Creates each person through lib/createStaff.ts -> createStaffAccount, the
// SAME function the Add Staff form's server action calls, so every rule that
// applies to a person added by hand applies here: auth user + profile
// (must_change_password = true) + organizational_assignments row
// (effective_from = today, effective_to = null), with the auth user rolled
// back if a later insert fails. No SQL is written here.
//
// SAFE BY DEFAULT: without --execute this is a DRY RUN. It performs reads
// only, and prints exactly what would be created, with the team lead's and
// department head's NAMES resolved from the live database next to each row.
//
// Like scripts/bootstrap-first-admin.mjs, and unlike the dev scripts, it
// NEVER reads .env: the target comes from KFP_SUPABASE_URL /
// KFP_SUPABASE_SECRET_KEY in the shell, and --confirm-host must equal the
// URL's host, re-typed by hand.
//
// CSV columns: Name, Email, Position, Location, role, department,
// team_lead_id, department_head_id.
//   Position has no home: profiles has no position / job-title column and the
//   Add Staff form has no such field. It is shown in the report so nothing is
//   lost from view, but it is NOT stored.
//   Location is stored exactly as written in the CSV.
//
// Usage (PowerShell):
//   $env:KFP_SUPABASE_URL = "https://<ref>.supabase.co"
//   $env:KFP_SUPABASE_SECRET_KEY = "<secret key>"
//
//   # 1. dry run (reads only)
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/bulk-import-medical.mjs `
//        --csv <file.csv> --confirm-host <ref>.supabase.co --created-by <admin profile uuid>
//
//   # 2. only after reviewing the dry run, and on explicit go-ahead
//   node ... same arguments ... --execute --expect-create <N from the dry run> `
//        --credentials-out <path OUTSIDE the repo>.csv
//
//   Remove-Item Env:KFP_SUPABASE_SECRET_KEY
//
// --created-by is the profile id recorded as created_by on each assignment
// (the form records the signed-in admin). It must be an active admin/admin_hr.
//
// Temporary passwords are generated per person and written ONLY to
// --credentials-out (created new, never overwritten, appended and flushed
// after every successful row so a crash mid-batch still leaves the passwords
// for the accounts that exist). They are never printed. Each account is
// forced to choose a new password at first sign-in.
//
// One bad row never stops the batch: every row is attempted and reported.
// Re-running is safe: a row whose email already exists is reported as EXISTS
// and never touched or overwritten.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { createStaffAccount } from '../lib/createStaff.ts';

class Refusal extends Error {}
const fail = (msg) => {
  throw new Refusal(msg);
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EXPECTED_HEADER = ['Name', 'Email', 'Position', 'Location', 'role', 'department', 'team_lead_id', 'department_head_id'];
const ADMIN_ROLES = ['admin', 'admin_hr'];
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // no 0/O/1/l/I
const genPassword = () => Array.from({ length: 14 }, () => PW_ALPHABET[randomInt(PW_ALPHABET.length)]).join('');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k?.startsWith('--')) fail(`unexpected argument "${k}"`);
    const name = k.slice(2);
    if (name === 'execute') {
      args.execute = true;
      continue;
    }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) fail(`--${name} needs a value`);
    args[name] = argv[++i];
  }
  return args;
}

// Minimal RFC-4180 CSV parser (quotes, doubled quotes, CRLF, BOM).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

async function readAll(admin) {
  const { data: profiles, error: pErr } = await admin
    .from('profiles')
    .select('id, full_name, email, role, active, location, created_at');
  if (pErr) fail(`could not read profiles: ${pErr.message}`);

  const authUsers = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) fail(`could not list auth users: ${error.message}`);
    authUsers.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return { profiles, authUsers };
}

async function main() {
  const args = parseArgs(process.argv);
  for (const req of ['csv', 'confirm-host', 'created-by']) if (!args[req]) fail(`missing --${req}`);
  if (!UUID_RE.test(args['created-by'])) fail('--created-by is not a UUID');
  if (args.execute) {
    if (!args['expect-create']) fail('--execute needs --expect-create <N> (the "would create" count from the dry run you reviewed)');
    if (!args['credentials-out']) fail('--execute needs --credentials-out <path> for the temporary passwords');
    if (!/^\d+$/.test(args['expect-create'])) fail('--expect-create must be a whole number');
  }

  // ---- CSV -> rows (no network yet) ----
  const table = parseCsv(readFileSync(args.csv, 'utf8'));
  if (table.length === 0) fail('CSV is empty');
  const header = table[0].map((h) => h.trim());
  if (JSON.stringify(header) !== JSON.stringify(EXPECTED_HEADER)) {
    fail(`CSV header must be exactly: ${EXPECTED_HEADER.join(',')}\n           got:                  ${header.join(',')}`);
  }
  const rows = table.slice(1).map((cells, i) => {
    if (cells.length !== EXPECTED_HEADER.length) fail(`CSV line ${i + 2} has ${cells.length} fields, expected ${EXPECTED_HEADER.length}`);
    const [name, email, position, location, role, department, teamLeadId, departmentHeadId] = cells.map((c) => c.trim());
    return {
      line: i + 2,
      name: name.replace(/\s+/g, ' '),
      email: email.toLowerCase(),
      position,
      location,
      role,
      department,
      teamLeadId: teamLeadId.toLowerCase(),
      departmentHeadId: departmentHeadId.toLowerCase(),
    };
  });

  // ---- target ----
  const url = process.env.KFP_SUPABASE_URL;
  const key = process.env.KFP_SUPABASE_SECRET_KEY;
  if (!url || !key) fail('set KFP_SUPABASE_URL and KFP_SUPABASE_SECRET_KEY in the shell (this script never reads .env)');
  let host;
  try {
    host = new URL(url).host;
  } catch {
    fail('KFP_SUPABASE_URL is not a valid URL');
  }
  if (args['confirm-host'] !== host) fail(`--confirm-host "${args['confirm-host']}" does not match the target host "${host}"`);
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  // ---- fresh read of the live data ----
  const { profiles, authUsers } = await readAll(admin);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const byEmail = new Map(profiles.map((p) => [p.email.toLowerCase(), p]));
  const authByEmail = new Map(authUsers.map((u) => [(u.email ?? '').toLowerCase(), u]));

  console.log(`\nTarget: ${host}   mode: ${args.execute ? 'EXECUTE' : 'DRY RUN (nothing is written)'}`);
  console.log(`Read ${profiles.length} profile(s) and ${authUsers.length} auth login(s). CSV rows: ${rows.length}\n`);

  // ---- preflight ----
  const actor = byId.get(args['created-by']);
  if (!actor) fail(`--created-by ${args['created-by']} is not a profile on ${host}`);
  if (!ADMIN_ROLES.includes(actor.role) || !actor.active) {
    fail(`--created-by is "${actor.full_name}" (role ${actor.role}, active ${actor.active}); it must be an ACTIVE admin or admin_hr`);
  }
  console.log(`Acting admin (created_by): ${actor.full_name} <${actor.email}> [${actor.role}]`);
  const activeSpm = profiles.filter((p) => p.role === 'spm' && p.active).length;
  const activeHr = profiles.filter((p) => ['hr', 'admin_hr'].includes(p.role) && p.active).length;
  console.log(`Chain-generation preconditions: active SPM = ${activeSpm} (need exactly 1), active HR-position = ${activeHr} (need exactly 1)`);
  const chainWarn = activeSpm !== 1 || activeHr !== 1;
  if (chainWarn) console.log('  !! WARNING: staff created now could not SUBMIT timesheets until this is fixed.');

  // ---- per-row evaluation ----
  const seenEmails = new Map();
  const evalRow = (r) => {
    const problems = [];
    const notes = [];
    if (!r.name) problems.push('Name is empty');
    if (!r.email) problems.push('Email is empty');
    else if (!EMAIL_RE.test(r.email)) problems.push(`Email "${r.email}" is not a valid address`);
    else if (/@(gmail|googlemail)\.com$/.test(r.email) && !/^[a-z0-9]/.test(r.email)) {
      problems.push(`Email "${r.email}" cannot be a real Gmail address (Gmail addresses cannot start with "${r.email[0]}") — probable typo; correct the CSV`);
    }
    if (!r.location) problems.push('Location is empty');
    if (r.role !== 'staff') problems.push(`role is "${r.role}", this script only creates role=staff`);
    if (!['medical', 'operations'].includes(r.department)) problems.push(`department "${r.department}" is not medical/operations`);

    if (r.email) {
      if (seenEmails.has(r.email)) problems.push(`Email duplicates CSV line ${seenEmails.get(r.email)}`);
      else seenEmails.set(r.email, r.line);
    }

    const tl = UUID_RE.test(r.teamLeadId) ? byId.get(r.teamLeadId) : undefined;
    const dh = UUID_RE.test(r.departmentHeadId) ? byId.get(r.departmentHeadId) : undefined;
    if (!UUID_RE.test(r.teamLeadId)) problems.push('team_lead_id is not a UUID');
    else if (!tl) problems.push(`team_lead_id ${r.teamLeadId} is not a profile on ${host}`);
    else {
      if (tl.role !== 'team_lead') problems.push(`team lead "${tl.full_name}" has role ${tl.role}, not team_lead`);
      if (!tl.active) problems.push(`team lead "${tl.full_name}" is not active`);
      if (tl.location && r.location && tl.location.trim().toLowerCase() !== r.location.trim().toLowerCase()) {
        notes.push(`location differs from team lead's (${tl.location})`);
      }
    }
    if (!UUID_RE.test(r.departmentHeadId)) problems.push('department_head_id is not a UUID');
    else if (!dh) problems.push(`department_head_id ${r.departmentHeadId} is not a profile on ${host}`);
    else {
      if (dh.role !== 'department_head') problems.push(`department head "${dh.full_name}" has role ${dh.role}, not department_head`);
      if (!dh.active) problems.push(`department head "${dh.full_name}" is not active`);
    }

    let status = 'CREATE';
    const existingProfile = byEmail.get(r.email);
    const existingAuth = authByEmail.get(r.email);
    if (existingProfile) {
      status = 'EXISTS';
      notes.length = 0;
      notes.push(
        `profile already exists: "${existingProfile.full_name}" [${existingProfile.role}, ${existingProfile.active ? 'active' : 'inactive'}]` +
          (existingProfile.full_name.trim().toLowerCase() === r.name.toLowerCase() ? ' (same name)' : ' (DIFFERENT NAME)') +
          ' — left untouched',
      );
    } else if (existingAuth) {
      status = 'EXISTS';
      notes.length = 0;
      notes.push('an auth login with this email exists but has NO profile (orphan) — left untouched, needs a manual look');
    } else if (problems.length) status = 'INVALID';
    return { ...r, tl, dh, problems, notes, status };
  };
  const evaluated = rows.map(evalRow);

  // ---- report ----
  console.log('\n' + '='.repeat(150));
  console.log(
    ['#'.padEnd(3), clip('Name', 26), clip('Email', 34), clip('Position', 18), clip('Location', 13), clip('Team lead', 24), clip('Dept head', 22), 'Status'].join(' '),
  );
  console.log('-'.repeat(150));
  for (const e of evaluated) {
    console.log(
      [
        String(e.line - 1).padEnd(3),
        clip(e.name, 26),
        clip(e.email, 34),
        clip(e.position, 18),
        clip(e.location, 13),
        clip(e.tl ? e.tl.full_name : '??? ' + e.teamLeadId.slice(0, 8), 24),
        clip(e.dh ? e.dh.full_name : '??? ' + e.departmentHeadId.slice(0, 8), 22),
        e.status,
      ].join(' '),
    );
    for (const p of e.problems) console.log(`       ✗ ${p}`);
    for (const n of e.notes) console.log(`       · ${n}`);
  }
  console.log('='.repeat(150));

  const groups = new Map();
  for (const e of evaluated) {
    const k = e.tl ? `${e.tl.full_name} (${e.tl.location}) — ${e.teamLeadId}` : `UNRESOLVED ${e.teamLeadId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  console.log('\nTeam assignments, grouped by team lead:');
  for (const [k, list] of groups) {
    console.log(`  ${k}   →  ${list.length} staff`);
    for (const e of list) console.log(`       ${e.status === 'CREATE' ? '+' : e.status === 'EXISTS' ? '=' : 'x'} ${e.name}  [${e.position}, ${e.location}]`);
  }
  const dhs = new Set(evaluated.map((e) => e.dh?.full_name ?? '???'));
  console.log(`\nDepartment head(s) used: ${[...dhs].join(', ')}`);

  const count = (s) => evaluated.filter((e) => e.status === s).length;
  const toCreate = evaluated.filter((e) => e.status === 'CREATE');
  console.log(`\nSummary: ${toCreate.length} would be CREATED, ${count('EXISTS')} already EXIST (untouched), ${count('INVALID')} INVALID (would be skipped).`);
  console.log('Each created person gets: login + profile (role staff, must_change_password=true, location as in CSV, Position NOT stored)');
  console.log('  + organizational_assignments row (department, team lead, department head, effective_from = today, effective_to = null).');

  if (!args.execute) {
    console.log('\nDRY RUN — nothing was written.');
    return;
  }

  // ---- execute gates ----
  if (Number(args['expect-create']) !== toCreate.length) {
    fail(`--expect-create ${args['expect-create']} but a fresh read now says ${toCreate.length} would be created. The data changed since your dry run; re-run the dry run.`);
  }
  if (toCreate.length === 0) fail('nothing to create');
  const repoRoot = resolve(import.meta.dirname, '..');
  const credPath = resolve(args['credentials-out']);
  const rel = relative(repoRoot, credPath);
  if (!rel.startsWith('..') && !isAbsolute(rel)) fail(`--credentials-out must be OUTSIDE the repository (${repoRoot}) so passwords are never committed`);
  const fd = openSync(credPath, 'wx'); // wx: refuses to overwrite an existing file
  writeSync(fd, 'name,email,temporary_password\n');
  fsyncSync(fd);
  console.log(`\nExecuting against ${host}. Temporary passwords are being written to ${credPath} (not printed).`);

  const outcomes = [];
  for (const e of toCreate) {
    const password = genPassword();
    let res;
    try {
      res = await createStaffAccount(
        admin,
        {
          fullName: e.name,
          email: e.email,
          location: e.location,
          role: 'staff',
          password,
          department: e.department,
          teamLeadId: e.teamLeadId,
          departmentHeadId: e.departmentHeadId,
        },
        args['created-by'],
      );
    } catch (err) {
      res = { ok: false, error: 'unexpected error: ' + (err?.message ?? String(err)) };
    }
    if (res.ok) {
      writeSync(fd, `"${e.name.replace(/"/g, '""')}",${e.email},${password}\n`);
      fsyncSync(fd);
      console.log(`  CREATED  ${e.name}  <${e.email}>  ${res.userId}`);
    } else {
      console.log(`  FAILED   ${e.name}  <${e.email}>  — ${res.error}`);
    }
    outcomes.push({ e, res });
  }
  closeSync(fd);

  // ---- verify what was written, from a fresh read ----
  const after = await readAll(admin);
  const afterByEmail = new Map(after.profiles.map((p) => [p.email.toLowerCase(), p]));
  const afterAuth = new Map(after.authUsers.map((u) => [(u.email ?? '').toLowerCase(), u]));
  const today = new Date().toISOString().slice(0, 10);
  console.log('\nVerifying every created row from a fresh read:');
  let verifyProblems = 0;
  for (const { e, res } of outcomes) {
    const p = afterByEmail.get(e.email);
    if (!res.ok) {
      if (!p && afterAuth.has(e.email)) {
        console.log(`  !! ORPHAN  ${e.email}: a login exists with no profile after the failure — needs a manual look`);
        verifyProblems++;
      } else if (p) {
        console.log(`  !! ${e.email}: reported FAILED but a profile exists — needs a manual look`);
        verifyProblems++;
      }
      continue;
    }
    const { data: oa, error: oaErr } = await admin
      .from('organizational_assignments')
      .select('department, team_lead_id, department_head_id, effective_from, effective_to, created_by')
      .eq('staff_id', res.userId);
    const { data: pf } = await admin.from('profiles').select('role, must_change_password, location, active').eq('id', res.userId).single();
    const a = oa?.[0];
    const good =
      !oaErr && oa?.length === 1 && a.department === e.department && a.team_lead_id === e.teamLeadId && a.department_head_id === e.departmentHeadId &&
      a.effective_to === null && a.effective_from === today && a.created_by === args['created-by'] &&
      pf?.role === 'staff' && pf?.must_change_password === true && pf?.active === true && pf?.location === e.location;
    if (!good) {
      console.log(`  !! MISMATCH  ${e.email}: ${JSON.stringify({ oa, pf })}`);
      verifyProblems++;
    }
  }
  console.log(verifyProblems === 0 ? '  all created rows verified.' : `  ${verifyProblems} problem(s) above.`);

  const ok = outcomes.filter((o) => o.res.ok).length;
  const bad = outcomes.filter((o) => !o.res.ok);
  console.log(`\nRESULT: ${ok} created, ${bad.length} failed, ${count('EXISTS')} already existed (untouched), ${count('INVALID')} invalid (skipped).`);
  for (const o of bad) console.log(`  needs a manual look: ${o.e.name} <${o.e.email}> — ${o.res.error}`);
  for (const e of evaluated.filter((x) => x.status === 'INVALID')) console.log(`  skipped (invalid): ${e.name} <${e.email}> — ${e.problems.join('; ')}`);
  console.log(`Passwords for the ${ok} created account(s): ${credPath}  — hand them over out-of-band, then delete that file.`);
  if (bad.length || verifyProblems) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  if (e instanceof Refusal) console.error(`\nREFUSING: ${e.message}\nNothing was changed.`);
  else console.error('\nUNEXPECTED ERROR:', e);
  process.exitCode = 1;
}
