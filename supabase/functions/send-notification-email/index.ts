// Supabase Edge Function entry point (Deno runtime). All behaviour lives in
// handler.ts; this file only wires real dependencies from environment
// secrets. See context/PRODUCTION_BOOTSTRAP.md for the full secret list and
// deploy command (it must be deployed with --no-verify-jwt: the caller is the
// database trigger and authenticates with EMAIL_WEBHOOK_SECRET instead, and
// the newer publishable/secret API keys are not JWTs the gateway can verify).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleRequest, type Db, type NotificationRow } from './handler.ts';
import { createResendMailer } from './resend.ts';

// Custom secret names first: Supabase reserves the SUPABASE_ prefix for its
// own injected variables, and a project on the newer API keys may not get a
// working legacy service-role JWT injected at all.
const supabaseUrl = Deno.env.get('KFP_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL') ?? '';
const secretKey = Deno.env.get('KFP_SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

const db: Db = {
  async getNotification(id) {
    const { data, error } = await supabase
      .from('notifications')
      .select(
        'id, type, title, message, timesheet_id, email_sent_at, ' +
          'recipient:profiles!notifications_recipient_id_fkey(id, email, full_name, active), ' +
          'timesheet:timesheets(staff_id, month, year, staff:profiles!timesheets_staff_id_fkey(full_name))',
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error('load notification: ' + error.message);
    if (!data) return null;
    // deno-lint-ignore no-explicit-any
    const row = data as any;
    const out: NotificationRow = {
      id: row.id,
      type: row.type,
      title: row.title,
      message: row.message,
      timesheet_id: row.timesheet_id,
      email_sent_at: row.email_sent_at,
      recipient: row.recipient,
      timesheet: row.timesheet
        ? { staff_id: row.timesheet.staff_id, month: row.timesheet.month, year: row.timesheet.year, staff_name: row.timesheet.staff?.full_name ?? null }
        : null,
    };
    return out;
  },
  async listUnsentIds(limit, sinceIso) {
    const { data, error } = await supabase
      .from('notifications')
      .select('id')
      .is('email_sent_at', null)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error('list unsent: ' + error.message);
    return (data ?? []).map((r: { id: string }) => r.id);
  },
  async markSent(id, atIso) {
    const { error } = await supabase.from('notifications').update({ email_sent_at: atIso }).eq('id', id).is('email_sent_at', null);
    if (error) throw new Error(error.message);
  },
};

const mailer = createResendMailer(Deno.env.get('RESEND_API_KEY') ?? '');

Deno.serve((req: Request) =>
  handleRequest(req, {
    db,
    mailer,
    config: {
      webhookSecret: Deno.env.get('EMAIL_WEBHOOK_SECRET'),
      mode: Deno.env.get('EMAIL_MODE'),
      redirectTo: Deno.env.get('EMAIL_REDIRECT_TO'),
      from: Deno.env.get('EMAIL_FROM'),
      appUrl: Deno.env.get('APP_URL'),
    },
  }),
);
