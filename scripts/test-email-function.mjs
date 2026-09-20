// Behavioral tests for the send-notification-email Edge Function's logic
// (supabase/functions/send-notification-email/{handler,resend}.ts), run under
// Node with fakes — no Supabase, no Resend account, no network beyond a
// loopback fake of Resend's HTTP API.
//
// What this proves: authentication, the fail-closed EMAIL_MODE rules,
// redirect vs live addressing, skip rules, retry-then-succeed, every failure
// path leaving email_sent_at UNSET and never throwing, HTML escaping, link
// targets, sweep, and that the real Resend transport sends exactly the
// request Resend documents (auth header, idempotency key, JSON body).
// What it can't prove: that a real inbox receives a real message — that is
// the separate live check in context/PRODUCTION_BOOTSTRAP.md.
//
// Run with: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-email-function.mjs

import http from 'node:http';
import { handleRequest, buildEmail, linkPath, escapeHtml } from '../supabase/functions/send-notification-email/handler.ts';
import { createResendMailer } from '../supabase/functions/send-notification-email/resend.ts';

const results = [];
const record = (label, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${label}${detail ? '  (' + detail + ')' : ''}`);
};

const SECRET = 'test-secret-value';
const ID = '11111111-1111-4111-8111-111111111111';
const STAFF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPROVER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING = '44444444-4444-4444-8444-444444444444';

const baseRow = (over = {}) => ({
  id: ID, type: 'approval_required', title: 'Timesheet awaiting your approval',
  message: 'A timesheet has been submitted and is awaiting your review.',
  timesheet_id: '22222222-2222-4222-8222-222222222222', email_sent_at: null,
  recipient: { id: APPROVER, email: 'approver@example.org', full_name: 'Bala Approver', active: true },
  timesheet: { staff_id: STAFF, month: 9, year: 2026, staff_name: 'Amina Staff' },
  ...over,
});
const liveConfig = (over = {}) => ({ webhookSecret: SECRET, mode: 'live', redirectTo: undefined, from: 'KFP <no-reply@example.org>', appUrl: 'https://timesheet.example.org/', ...over });

function harness({ row = baseRow(), mailResults, config = liveConfig(), markSentFails = false, unsent = [] } = {}) {
  const calls = { sent: [], marked: [], sleeps: [] };
  let i = 0;
  const deps = {
    config,
    sleep: async (ms) => { calls.sleeps.push(ms); },
    now: () => new Date('2026-09-19T10:00:00Z'),
    db: {
      async getNotification(id) { return id === ID ? row : (id === 'missing' || id === MISSING ? null : { ...row, id }); },
      async listUnsentIds() { return unsent; },
      async markSent(id, at) { if (markSentFails) throw new Error('db down'); calls.marked.push({ id, at }); },
    },
    mailer: {
      async send(msg) { calls.sent.push(msg); const r = (mailResults ?? [{ ok: true, id: 'resend-1' }])[Math.min(i++, (mailResults ?? [1]).length - 1)]; return r; },
    },
  };
  return { deps, calls };
}
const post = (body, headers = { 'x-webhook-secret': SECRET }) =>
  new Request('http://fn/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function run(req, h) {
  const res = await handleRequest(req, h.deps);
  return { status: res.status, body: await res.json() };
}

console.log('\n--- A: authentication and request shape ---\n');
{
  let h = harness();
  let r = await run(new Request('http://fn/', { method: 'GET' }), h);
  record('GET is refused (405)', r.status === 405);
  r = await run(post({ notification_id: ID }, {}), h);
  record('missing secret header is refused (401), nothing sent', r.status === 401 && h.calls.sent.length === 0);
  r = await run(post({ notification_id: ID }, { 'x-webhook-secret': 'wrong-secret-value' }), h);
  record('wrong secret is refused (401), nothing sent', r.status === 401 && h.calls.sent.length === 0);
  h = harness({ config: liveConfig({ webhookSecret: undefined }) });
  r = await run(post({ notification_id: ID }, { 'x-webhook-secret': '' }), h);
  record('an UNSET server secret refuses everything (never "open")', r.status === 401 && h.calls.sent.length === 0);
  h = harness();
  r = await run(post('not json'), h);
  record('non-JSON body -> 400', r.status === 400);
  r = await run(post({ notification_id: 'nope' }), h);
  record('malformed notification_id -> 400', r.status === 400 && h.calls.sent.length === 0);
  r = await run(post({ notification_id: MISSING }), harness());
  record('unknown notification -> 404 (not_found)', r.status === 404 && r.body.result === 'not_found');
}

console.log('\n--- B: mode rules (fail closed) and addressing ---\n');
{
  let h = harness({ config: liveConfig({ mode: undefined }) });
  let r = await run(post({ notification_id: ID }), h);
  record('EMAIL_MODE unset -> 503, NOTHING sent (no accidental real emails)', r.status === 503 && h.calls.sent.length === 0, r.body.error);
  h = harness({ config: liveConfig({ mode: 'yes' }) });
  r = await run(post({ notification_id: ID }), h);
  record('EMAIL_MODE with an unrecognised value -> 503, nothing sent', r.status === 503 && h.calls.sent.length === 0);
  h = harness({ config: liveConfig({ mode: 'redirect', redirectTo: undefined }) });
  r = await run(post({ notification_id: ID }), h);
  record('redirect mode without EMAIL_REDIRECT_TO -> 503, nothing sent', r.status === 503 && h.calls.sent.length === 0);
  h = harness({ config: liveConfig({ from: undefined }) });
  r = await run(post({ notification_id: ID }), h);
  record('missing EMAIL_FROM -> 503, nothing sent', r.status === 503 && h.calls.sent.length === 0);

  h = harness({ config: liveConfig({ mode: 'redirect', redirectTo: 'owner@example.com' }) });
  r = await run(post({ notification_id: ID }), h);
  const m = h.calls.sent[0];
  record('redirect mode: addressed ONLY to EMAIL_REDIRECT_TO, never the real recipient', r.status === 200 && m.to === 'owner@example.com' && !m.to.includes('approver'));
  record('  ...subject names the real recipient; body carries a redirect notice',
    m.subject.startsWith('[redirected from approver@example.org]') && m.html.includes('redirected here') && m.text.includes('redirected here'));

  h = harness();
  r = await run(post({ notification_id: ID }), h);
  record('live mode: addressed to the real recipient, plain subject = the existing notification title',
    r.status === 200 && h.calls.sent[0].to === 'approver@example.org' && h.calls.sent[0].subject === 'Timesheet awaiting your approval');
  record('  ...records email_sent_at exactly once, after success', h.calls.marked.length === 1 && h.calls.marked[0].at === '2026-09-19T10:00:00.000Z');
  record('  ...idempotency key is derived from the notification id', h.calls.sent[0].idempotencyKey === `notification-${ID}`);
}

console.log('\n--- C: skip rules ---\n');
{
  let h = harness({ row: baseRow({ email_sent_at: '2026-09-19T09:00:00Z' }) });
  let r = await run(post({ notification_id: ID }), h);
  record('already-sent notification is not sent again', r.status === 200 && r.body.result === 'already_sent' && h.calls.sent.length === 0);
  h = harness({ row: baseRow({ recipient: { ...baseRow().recipient, active: false } }) });
  r = await run(post({ notification_id: ID }), h);
  record('a DEACTIVATED recipient is not emailed (and stays unsent)', r.body.result === 'skipped_inactive' && h.calls.sent.length === 0 && h.calls.marked.length === 0);
  h = harness({ row: baseRow({ recipient: null }) });
  r = await run(post({ notification_id: ID }), h);
  record('a notification with no resolvable recipient is skipped', r.body.result === 'no_recipient' && h.calls.sent.length === 0);
}

console.log('\n--- D: failure isolation — email_sent_at is never set on failure, nothing throws ---\n');
{
  let h = harness({ mailResults: [{ ok: false, status: 401, error: 'Resend 401: API key is invalid' }] });
  let r = await run(post({ notification_id: ID }), h);
  record('permanent provider error (bad API key) -> 502, email_sent_at NOT set, no retry', r.status === 502 && h.calls.marked.length === 0 && h.calls.sent.length === 1, r.body.error);

  h = harness({ mailResults: [{ ok: false, status: 422, error: 'invalid to address' }] });
  r = await run(post({ notification_id: ID }), h);
  record('a 4xx validation error is not retried', h.calls.sent.length === 1 && r.status === 502);

  h = harness({ mailResults: [{ ok: false, status: 429, error: 'rate limited' }, { ok: true, id: 'resend-2' }] });
  r = await run(post({ notification_id: ID }), h);
  record('429 then success: retried once after a pause, then recorded', r.status === 200 && h.calls.sent.length === 2 && h.calls.sleeps.length === 1 && h.calls.marked.length === 1);
  record('  ...the retry reuses the SAME idempotency key (cannot double-send)', h.calls.sent[0].idempotencyKey === h.calls.sent[1].idempotencyKey);

  h = harness({ mailResults: [{ ok: false, error: 'network error: fetch failed' }, { ok: true, id: 'resend-3' }] });
  r = await run(post({ notification_id: ID }), h);
  record('network error then success: retried, recorded', r.status === 200 && h.calls.sent.length === 2 && h.calls.marked.length === 1);

  h = harness({ mailResults: [{ ok: false, status: 503, error: 'down' }, { ok: false, status: 503, error: 'still down' }] });
  r = await run(post({ notification_id: ID }), h);
  record('provider down twice: gives up (502), email_sent_at NOT set', r.status === 502 && h.calls.sent.length === 2 && h.calls.marked.length === 0);

  h = harness({ markSentFails: true });
  r = await run(post({ notification_id: ID }), h);
  record('email sent but recording it fails: reported loudly (500), does not throw', r.status === 500 && r.body.error.includes('could not record'));

  h = harness();
  h.deps.db.getNotification = async () => { throw new Error('connection refused'); };
  r = await run(post({ notification_id: ID }), h);
  record('database unreachable: clean 500 response, never an unhandled throw', r.status === 500 && h.calls.sent.length === 0);
}

console.log('\n--- E: message content ---\n');
{
  const evil = baseRow({
    title: 'Hi <script>alert(1)</script>', message: 'a & b "quoted" <img src=x onerror=alert(1)>',
    recipient: { id: APPROVER, email: 'x@example.org', full_name: '<b>Bob</b>', active: true },
    timesheet: { staff_id: STAFF, month: 9, year: 2026, staff_name: 'Eve <i>Staff</i>' },
  });
  const { html } = buildEmail(evil, liveConfig(), false);
  record('hostile title/message/names are HTML-escaped (no live tags injected)',
    !html.includes('<script>') && !html.includes('<img') && !html.includes('<b>Bob') && !html.includes('<i>Staff') && html.includes('&lt;script&gt;'));
  record('escapeHtml covers & < > " \'', escapeHtml(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;');

  const ok = buildEmail(baseRow(), liveConfig(), false);
  record('uses the existing notification copy verbatim (title + message) and names the timesheet',
    ok.html.includes('Timesheet awaiting your approval') && ok.html.includes('A timesheet has been submitted and is awaiting your review.') && ok.html.includes('Amina Staff — September 2026'));
  record('plain-text alternative is present and carries the same content',
    ok.text.includes('Timesheet awaiting your approval') && ok.text.includes('September 2026') && ok.text.includes('https://timesheet.example.org/approvals/'));
  const noApp = buildEmail(baseRow(), liveConfig({ appUrl: undefined }), false);
  record('no APP_URL: email still renders, just without a button', !noApp.html.includes('Open in the timesheet system') && noApp.html.includes('Bala Approver'));

  const T = '22222222-2222-4222-8222-222222222222';
  record('link: approval_required -> /approvals/<id>', linkPath(baseRow()) === `/approvals/${T}`);
  record('link: returned to an approver -> /returned-items/<id>', linkPath(baseRow({ type: 'returned' })) === `/returned-items/${T}`);
  record('link: anything addressed to the timesheet OWNER -> /timesheet',
    linkPath(baseRow({ type: 'final_approval', recipient: { id: STAFF, email: 's@example.org', full_name: 'S', active: true } })) === '/timesheet'
    && linkPath(baseRow({ type: 'returned', recipient: { id: STAFF, email: 's@example.org', full_name: 'S', active: true } })) === '/timesheet');
  record('link: no timesheet -> no link', linkPath(baseRow({ timesheet_id: null })) === null);

  // All 8 enum values render — the pipeline is generic over notification_type.
  const types = ['submission', 'approval_required', 'approved', 'declined', 'returned', 'return_acknowledged', 'resubmitted', 'final_approval'];
  let allOk = true;
  for (const type of types) {
    const h = harness({ row: baseRow({ type }) });
    const r = await run(post({ notification_id: ID }), h);
    if (r.status !== 200 || h.calls.sent.length !== 1) allOk = false;
  }
  record('all 8 notification_type values are sent without any per-type code', allOk);
}

console.log('\n--- F: sweep (retry of recent unsent notifications) ---\n');
{
  const h = harness({ unsent: [ID, '33333333-3333-4333-8333-333333333333', 'missing'] });
  let n = 0;
  h.deps.mailer.send = async (msg) => { h.calls.sent.push(msg); return n++ === 0 ? { ok: false, status: 401, error: 'bad key' } : { ok: true, id: 'r' + n }; };
  const r = await run(post({ sweep: true }), h);
  record('sweep continues past a failing item and tallies each outcome',
    r.status === 200 && r.body.considered === 3 && r.body.tally.failed === 1 && r.body.tally.sent === 1 && r.body.tally.not_found === 1, JSON.stringify(r.body.tally));
  const denied = await run(post({ sweep: true }, {}), harness());
  record('sweep needs the secret too', denied.status === 401);
}

console.log('\n--- G: the real Resend transport, against a loopback fake of Resend ---\n');
{
  const seen = [];
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (mode === 'ok') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 're_abc123' })); }
      else if (mode === 'badkey') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: 'validation_error', message: 'API key is invalid' })); }
      else if (mode === 'html500') { res.writeHead(500); res.end('<html>Bad gateway</html>'); }
      else if (mode === 'noid') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mailer = createResendMailer('re_test_key', base);
  const msg = { from: 'KFP <a@b.co>', to: 'x@y.co', subject: 'Hi', html: '<p>hi</p>', text: 'hi', idempotencyKey: 'notification-1' };

  let out = await mailer.send(msg);
  const rq = seen[0];
  const parsed = JSON.parse(rq.body);
  record('sends POST /emails with Bearer auth, JSON, and an Idempotency-Key',
    out.ok && out.id === 're_abc123' && rq.method === 'POST' && rq.url === '/emails' && rq.headers.authorization === 'Bearer re_test_key'
    && rq.headers['idempotency-key'] === 'notification-1' && rq.headers['content-type'] === 'application/json');
  record('  ...body has from, to as an array, subject, html and text', parsed.from === msg.from && Array.isArray(parsed.to) && parsed.to[0] === 'x@y.co' && parsed.subject === 'Hi' && parsed.html && parsed.text);

  mode = 'badkey';
  out = await mailer.send(msg);
  record('a 401 from Resend surfaces as {ok:false,status:401} with Resend\'s message', !out.ok && out.status === 401 && out.error.includes('API key is invalid'), out.error);
  mode = 'html500';
  out = await mailer.send(msg);
  record('a non-JSON 500 body is handled without throwing', !out.ok && out.status === 500);
  mode = 'noid';
  out = await mailer.send(msg);
  record('a 200 with no id is NOT treated as success', !out.ok);
  server.close();
  out = await createResendMailer('k', 'http://127.0.0.1:1').send(msg);
  record('an unreachable host is a clean {ok:false} (no status -> eligible for retry), not an exception', !out.ok && out.status === undefined, out.error);
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
