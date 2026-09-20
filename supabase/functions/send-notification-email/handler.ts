// Core of the send-notification-email Edge Function, kept free of Deno- and
// Supabase-specific imports so the exact same code runs under the Supabase
// Edge runtime (via index.ts) and under Node in scripts/test-email-function.mjs
// with fakes. Erasable TypeScript only (no enums / parameter properties).
//
// Contract (called by the notifications INSERT trigger through pg_net):
//   POST, header  x-webhook-secret: <EMAIL_WEBHOOK_SECRET>
//   body          {"notification_id": "<uuid>"}   send one
//                 {"sweep": true}                 retry recent unsent ones
//
// The in-app notification row is the source of truth (PROJECT_CONTEXT §22).
// Nothing here can fail the workflow that created the row: the caller is a
// fire-and-forget background request, and this function only ever WRITES
// notifications.email_sent_at.

export type NotificationRow = {
  id: string;
  type: string;
  title: string;
  message: string;
  timesheet_id: string | null;
  email_sent_at: string | null;
  recipient: { id: string; email: string; full_name: string; active: boolean } | null;
  timesheet: { staff_id: string; month: number; year: number; staff_name: string | null } | null;
};

export interface Db {
  getNotification(id: string): Promise<NotificationRow | null>;
  listUnsentIds(limit: number, sinceIso: string): Promise<string[]>;
  markSent(id: string, atIso: string): Promise<void>;
}

export type MailMessage = { from: string; to: string; subject: string; html: string; text: string; idempotencyKey: string };
export type MailResult = { ok: true; id: string } | { ok: false; status?: number; error: string };
export interface Mailer {
  send(msg: MailMessage): Promise<MailResult>;
}

export type Config = {
  webhookSecret: string | undefined;
  // 'redirect' = every email goes to redirectTo (dev/staging); 'live' = real
  // recipients. Anything else, including unset, REFUSES to send — a project
  // that forgot to choose must not email real people by accident.
  mode: string | undefined;
  redirectTo: string | undefined;
  from: string | undefined;
  appUrl: string | undefined;
};

export type Deps = { db: Db; mailer: Mailer; config: Config; sleep?: (ms: number) => Promise<void>; now?: () => Date };

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Where the "Open" button goes. Mirrors the app's own routes: approvers act
// on /approvals/<id> and acknowledge on /returned-items/<id>; staff read
// their own sheet at /timesheet.
export function linkPath(n: NotificationRow): string | null {
  if (!n.timesheet_id) return null;
  const isOwner = !!n.timesheet && !!n.recipient && n.timesheet.staff_id === n.recipient.id;
  if (isOwner) return '/timesheet';
  if (n.type === 'returned') return `/returned-items/${n.timesheet_id}`;
  return `/approvals/${n.timesheet_id}`;
}

export function buildEmail(n: NotificationRow, config: Config, redirected: boolean): { subject: string; html: string; text: string } {
  const recipient = n.recipient!;
  const path = linkPath(n);
  const url = path && config.appUrl ? config.appUrl.replace(/\/+$/, '') + path : null;
  const context = n.timesheet
    ? `${n.timesheet.staff_name ?? 'A staff member'} — ${MONTHS[n.timesheet.month - 1] ?? ''} ${n.timesheet.year}`
    : null;

  const subject = redirected ? `[redirected from ${recipient.email}] ${n.title}` : n.title;

  const banner = redirected
    ? `<p style="margin:0 0 16px;padding:8px 12px;background:#FBEEDA;border-radius:6px;font-size:13px;color:#875E17;">Test delivery: this email was addressed to <strong>${escapeHtml(recipient.email)}</strong> and redirected here.</p>`
    : '';
  const contextHtml = context
    ? `<p style="margin:0 0 20px;padding:10px 12px;background:#F2F7F9;border-radius:6px;font-size:14px;color:#2A241D;"><span style="color:#5b6470;">Timesheet:</span> <strong>${escapeHtml(context)}</strong></p>`
    : '';
  const buttonHtml = url
    ? `<p style="margin:0 0 24px;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0270CE;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:10px 20px;border-radius:8px;">Open in the timesheet system</a></p>`
    : '';

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#FAF6EE;font-family:'Work Sans',Segoe UI,Arial,sans-serif;color:#2A241D;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF6EE;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFEFB;border:1px solid #E6DFD0;border-radius:10px;overflow:hidden;">
<tr><td style="background:#0270CE;padding:14px 24px;color:#FFFFFF;font-size:16px;font-weight:600;">Kalthum For Peace Timesheet</td></tr>
<tr><td style="padding:24px;">
${banner}<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;">${escapeHtml(n.title)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Hello ${escapeHtml(recipient.full_name)},</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5;">${escapeHtml(n.message)}</p>
${contextHtml}${buttonHtml}<p style="margin:0;font-size:12px;line-height:1.5;color:#72685A;">This is a copy of a notification in the timesheet system. Sign in to see the full details and take any action.</p>
</td></tr></table></td></tr></table></body></html>`;

  const text = [
    redirected ? `[Test delivery: addressed to ${recipient.email}, redirected here]\n` : '',
    n.title,
    '',
    `Hello ${recipient.full_name},`,
    '',
    n.message,
    context ? `\nTimesheet: ${context}` : '',
    url ? `\nOpen in the timesheet system: ${url}` : '',
    '\n—\nThis is a copy of a notification in the timesheet system. Sign in to see the full details and take any action.',
  ].join('\n');

  return { subject, html, text };
}

type SendOutcome =
  | { result: 'sent'; resendId: string }
  | { result: 'already_sent' | 'skipped_inactive' | 'no_recipient' | 'not_found' }
  | { result: 'not_configured'; reason: string }
  | { result: 'failed'; error: string; markFailed?: boolean };

async function sendOne(id: string, deps: Deps): Promise<SendOutcome> {
  const { db, mailer, config } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());

  const n = await db.getNotification(id);
  if (!n) return { result: 'not_found' };
  if (n.email_sent_at) return { result: 'already_sent' };
  if (!n.recipient) return { result: 'no_recipient' };
  // A deactivated person shouldn't be emailed. The in-app row still exists.
  if (!n.recipient.active) return { result: 'skipped_inactive' };

  if (config.mode !== 'redirect' && config.mode !== 'live') {
    return { result: 'not_configured', reason: 'EMAIL_MODE must be "redirect" or "live"' };
  }
  if (config.mode === 'redirect' && !config.redirectTo) {
    return { result: 'not_configured', reason: 'EMAIL_MODE=redirect requires EMAIL_REDIRECT_TO' };
  }
  if (!config.from) return { result: 'not_configured', reason: 'EMAIL_FROM is not set' };

  const redirected = config.mode === 'redirect';
  const to = redirected ? (config.redirectTo as string) : n.recipient.email;
  const { subject, html, text } = buildEmail(n, config, redirected);
  const message: MailMessage = { from: config.from, to, subject, html, text, idempotencyKey: `notification-${n.id}` };

  // One retry for the transient cases (network error, 429, 5xx). The
  // idempotency key makes a retry after an ambiguous failure safe.
  let res = await mailer.send(message);
  if (!res.ok && (res.status === undefined || res.status === 429 || res.status >= 500)) {
    await sleep(1000);
    res = await mailer.send(message);
  }
  if (!res.ok) return { result: 'failed', error: res.error };

  try {
    await db.markSent(n.id, now().toISOString());
  } catch (e) {
    // The email went out but we couldn't record it. Say so loudly; the
    // idempotency key stops a later manual retry from double-sending.
    return { result: 'failed', error: 'sent but could not record email_sent_at: ' + (e instanceof Error ? e.message : String(e)), markFailed: true };
  }
  return { result: 'sent', resendId: res.id };
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });

  const secret = deps.config.webhookSecret;
  const given = req.headers.get('x-webhook-secret') ?? '';
  // Unset secret = misconfigured, never "open": refuse everything.
  if (!secret || !safeEqual(given, secret)) return json(401, { ok: false, error: 'unauthorized' });

  let body: { notification_id?: unknown; sweep?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'body must be JSON' });
  }

  try {
    if (body.sweep === true) {
      const now = (deps.now ?? (() => new Date()))();
      const since = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
      const ids = await deps.db.listUnsentIds(25, since);
      const tally: Record<string, number> = {};
      for (const id of ids) {
        let outcome: SendOutcome;
        try {
          outcome = await sendOne(id, deps);
        } catch (e) {
          outcome = { result: 'failed', error: e instanceof Error ? e.message : String(e) };
        }
        tally[outcome.result] = (tally[outcome.result] ?? 0) + 1;
      }
      return json(200, { ok: true, considered: ids.length, tally });
    }

    const id = body.notification_id;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
      return json(400, { ok: false, error: 'notification_id (uuid) required' });
    }
    const outcome = await sendOne(id, deps);
    switch (outcome.result) {
      case 'sent':
        return json(200, { ok: true, result: 'sent', resend_id: outcome.resendId });
      case 'not_found':
        return json(404, { ok: false, result: 'not_found' });
      case 'not_configured':
        return json(503, { ok: false, result: 'not_configured', error: outcome.reason });
      case 'failed':
        return json(outcome.markFailed ? 500 : 502, { ok: false, result: 'failed', error: outcome.error });
      default:
        return json(200, { ok: true, result: outcome.result });
    }
  } catch (e) {
    return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
