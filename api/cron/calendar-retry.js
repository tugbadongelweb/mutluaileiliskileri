import crypto from 'node:crypto';
import { retryFailedCalendarSyncs } from '../_lib/google-calendar.js';

/**
 * Ödemesi alınmış ama Google Calendar'a yazılamamış randevular için takvim
 * etkinliğini yeniden dener. Vercel Cron (vercel.json) günde bir çağırır;
 * gerektiğinde elle de tetiklenebilir:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://mutluaileiliskileri.com/api/cron/calendar-retry
 * Aynı randevu için her zaman aynı etkinlik kimliği kullanıldığından ikinci
 * etkinlik oluşmaz.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthorized(req.headers.authorization)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  try {
    const results = await retryFailedCalendarSyncs();
    res.status(200).json({ ok: true, results });
  } catch (e) {
    console.error('[calendar-retry]', String(e && e.message || e));
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}

function isAuthorized(header) {
  const secret = process.env.CRON_SECRET;
  if (!secret || typeof header !== 'string') return false;
  const a = Buffer.from(`Bearer ${secret}`);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
