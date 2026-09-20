// One-time bootstrap of the FIRST admin account on a brand-new, empty
// Supabase project. Admin creates staff (Add Staff), and RLS only lets an
// existing admin/admin_hr insert profiles — so the very first account has to
// come from outside the app. This is that outside path.
//
// DELIBERATELY UNLIKE the dev scripts in this folder, which read .env (and so
// would silently act on whatever project .env points at):
//   - it reads KFP_SUPABASE_URL / KFP_SUPABASE_SECRET_KEY from the SHELL
//     ENVIRONMENT only — it never opens .env, and the names differ from the
//     app's own variables so an ambient dev value can't be inherited by accident
//   - --confirm-host must equal the URL's host, re-typed by hand
//   - it refuses to run if ANY profile already exists (it cannot be used to
//     add a second account, or to run against dev by mistake)
//   - --role has no default: admin_hr (the HR person is also the admin) vs
//     admin (a technical administrator with no timesheet chain of its own) is
//     a decision for the organisation, not for this script
//
// The password is generated (20 random chars) and printed ONCE, unless
// KFP_BOOTSTRAP_PASSWORD is set. The account is created with
// must_change_password = true: the first sign-in is forced to a new password.
//
// PowerShell:
//   $env:KFP_SUPABASE_URL = "https://<prod-ref>.supabase.co"
//   $env:KFP_SUPABASE_SECRET_KEY = "<secret key>"
//   node scripts/bootstrap-first-admin.mjs --confirm-host <prod-ref>.supabase.co `
//        --role admin_hr --email person@kalthum4peace.org --name "Full Name" --location Yola
//   Remove-Item Env:KFP_SUPABASE_SECRET_KEY

import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';

// fail() throws rather than calling process.exit(): on Node/Windows, exiting
// while an HTTP request's handles are still closing trips a libuv assertion
// and the exit code comes out as 127 instead of 1.
class Refusal extends Error {}
const fail = (msg) => {
  throw new Refusal(msg);
};

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i];
    if (!k?.startsWith('--') || process.argv[i + 1] === undefined) fail(`bad or incomplete argument near "${k ?? ''}"`);
    args[k.slice(2)] = process.argv[i + 1];
  }
  for (const req of ['confirm-host', 'role', 'email', 'name', 'location']) {
    if (!args[req]) fail(`missing --${req}`);
  }
  if (!['admin_hr', 'admin'].includes(args.role)) fail('--role must be admin_hr or admin');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.email)) fail('--email does not look like an email address');

  const url = process.env.KFP_SUPABASE_URL;
  const key = process.env.KFP_SUPABASE_SECRET_KEY;
  if (!url || !key) fail('set KFP_SUPABASE_URL and KFP_SUPABASE_SECRET_KEY in the shell (this script never reads .env)');

  let host;
  try {
    host = new URL(url).host;
  } catch {
    fail('KFP_SUPABASE_URL is not a valid URL');
  }
  if (args['confirm-host'] !== host) {
    fail(`--confirm-host "${args['confirm-host']}" does not match the target host "${host}"`);
  }

  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { count, error: countError } = await admin.from('profiles').select('id', { count: 'exact', head: true });
  if (countError) fail(`could not read profiles on ${host} — have the migrations been applied? (${countError.message})`);
  if (count !== 0) fail(`${host} already has ${count} profile(s). This script only bootstraps an EMPTY project.`);

  const password = process.env.KFP_BOOTSTRAP_PASSWORD || randomBytes(15).toString('base64url');
  if (password.length < 12) fail('password must be at least 12 characters');

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: args.email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) fail(`could not create the login: ${createError?.message}`);

  const { error: profileError } = await admin.from('profiles').insert({
    id: created.user.id,
    full_name: args.name,
    email: args.email,
    location: args.location,
    role: args.role,
    must_change_password: true, // generated password is shown once; force a real one at first sign-in
  });
  if (profileError) {
    await admin.auth.admin.deleteUser(created.user.id);
    fail(`could not create the profile (login rolled back): ${profileError.message}`);
  }

  console.log(`\nFirst account created on ${host}`);
  console.log(`  id:       ${created.user.id}`);
  console.log(`  email:    ${args.email}`);
  console.log(`  role:     ${args.role}`);
  if (!process.env.KFP_BOOTSTRAP_PASSWORD) console.log(`  password: ${password}   (shown once — hand it over out-of-band)`);
  console.log('\nNext: sign in, then use Admin -> Add staff member for everyone else.');
}

try {
  await main();
} catch (e) {
  if (e instanceof Refusal) console.error(`\nREFUSING: ${e.message}\nNothing was changed.`);
  else console.error('\nUNEXPECTED ERROR:', e);
  process.exitCode = 1;
}
