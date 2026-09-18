import { WORK_HOURS, isWeekday, isWithinBookingWindow, getOccupiedCells } from '../lib/redis.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
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
