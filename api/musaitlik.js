import { WORK_HOURS, isWeekday, isWithinBookingWindow, isPastCell, getOccupiedCells, checkRateLimit } from './_lib/redis.js';
import { getGoogleBusyCells, describeGoogleError } from './_lib/google-calendar.js';

/**
 * Bir gün için dolu saatleri döner. Bir saat şu kaynaklardan herhangi biri
 * doluysa "occupied" sayılır:
 *   1. Redis hücreleri — ödenmiş/onaylanmış site randevuları VE ödeme
 *      bekleyen (30 dk tutulan) rezervasyonlar,
 *   2. Google Calendar FreeBusy — randevu takvimi + ana takvim (elle
 *      eklenen etkinlikler dahil),
 *   3. bugünün geçmişte kalan saatleri.
 * Google'a ulaşılamazsa slot satmamak için hata döner (fail-closed).
 * Yanıt önbelleğe alınmaz; takvim değişikliği bir sonraki istekte görünür.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '0.0.0.0').split(',')[0].trim();
  const rate = await checkRateLimit(`musaitlik:${ip}`, 60, 60); // dakikada en fazla 60 istek
  if (!rate.ok) {
    res.status(429).json({ ok: false, error: 'too_many_requests' });
    return;
  }

  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isWeekday(date) || !isWithinBookingWindow(date)) {
    res.status(400).json({ ok: false, error: 'invalid_date' });
    return;
  }

  let occupied;
  try {
    occupied = await getOccupiedCells(date);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
    return;
  }

  let googleBusy;
  try {
    googleBusy = await getGoogleBusyCells(date);
  } catch (e) {
    const err = describeGoogleError(e);
    console.error('[musaitlik] Google FreeBusy failed:', err.status, err.message);
    res.status(503).json({ ok: false, error: 'calendar_unavailable' });
    return;
  }

  for (const h of WORK_HOURS) {
    if (googleBusy.has(h) || isPastCell(date, h)) occupied.add(h);
  }

  res.status(200).json({
    ok: true,
    date,
    hours: WORK_HOURS,
    occupied: WORK_HOURS.filter((h) => occupied.has(h)),
  });
}
