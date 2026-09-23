import crypto from 'node:crypto';
import { getBookingRecord, updateBookingRecord, releaseCells, acquireLock, releaseLock, clearCalendarRetry } from './redis.js';
import { deleteBookingEvent, describeGoogleError } from './google-calendar.js';

/**
 * Tuğba'nın bildirim e-postasındaki "Randevuyu iptal et" linki.
 * Link, randevu id'sinin HMAC imzasını taşır; imza anahtarı CRON_SECRET'ten
 * bu amaca özel türetilir (ayrı bir ortam değişkeni gerekmez). Link yalnızca
 * Tuğba'ya giden e-postada bulunur.
 */

export const SITE_URL = process.env.SITE_URL || 'https://mutluaileiliskileri.com';

// İptal edilebilecek (kesinleşmiş) randevu durumları.
const CANCELLABLE = new Set(['odendi', 'onaylandi', 'odendi_cakisma']);

function signingKey() {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update('randevu-iptal-link-v1').digest();
}

export function cancelToken(bookingId) {
  const key = signingKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(String(bookingId)).digest('base64url');
}

export function cancelUrl(bookingId) {
  const t = cancelToken(bookingId);
  return t ? `${SITE_URL}/api/randevu-iptal?id=${encodeURIComponent(bookingId)}&t=${t}` : null;
}

export function isValidCancelToken(bookingId, token) {
  const expected = cancelToken(bookingId);
  if (!expected || typeof token !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isCancellable(record) {
  return Boolean(record && CANCELLABLE.has(record.status));
}

/**
 * Kesinleşmiş randevuyu iptal eder: kayıt iptal_edildi olur, saat yeniden
 * açılır, Google Calendar etkinliği silinir (danışana Google iptal e-postası
 * gider). PayTR iadesi yapılmaz — panelden ayrıca yapılmalıdır.
 *
 * @returns {Promise<{ result: 'cancelled'|'already_cancelled'|'not_cancellable'|'not_found'|'busy', record, calendarError?: string }>}
 */
export async function cancelBooking(id) {
  // PayTR bildirimiyle aynı kilit: aynı anda işlenmesinler.
  const lockName = `paytr:${id}`;
  if (!(await acquireLock(lockName, 120))) return { result: 'busy', record: null };
  try {
    const record = await getBookingRecord(id);
    if (!record) return { result: 'not_found', record: null };
    if (record.status === 'iptal_edildi') return { result: 'already_cancelled', record };
    if (!isCancellable(record)) return { result: 'not_cancellable', record };

    let calendarError = null;
    try {
      await deleteBookingEvent(id);
    } catch (e) {
      const err = describeGoogleError(e);
      // Etkinlik zaten silinmişse sorun değil.
      if (err.status !== 404 && err.status !== 410) calendarError = err.message;
    }

    const next = await updateBookingRecord(id, {
      previousStatus: record.status,
      status: 'iptal_edildi',
      cancelledAt: new Date().toISOString(),
      calendarCancelError: calendarError,
    });
    // Yalnızca bu randevuya ait hücreler bırakılır (odendi_cakisma'da saat başkasınındır).
    await releaseCells(record.date, record.cells, id);
    await clearCalendarRetry(id);
    return { result: 'cancelled', record: next, calendarError };
  } finally {
    try { await releaseLock(lockName); } catch {}
  }
}
