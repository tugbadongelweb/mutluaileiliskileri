import { WORK_HOURS, isWeekday, isWithinBookingWindow, getOccupiedCells, checkRateLimit } from '../lib/redis.js';

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
  try {
    const occupied = await getOccupiedCells(date);
    res.status(200).json({
      ok: true,
      date,
      hours: WORK_HOURS,
      occupied: Array.from(occupied),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error', message: String(e && e.message || e) });
  }
}
