import crypto from 'node:crypto';
import { checkRateLimit } from '../../lib/redis.js';
import { isCalendarConfigured, createGoogleMeetEvent, deleteGoogleEvent, describeGoogleError, TIME_ZONE } from '../../lib/google-calendar.js';

/**
 * GEÇİCİ entegrasyon testi — test bitince silinmelidir.
 *
 * Herkese açık bir GET ile takvime etkinlik açılamasın diye yalnızca
 * GOOGLE_TEST_KEY ortam değişkeni tanımlıyken ve ?key= ile eşleşince çalışır;
 * aksi halde 404 döner.
 *
 *   GET /api/google/test-calendar?key=<GOOGLE_TEST_KEY>
 *   GET /api/google/test-calendar?key=<GOOGLE_TEST_KEY>&email=ornek@alan.com   (davetli eklemek için, opsiyonel)
 *   GET /api/google/test-calendar?key=<GOOGLE_TEST_KEY>&delete=<eventId>        (test etkinliğini silmek için)
 *
 * Yarından sonraki gün İstanbul saatiyle 10:00–10:30 arası bir etkinlik oluşturur.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!isValidKey(req.query.key)) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const rate = await checkRateLimit('google-test-calendar', 5, 600); // 10 dakikada en fazla 5 istek
  if (!rate.ok) {
    res.status(429).json({ ok: false, error: 'too_many_requests' });
    return;
  }

  if (!isCalendarConfigured()) {
    res.status(500).json({ ok: false, error: 'google_calendar_not_configured' });
    return;
  }

  try {
    if (typeof req.query.delete === 'string' && /^[a-z0-9_]{5,1024}$/i.test(req.query.delete)) {
      await deleteGoogleEvent(req.query.delete);
      res.status(200).json({ deleted: req.query.delete });
      return;
    }

    const email = typeof req.query.email === 'string' && EMAIL_RE.test(req.query.email) ? req.query.email : undefined;
    const day = dayAfterTomorrowInIstanbul();
    const result = await createGoogleMeetEvent({
      name: email ? 'Test Danışan' : undefined,
      email,
      startDateTime: `${day}T10:00:00`,
      endDateTime: `${day}T10:30:00`,
      serviceName: 'Online Görüşme',
      summary: 'Google Meet Integration Test',
    });
    res.status(200).json({
      eventId: result.eventId,
      eventHtmlLink: result.eventHtmlLink,
      meetUrl: result.meetUrl,
    });
  } catch (e) {
    const err = describeGoogleError(e);
    console.error('Google Calendar test failed:', err.status, err.message);
    res.status(502).json({ ok: false, error: 'google_calendar_error', status: err.status, message: err.message });
  }
}

function isValidKey(received) {
  const expected = process.env.GOOGLE_TEST_KEY;
  if (!expected || typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** İstanbul saatine göre bugünden 2 gün sonrası, YYYY-MM-DD. */
function dayAfterTomorrowInIstanbul() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString().slice(0, 10);
}
