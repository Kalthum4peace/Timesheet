// Resend transport. Separate from handler.ts so tests can point it at a fake
// HTTP server (baseUrl) and assert the exact request Resend would receive.
import type { Mailer, MailMessage, MailResult } from './handler.ts';

export function createResendMailer(apiKey: string, baseUrl = 'https://api.resend.com', fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send(msg: MailMessage): Promise<MailResult> {
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            // Resend dedupes on this for 24h: a retry can't double-send.
            'Idempotency-Key': msg.idempotencyKey,
          },
          body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
        });
      } catch (e) {
        return { ok: false, error: 'network error: ' + (e instanceof Error ? e.message : String(e)) };
      }
      const raw = await res.text();
      let parsed: { id?: string; message?: string; name?: string } = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* non-JSON error body */
      }
      if (!res.ok) {
        return { ok: false, status: res.status, error: `Resend ${res.status}: ${parsed.message ?? raw.slice(0, 200)}` };
      }
      if (!parsed.id) return { ok: false, status: res.status, error: 'Resend accepted the request but returned no id' };
      return { ok: true, id: parsed.id };
    },
  };
}
