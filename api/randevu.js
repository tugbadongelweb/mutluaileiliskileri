import crypto from 'node:crypto';
import {
  SESSION_TYPES,
  isWeekday,
  isWithinBookingWindow,
  isPastCell,
  cellsNeededFrom,
  tryReserveCells,
  releaseCells,
  confirmCells,
  saveBookingRecord,
  checkRateLimit,
} from './_lib/redis.js';
import { isPaytrConfigured, priceForSessionType, createPaytrPaymentUrl } from './_lib/paytr.js';
import { addBookingToCalendar, getGoogleBusyCells, describeGoogleError } from './_lib/google-calendar.js';
import { notifyNewBooking } from './_lib/notify.js';
import { SITE_URL } from './_lib/cancel.js';

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

  const { kvkkOnay, onamOnay } = body;
  // Yalnızca string kabul edilir (dizi/nesne ile doğrulamayı atlatmayı önler);
  // kontrol karakterleri (satır sonu vb.) e-posta/takvim metnine sızmasın diye atılır.
  const str = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '') : '');
  const date = str(body.date);
  const time = str(body.time);
  const sessionType = str(body.sessionType);
  const name = str(body.name);
  const email = str(body.email);
  const phone = str(body.phone);

  if (!Object.hasOwn(SESSION_TYPES, sessionType)) {
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
  if (phone && (phone.length > PHONE_MAX || !/^[0-9+()\-.\s]+$/.test(phone))) {
    res.status(400).json({ ok: false, error: 'invalid_phone' });
    return;
  }
  if (!kvkkOnay) {
    res.status(400).json({ ok: false, error: 'kvkk_required' });
    return;
  }
  if (!onamOnay) {
    res.status(400).json({ ok: false, error: 'onam_required' });
    return;
  }

  if (cells.some((c) => isPastCell(date, c))) {
    res.status(409).json({ ok: false, error: 'slot_taken' });
    return;
  }

  // Tuğba'nın Google Calendar'ındaki (elle eklenenler dahil) dolu saatler
  // satılamaz. Google'a ulaşılamazsa slot satılmaz (fail-closed).
  let googleBusy;
  try {
    googleBusy = await getGoogleBusyCells(date);
  } catch (e) {
    const err = describeGoogleError(e);
    console.error('[randevu] Google FreeBusy failed:', err.status, err.message);
    res.status(503).json({ ok: false, error: 'calendar_unavailable' });
    return;
  }
  if (cells.some((c) => googleBusy.has(c))) {
    res.status(409).json({ ok: false, error: 'slot_taken' });
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
      kvkkOnay: true,
      onamOnay: true,
      status: 'odeme_bekleniyor',
      createdAt: new Date().toISOString(),
    };

    const price = isPaytrConfigured() ? priceForSessionType(sessionType) : null;
    if (price) {
      // Host başlığı istemci kontrolünde olabilir; dönüş adresleri sabit site adresinden üretilir.
      const origin = SITE_URL;
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
        console.error('[randevu] PayTR token failed:', id, String(e && e.message || e));
        await releaseCells(date, cells, id);
        res.status(502).json({ ok: false, error: 'paytr_error' });
        return;
      }
    }

    // PayTR henüz yapılandırılmamış: yer kalıcı olarak ayrılır, ödeme adımı sonra eklenir.
    await confirmCells(date, cells, id);
    record.status = 'onaylandi';
    await saveBookingRecord(id, record);
    const confirmed = (await addBookingToCalendar(record)) || record;
    await notifyNewBooking(confirmed);
    res.status(200).json({ ok: true, id, paymentUrl: null, pendingPaymentSetup: true });
  } catch (e) {
    if (reserved) {
      try { await releaseCells(date, cells, id); } catch {}
    }
    console.error('[randevu]', id, String(e && e.message || e));
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}
