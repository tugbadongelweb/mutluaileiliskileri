import crypto from 'node:crypto';
import {
  SESSION_TYPES,
  isWeekday,
  isWithinBookingWindow,
  cellsNeededFrom,
  tryReserveCells,
  releaseCells,
  confirmCells,
  saveBookingRecord,
  checkRateLimit,
} from '../lib/redis.js';
import { isPaytrConfigured, priceForSessionType, createPaytrPaymentUrl } from '../lib/paytr.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MAX = 100;
const EMAIL_MAX = 200;
const PHONE_MAX = 30;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '0.0.0.0').split(',')[0].trim();
  const rate = await checkRateLimit(`randevu:${ip}`, 6, 600); // 10 dakikada en fazla 6 deneme
  if (!rate.ok) {
    res.status(429).json({ ok: false, error: 'too_many_requests' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { date, time, sessionType, name, email, phone, kvkkOnay } = body;

  if (!SESSION_TYPES[sessionType]) {
    res.status(400).json({ ok: false, error: 'invalid_session_type' });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !isWeekday(date) || !isWithinBookingWindow(date)) {
    res.status(400).json({ ok: false, error: 'invalid_date' });
    return;
  }
  const cells = cellsNeededFrom(time, sessionType);
  if (!cells) {
    res.status(400).json({ ok: false, error: 'invalid_time' });
    return;
  }
  if (!name || String(name).trim().length < 2 || String(name).trim().length > NAME_MAX) {
    res.status(400).json({ ok: false, error: 'invalid_name' });
    return;
  }
  if (!email || String(email).length > EMAIL_MAX || !EMAIL_RE.test(String(email))) {
    res.status(400).json({ ok: false, error: 'invalid_email' });
    return;
  }
  if (phone && String(phone).length > PHONE_MAX) {
    res.status(400).json({ ok: false, error: 'invalid_phone' });
    return;
  }
  if (!kvkkOnay) {
    res.status(400).json({ ok: false, error: 'kvkk_required' });
    return;
  }

  const id = crypto.randomUUID().replace(/-/g, ''); // PayTR merchant_oid ile birebir aynı, tire yok
  let reserved = false;
  try {
    reserved = await tryReserveCells(date, cells, id);
    if (!reserved) {
      res.status(409).json({ ok: false, error: 'slot_taken' });
      return;
    }

    const sessionInfo = SESSION_TYPES[sessionType];
    const record = {
      id,
      date,
      time,
      cells,
      sessionType,
      sessionLabel: sessionInfo.label,
      minutes: sessionInfo.minutes,
      name: String(name).trim(),
      email: String(email).trim(),
      phone: phone ? String(phone).trim() : '',
      status: 'odeme_bekleniyor',
      createdAt: new Date().toISOString(),
    };

    const price = isPaytrConfigured() ? priceForSessionType(sessionType) : null;
    if (price) {
      const origin = `https://${req.headers.host}`;
      try {
        const paymentUrl = await createPaytrPaymentUrl({
          merchantOid: id,
          amountTl: price,
          email: record.email,
          userName: record.name,
          userPhone: record.phone || '05000000000',
          userIp: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '0.0.0.0').split(',')[0].trim(),
          basketLabel: sessionInfo.label,
          okUrl: `${origin}/?page=contact&randevu=odendi`,
          failUrl: `${origin}/?page=contact&randevu=basarisiz`,
        });
        record.paymentUrl = paymentUrl;
        record.priceTl = price;
        await saveBookingRecord(id, record);
        res.status(200).json({ ok: true, id, paymentUrl });
        return;
      } catch (e) {
        await releaseCells(date, cells);
        res.status(502).json({ ok: false, error: 'paytr_error', message: String(e && e.message || e) });
        return;
      }
    }

    // PayTR henüz yapılandırılmamış: yer kalıcı olarak ayrılır, ödeme adımı sonra eklenir.
    await confirmCells(date, cells);
    await saveBookingRecord(id, record);
    res.status(200).json({ ok: true, id, paymentUrl: null, pendingPaymentSetup: true });
  } catch (e) {
    if (reserved) {
      try { await releaseCells(date, cells); } catch {}
    }
    res.status(500).json({ ok: false, error: 'server_error', message: String(e && e.message || e) });
  }
}
