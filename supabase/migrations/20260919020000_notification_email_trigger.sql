-- Kalthum for Peace — Automated Timesheet System
-- Phase 5: real email delivery, step 1 of 2 — the database side.
-- DRY RUN — not yet applied. See CLAUDE.md standing rules.
--
-- Every INSERT into notifications asks the `send-notification-email` Edge
-- Function (supabase/functions/send-notification-email) to email it. The
-- function records notifications.email_sent_at once Resend accepts the
-- message. The in-app notification row is the source of truth; email is a
-- best-effort courtesy copy (PROJECT_CONTEXT §22).
--
-- FAILURE ISOLATION — the reason this is built the way it is:
--   * pg_net's http_post only ENQUEUES the request (an insert into its own
--     queue table, inside the caller's transaction); the network call happens
--     afterwards on a background worker. A slow, failing or unreachable
--     email service therefore cannot slow down or fail approve/decline/etc.
--   * If the transaction rolls back, the queued request rolls back with it —
--     no email is ever sent for a workflow step that didn't happen.
--   * The whole body sits in an EXCEPTION block: missing pg_net, missing
--     Vault, unset secrets, a bad URL — anything — becomes a WARNING and the
--     notification insert (and the workflow transaction around it) succeeds
--     regardless.
--
-- PORTABILITY: no project ref, URL or secret appears in this file. The two
-- environment-specific values live in Supabase Vault, set once per project
-- (see context/PRODUCTION_BOOTSTRAP.md):
--   email_function_url    e.g. https://<ref>.supabase.co/functions/v1/send-notification-email
--   email_function_secret shared secret; must equal the function's EMAIL_WEBHOOK_SECRET
-- Until both exist the trigger is inert (no email, no error).

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_email_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  begin
    select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'email_function_url';
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'email_function_secret';

    if v_url is null or v_secret is null then
      return new; -- email not configured for this project: silently do nothing
    end if;

    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('notification_id', new.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', v_secret
      ),
      timeout_milliseconds := 5000
    );
  exception when others then
    raise warning 'notify_email_after_insert: email not queued for notification %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

-- Trigger functions aren't callable as ordinary functions by clients, but
-- nothing should be able to invoke this directly either.
revoke execute on function public.notify_email_after_insert() from public;
revoke execute on function public.notify_email_after_insert() from anon;
revoke execute on function public.notify_email_after_insert() from authenticated;

create trigger trg_notifications_email
after insert on notifications
for each row
execute function public.notify_email_after_insert();
