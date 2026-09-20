# Production bootstrap — prepared, NOT applied

Standing up Kalthum's own Supabase project + Vercel deployment from this repo.
Nothing here has been run against production; no production project exists yet.
Everything below was checked against the repo and the dev project as of 2026-09-19.

## 0. Hazards to avoid

- **This checkout is linked to the DEV project** (`supabase/.temp/project-ref`,
  local, gitignored). `npx supabase db push` here targets dev until you re-link.
  Confirm with `npx supabase projects list` (the linked project is marked) before
  every push, secret change or function deploy.
- **Never put production values in `.env` / `.env.local`.** Every `scripts/*.mjs`
  except `bootstrap-first-admin.mjs` reads `.env` and would act on production —
  several create fixture accounts with a hardcoded dev password. Production values
  live only in the Vercel dashboard and in the shell for one-off commands.
- Do **not** run `create-ui-test-users.mjs` or any `test-*.mjs` against production.
- **Schema before code.** The app now reads/writes `profiles.must_change_password`;
  deploying it against a database without that column breaks sign-in pages. Apply
  migrations first, deploy Vercel second.

## 1. Database (in this order)

1. Create the Supabase project in **Kalthum's own account**. Note the project ref
   and the database password.
2. `npx supabase login`
3. `npx supabase link --project-ref <prod-ref>` (asks for the DB password)
4. `npx supabase migration list` — expect all 28 local files, none applied remotely.
5. `npx supabase db push --dry-run` — expect exactly those 28, oldest first.
6. `npx supabase db push`
7. Verify in the SQL editor: 8 tables in `public`; `select count(*) from public_holidays`
   = **16**; `select count(*) from profiles` = **0** and `auth.users` empty.

The migrations create no accounts, no timesheets, no fixtures. The national-holiday
seed is one of them. The last five (2026-09-19/20) add `must_change_password`, the
org-holiday delete policy, the email trigger (inert until §2's Vault secrets exist), the
decline notification to staff, and a distinct subject for the "it is back with you" email
(both below).

## 2. Email (Resend + Edge Function) — do this before the first real user

The database queues an email for every notification; the `send-notification-email`
Edge Function sends it through Resend and records `notifications.email_sent_at`.
**Email is best-effort and can never fail a workflow action** (proved: see the
verification summary in CLAUDE.md). The in-app notification is the source of truth.

1. Resend: create/own the account, create an API key ("sending access" is enough).
2. Choose a webhook secret: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
3. Function secrets (Supabase project → Edge Functions → Secrets, or CLI):

   | Secret | Production value | Notes |
   | --- | --- | --- |
   | `RESEND_API_KEY` | the key from step 1 | |
   | `EMAIL_WEBHOOK_SECRET` | the secret from step 2 | must equal the Vault value below |
   | `EMAIL_MODE` | `live` | **unset = the function refuses to send** (fail-closed) |
   | `EMAIL_FROM` | `Kalthum Timesheet <timesheet@kalthum4peace.org>` | must be on a **verified** domain |
   | `APP_URL` | `https://timesheet.kalthum4peace.org` | used for the "Open" button |
   | `KFP_SUPABASE_URL` | `https://<prod-ref>.supabase.co` | |
   | `KFP_SUPABASE_SECRET_KEY` | the production **secret** key | custom names: `SUPABASE_*` is reserved |
   | `EMAIL_REDIRECT_TO` | **do not set in production** | dev-only; see below |

   `npx supabase secrets set --project-ref <prod-ref> NAME=value ...`
4. Deploy: `npx supabase functions deploy send-notification-email --no-verify-jwt --project-ref <prod-ref>`
   (`--no-verify-jwt` is required: the caller is the database trigger and authenticates
   with `EMAIL_WEBHOOK_SECRET`; the newer API keys aren't JWTs the gateway can verify.)
5. Vault (SQL editor of the production project, once):
   ```sql
   select vault.create_secret('https://<prod-ref>.supabase.co/functions/v1/send-notification-email', 'email_function_url');
   select vault.create_secret('<the same webhook secret>', 'email_function_secret');
   ```
   Until both exist the trigger silently does nothing.
6. Live check: with a real address on a test account, submit a timesheet and confirm
   the approver's email arrives and `notifications.email_sent_at` is set.

### What changes when kalthum4peace.org is verified in Resend (config only, no code)

Development runs on Resend's sandbox sender (`onboarding@resend.dev`), which can only
deliver to the Resend account owner's own address, so dev uses **redirect mode**:
`EMAIL_MODE=redirect` + `EMAIL_REDIRECT_TO=<owner address>` sends every email to that
one address with a "redirected from …" banner. Going live is exactly:

1. In Resend, add `kalthum4peace.org`, add the DNS records Resend shows (SPF/DKIM
   TXT/CNAME) and wait for "verified". **Never edit the root domain's MX records**
   (existing staff email must keep working); read each record before adding it.
2. In Resend's domain settings, **turn off open and click tracking**. Observed in dev:
   with tracking on, Resend rewrites the "Open" link through a third-party redirect
   domain and adds a hidden pixel; not wanted for an internal HR system.
3. `supabase secrets set EMAIL_FROM="Kalthum Timesheet <timesheet@kalthum4peace.org>" EMAIL_MODE=live APP_URL=https://timesheet.kalthum4peace.org`
   and `supabase secrets unset EMAIL_REDIRECT_TO`.

No redeploy, no migration, no code change; the function reads its config on every request.

### If emails ever fail

Failures leave `email_sent_at` null and log in the function's logs. To re-send recent
ones: `POST` to the function URL with header `x-webhook-secret: <secret>` and body
`{"sweep":true}` (retries up to 25 notifications from the last 48 h that were never
emailed). Nothing runs this automatically; scheduling it (pg_cron) is a possible later
addition.

Notification types the workflow actually *generates*: `approval_required`, `returned`,
`declined`, `final_approval`. The other four in the enum (`submission`, `approved`,
`return_acknowledged`, `resubmitted`) are defined but never inserted. The email
pipeline handles all eight with no per-type code.

**What staff receive when a timesheet is declined** (migration `20260919030000`):
- multi-hop chain (e.g. Medical, HR declines): an immediate `declined` email ("Timesheet
  declined by HR": who, stage, the comment, "you'll get another email when it reaches
  you"), then a `returned` email at the moment the return actually reaches them and they can
  edit, subject "Your timesheet is back with you — please correct and resubmit" (migration
  `20260920000000`; the body is the original "review the comment, make corrections, and
  resubmit" copy);
- short chain (declined at the lowest step, nothing to acknowledge): ONE `declined` email,
  worded "it has come straight back to you — correct and resubmit".

## 3. First account (nothing in the app can create it)

Add Staff needs an existing admin, and RLS only lets an admin/admin_hr insert
profiles, so the first account comes from outside the app:

```powershell
$env:KFP_SUPABASE_URL = "https://<prod-ref>.supabase.co"
$env:KFP_SUPABASE_SECRET_KEY = "<secret key>"
node scripts/bootstrap-first-admin.mjs --confirm-host <prod-ref>.supabase.co `
     --role <admin_hr|admin> --email <address> --name "<full name>" --location <city>
Remove-Item Env:KFP_SUPABASE_SECRET_KEY
```

It refuses unless the project has **zero** profiles, the typed host matches, and the
role is given explicitly. It never reads `.env`. The password is generated and shown
once, and the account is created with `must_change_password = true`, so the first
sign-in is forced onto a "set your new password" screen (as is every account created
later with Add Staff). Alternative with no code: create the user in the dashboard
(auto-confirm), then one `insert into profiles (id, full_name, email, location, role)
values (...)` in the SQL editor (the column defaults to `true`).

## 4. Vercel environment variables — exactly three

Set in Vercel → Production. The app code reads nothing else.

| Variable | Value | Exposure |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | project URL `https://<ref>.supabase.co` | public (bundled) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the project's **publishable** key (`sb_publishable_…`) | public by design |
| `SUPABASE_SERVICE_ROLE_KEY` | the project's **secret** key (`sb_secret_…`) | **server-only**, never `NEXT_PUBLIC_` |

The two key variables keep their historical names but hold the new key types.
(The Edge Function's secrets in §2 are separate and live in Supabase, not Vercel.)

## 5. Supabase dashboard settings (not carried by migrations)

Names below are from memory of the dashboard; confirm each in the UI.

- [ ] **Shorten the JWT expiry** (Project Settings → JWT / Auth). *Manual, one-time,
  dashboard-only; no code involved.* Measured on dev: a deactivated user is blocked
  from sign-in, token refresh and `getUser()` immediately, but an access token that
  was already issued keeps working against the database until it expires (default
  1 hour). A shorter expiry narrows that window; decide the value with the client.
- [ ] Turn **off** open sign-ups. Accounts are only ever made by the admin API.
- [ ] Set **Site URL** to `https://timesheet.kalthum4peace.org`.
- [ ] Email/SMTP for *Supabase Auth's own* emails (password reset etc.) is separate from
  the notification email above and isn't used yet; nothing sends Auth emails today.

## 6. After the first account exists

Create people with Admin → Staff → Add staff member. **Before anyone can submit a
timesheet, exactly one active SPM and exactly one active HR-position account
(`hr` or `admin_hr`) must exist**; chain generation hard-fails otherwise. Then
team leads and department heads, then staff (a staff member needs both). Then
Admin → Public holidays: add the moveable Islamic holidays once officially announced.

Domain: add `timesheet.kalthum4peace.org` in Vercel and create the DNS record it
asks for. Do not touch MX records.

## 7. Open decisions / known gaps

1. **Who is the first account, and which role?** `admin_hr` if the HR person is
   also the administrator; `admin` if a technical administrator goes first (HR is
   then created next as `admin_hr`). Only one active HR-position account can exist.
2. **Deactivation is blocked while a person has live work** (timesheets waiting on
   them, or current team lead / department head of active staff). There is no
   reassign-reporting-line screen yet (PROJECT_CONTEXT §7 lists it as an admin
   capability), so such a person can't be deactivated from the app until one exists.
3. Reactivation isn't built (the login ban is reversible: `ban_duration: "none"`).
4. **No forgot-password flow.** Change-password exists (forced at first sign-in and in
   the header), but a user who forgets their password needs an admin. Forgot-password
   needs Auth SMTP + redirect URLs configured (§5).
5. The mandatory password change is an **app-level gate**, not a database boundary:
   a gated user talking to the API directly with their own token can still do whatever
   their role already allows. What it guarantees is that the temporary password (known
   to the admin who created it) stops being a working credential after first sign-in.
6. Deleting an org holiday does not change days staff have already saved as PH.
