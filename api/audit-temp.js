import crypto from 'node:crypto';
import { google } from 'googleapis';
import { WORK_HOURS, getRedis, getBookingRecord, releaseCells, clearCalendarRetry } from './_lib/redis.js';
import { bookingEventId, retryFailedCalendarSyncs, describeGoogleError } from './_lib/google-calendar.js';
import randevuHandler from './randevu.js';
import paytrCallbackHandler from './paytr-callback.js';

/**
 * GEÇİCİ production denetim endpoint'i — denetim bitince silinecek.
 * Yalnızca x-audit-key başlığı GOOGLE_TEST_KEY ile eşleşirse çalışır, aksi
 * halde 404. Gerçek ödeme yapmaz: PayTR token isteği bu çağrı içinde taklit
 * edilir, ödeme bildirimi sunucudaki gerçek anahtarla imzalanıp gerçek
 * paytr-callback handler'ına verilir. Diğer her şey (Redis, Google Calendar,
 * FreeBusy, Meet) gerçektir.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isValidKey(req.headers['x-audit-key'])) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  const q = req.query;
  try {
    const out = await ACTIONS[q.action]?.(q);
    if (out === undefined) {
      res.status(400).json({ ok: false, error: 'unknown_action' });
      return;
    }
    res.status(200).json(out);
  } catch (e) {
    const err = describeGoogleError(e);
    res.status(500).json({ ok: false, error: err.message, status: err.status });
  }
}

const ACTIONS = {
  config: async () => ({
    paytrConfigured: Boolean(process.env.PAYTR_MERCHANT_ID && process.env.PAYTR_MERCHANT_KEY && process.env.PAYTR_MERCHANT_SALT),
    paytrTestMode: process.env.PAYTR_TEST_MODE === '1',
    pricesSet: Object.fromEntries(['FIYAT_BIREYSEL', 'FIYAT_BIREYSEL_PAKET', 'FIYAT_CIFT', 'FIYAT_CIFT_PAKET'].map((k) => [k, Number(process.env[k]) > 0])),
    calendarConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALENDAR_ID && process.env.GOOGLE_REFRESH_TOKEN),
    cronSecretSet: Boolean(process.env.CRON_SECRET),
  }),

  // Gerçek randevu.js handler'ı; yalnızca PayTR get-token isteği taklit edilir.
  book: async (q) => callBooking({ date: q.date, time: q.time, sessionType: q.type, name: q.name || 'Denetim Danışan', email: q.email }),

  // Aynı slota eşzamanlı iki istek.
  race: async (q) => {
    const [a, b] = await Promise.all([
      callBooking({ date: q.date, time: q.time, sessionType: q.type, name: 'Yarış A', email: 'race-a@example.com' }),
      callBooking({ date: q.date, time: q.time, sessionType: q.type, name: 'Yarış B', email: 'race-b@example.com' }),
    ]);
    return { a, b };
  },

  // Sunucudaki gerçek PayTR anahtarıyla imzalanmış bildirim → gerçek paytr-callback handler'ı.
  callback: async (q) => {
    const record = await getBookingRecord(q.id);
    const amount = String(Math.round((record?.priceTl || 1) * 100));
    const fields = { merchant_oid: q.id, status: q.status, total_amount: amount, payment_amount: amount };
    fields.hash = crypto
      .createHmac('sha256', process.env.PAYTR_MERCHANT_KEY)
      .update(fields.merchant_oid + process.env.PAYTR_MERCHANT_SALT + fields.status + fields.total_amount)
      .digest('base64');
    const savedCal = process.env.GOOGLE_CALENDAR_ID;
    if (q.breakGoogle === '1') process.env.GOOGLE_CALENDAR_ID = 'invalid-audit-calendar-id';
    try {
      const r = await invoke(paytrCallbackHandler, { method: 'POST', headers: {}, query: {}, body: fields });
      return { callback: r, record: redact(await getBookingRecord(q.id)) };
    } finally {
      process.env.GOOGLE_CALENDAR_ID = savedCal;
    }
  },

  // Sahte imzalı bildirim reddediliyor mu?
  forged: async (q) => {
    const fields = { merchant_oid: q.id, status: 'success', total_amount: '100', hash: 'forged' };
    const r = await invoke(paytrCallbackHandler, { method: 'POST', headers: {}, query: {}, body: fields });
    return { callback: r, record: redact(await getBookingRecord(q.id)) };
  },

  booking: async (q) => {
    const record = await getBookingRecord(q.id);
    let event = null;
    try {
      const { data } = await calendar().events.get({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: bookingEventId(q.id) });
      event = {
        id: data.id,
        status: data.status,
        summary: data.summary,
        description: data.description,
        start: data.start,
        end: data.end,
        attendees: (data.attendees || []).map((a) => ({ email: a.email, organizer: !!a.organizer, responseStatus: a.responseStatus })),
        hangoutLink: data.hangoutLink,
        conferenceStatus: data.conferenceData?.createRequest?.status?.statusCode,
        conferenceType: data.conferenceData?.conferenceSolution?.key?.type,
        organizer: data.organizer,
        creator: data.creator,
        htmlLink: data.htmlLink,
      };
    } catch (e) {
      event = { error: describeGoogleError(e) };
    }
    return { record: redact(record), event };
  },

  cells: async (q) => {
    const r = getRedis();
    const out = {};
    for (const h of WORK_HOURS) {
      const k = `randevu:cell:${q.date}:${h}`;
      const [v, ttl] = await Promise.all([r.get(k), r.ttl(k)]);
      if (v != null) out[h] = { owner: String(v), ttlSeconds: ttl };
    }
    return out;
  },

  retrySet: async () => ({ ids: await getRedis().smembers('randevu:calendar:retry') }),

  retry: async () => ({ results: await retryFailedCalendarSyncs() }),

  // Tuğba'nın elle eklediği, Meet'siz bir etkinliği taklit eder.
  manual: async (q) => {
    const calendarId = q.calendar === 'primary' ? 'primary' : process.env.GOOGLE_CALENDAR_ID;
    const { data } = await calendar().events.insert({
      calendarId,
      sendUpdates: 'none',
      requestBody: {
        summary: 'Denetim — elle eklenen meşgul etkinlik',
        start: { dateTime: `${q.date}T${q.start}:00`, timeZone: 'Europe/Istanbul' },
        end: { dateTime: `${q.date}T${q.end}:00`, timeZone: 'Europe/Istanbul' },
      },
    });
    return { calendar: q.calendar === 'primary' ? 'primary' : 'booking', eventId: data.id };
  },

  deleteEvent: async (q) => {
    const calendarId = q.calendar === 'primary' ? 'primary' : process.env.GOOGLE_CALENDAR_ID;
    await calendar().events.delete({ calendarId, eventId: q.eventId, sendUpdates: 'none' });
    return { deleted: q.eventId };
  },

  // Test verilerini tamamen temizler: takvim etkinliği, hücreler, kayıt, log, retry.
  cleanup: async (q) => {
    const record = await getBookingRecord(q.id);
    let eventDeleted = false;
    try {
      await calendar().events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: bookingEventId(q.id), sendUpdates: 'none' });
      eventDeleted = true;
    } catch (e) {
      eventDeleted = describeGoogleError(e).status;
    }
    let released = 0;
    if (record) released = await releaseCells(record.date, record.cells, q.id);
    const r = getRedis();
    await r.del(`randevu:detay:${q.id}`);
    await r.lrem('randevu:log', 0, q.id);
    await clearCalendarRetry(q.id);
    return { eventDeleted, released, recordDeleted: Boolean(record) };
  },
};

async function callBooking(body) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://www.paytr.com/')) {
      return new Response(JSON.stringify({ status: 'success', token: 'AUDIT-NO-PAYMENT' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    const ip = `audit-${crypto.randomBytes(4).toString('hex')}`;
    return await invoke(randevuHandler, {
      method: 'POST',
      headers: { host: 'mutluaileiliskileri.com', 'x-forwarded-for': ip },
      query: {},
      body: { ...body, kvkkOnay: true, onamOnay: true },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function invoke(fn, req) {
  const res = {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  };
  await fn(req, res);
  return { status: res.statusCode, body: res.body };
}

function calendar() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}

function redact(record) {
  if (!record) return null;
  const { paymentUrl, ...rest } = record;
  return rest;
}

function isValidKey(received) {
  const expected = process.env.GOOGLE_TEST_KEY;
  if (!expected || typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
