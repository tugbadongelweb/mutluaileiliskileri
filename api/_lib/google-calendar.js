import crypto from 'node:crypto';
import { google } from 'googleapis';
import {
  WORK_HOURS,
  TZ_OFFSET,
  getBookingRecord,
  updateBookingRecord,
  markCalendarRetry,
  clearCalendarRetry,
  listCalendarRetries,
} from './redis.js';

/**
 * Google Calendar'a sunucu tarafında GOOGLE_REFRESH_TOKEN ile bağlanır.
 * Ortam değişkenleri (hepsi yalnızca sunucuda, Vercel'de):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
 *   GOOGLE_CALENDAR_ID — site randevularının yazıldığı takvim.
 *
 * Müsaitlik hesaplanırken hem GOOGLE_CALENDAR_ID hem de yetkilendiren
 * hesabın ana takvimi ("primary") FreeBusy ile sorgulanır; böylece Tuğba'nın
 * elle eklediği etkinlikler de o saati kapatır.
 */

export const TIME_ZONE = 'Europe/Istanbul';

// Meet linki etkinlik oluşturulduktan sonra asenkron hazırlanabilir;
// en fazla MEET_POLL_ATTEMPTS kez, MEET_POLL_DELAY_MS arayla kontrol edilir.
const MEET_POLL_ATTEMPTS = 5;
const MEET_POLL_DELAY_MS = 1000;

export function isCalendarConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_CALENDAR_ID &&
      process.env.GOOGLE_REFRESH_TOKEN
  );
}

function getCalendar() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}

/**
 * Site randevusunun takvim etkinliği kimliği. Randevu id'si 32 haneli hex
 * olduğundan Google'ın izin verdiği base32hex alfabesine (0-9, a-v) uyar.
 * Aynı randevu için her deneme aynı kimliği kullandığından Google ikinci bir
 * etkinlik oluşturmaz (409) — 1 randevu = 1 etkinlik = 1 Meet.
 */
export function bookingEventId(bookingId) {
  return `rdv${bookingId}`;
}

/**
 * Google Meet linkli bir takvim etkinliği oluşturur.
 *
 * startDateTime / endDateTime: saat dilimi eki olmadan yerel İstanbul saati,
 * örn. "2026-09-25T10:00:00". email verilmezse davetli eklenmez.
 * summary verilmezse `${serviceName} — Tuğba Döngel` kullanılır.
 * eventId verilirse ve o kimlikle etkinlik zaten varsa yenisi açılmaz,
 * mevcut etkinlik döner.
 *
 * @returns {Promise<{ eventId: string, eventHtmlLink: string, meetUrl: string | null }>}
 */
export async function createGoogleMeetEvent({ name, email, startDateTime, endDateTime, serviceName, summary, description, eventId, requestId }) {
  const calendar = getCalendar();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const descriptionLines = [];
  if (serviceName) descriptionLines.push(`Görüşme: ${serviceName}`);
  if (name) descriptionLines.push(`Danışan: ${name}`);
  if (email) descriptionLines.push(`E-posta: ${email}`);
  if (description) descriptionLines.push(description);

  let event;
  try {
    ({ data: event } = await calendar.events.insert({
      calendarId,
      conferenceDataVersion: 1,
      sendUpdates: 'all',
      requestBody: {
        id: eventId,
        summary: summary || `${serviceName} — Tuğba Döngel`,
        description: descriptionLines.join('\n'),
        start: { dateTime: startDateTime, timeZone: TIME_ZONE },
        end: { dateTime: endDateTime, timeZone: TIME_ZONE },
        attendees: email ? [{ email, displayName: name || undefined }] : [],
        conferenceData: {
          createRequest: {
            requestId: requestId || eventId || crypto.randomUUID(),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
    }));
  } catch (e) {
    // Bu kimlikle etkinlik zaten oluşturulmuş (önceki deneme / tekrar gelen bildirim).
    if (!(eventId && e?.response?.status === 409)) throw e;
    ({ data: event } = await calendar.events.get({ calendarId, eventId }));
  }

  for (let i = 0; i < MEET_POLL_ATTEMPTS && !extractMeetUrl(event) && isConferencePending(event); i++) {
    await sleep(MEET_POLL_DELAY_MS);
    ({ data: event } = await calendar.events.get({ calendarId, eventId: event.id }));
  }

  return {
    eventId: event.id,
    eventHtmlLink: event.htmlLink,
    meetUrl: extractMeetUrl(event),
  };
}

/**
 * Kesinleşmiş (ödenmiş) bir randevu için Meet'li takvim etkinliğini oluşturur
 * ve sonucu kayda yazar. Takvim hatası randevuyu/ödemeyi bozmaz: kayıt
 * calendarSyncStatus = "failed" + calendarError ile işaretlenir ve yeniden
 * deneme listesine eklenir (bkz. retryFailedCalendarSyncs). Yeniden deneme
 * aynı etkinlik kimliğini kullandığından ikinci etkinlik açılmaz.
 */
export async function addBookingToCalendar(record) {
  if (record.calendarSyncStatus === 'synced') return record;
  if (!isCalendarConfigured()) {
    return markCalendarFailed(record, null, 'google_calendar_not_configured');
  }
  try {
    const result = await createGoogleMeetEvent({
      name: record.name,
      email: record.email,
      startDateTime: `${record.date}T${record.time}:00`,
      endDateTime: `${record.date}T${addMinutes(record.time, record.minutes)}:00`,
      serviceName: record.sessionLabel,
      description: [record.phone ? `Telefon: ${record.phone}` : '', `Randevu no: ${record.id}`].filter(Boolean).join('\n'),
      eventId: bookingEventId(record.id),
      requestId: record.id,
    });
    if (!result.meetUrl) {
      return markCalendarFailed(record, result, 'meet_link_not_ready');
    }
    const next = await updateBookingRecord(record.id, {
      calendarSyncStatus: 'synced',
      calendarEventId: result.eventId,
      calendarEventLink: result.eventHtmlLink,
      meetUrl: result.meetUrl,
      calendarError: null,
      calendarSyncedAt: new Date().toISOString(),
    });
    await clearCalendarRetry(record.id);
    return next;
  } catch (e) {
    const err = describeGoogleError(e);
    return markCalendarFailed(record, null, err.message, err.status);
  }
}

async function markCalendarFailed(record, partial, message, status = null) {
  console.error('[google-calendar] booking event failed:', record.id, status, message);
  let next = null;
  try {
    next = await updateBookingRecord(record.id, {
      calendarSyncStatus: 'failed',
      calendarError: message,
      calendarFailedAt: new Date().toISOString(),
      ...(partial ? { calendarEventId: partial.eventId, calendarEventLink: partial.eventHtmlLink } : {}),
    });
    await markCalendarRetry(record.id);
  } catch (e) {
    console.error('[google-calendar] could not mark failure:', record.id, String(e && e.message || e));
  }
  return next;
}

/** Takvime yazılamamış ödenmiş randevuları yeniden dener (cron). */
export async function retryFailedCalendarSyncs(limit = 20) {
  const ids = (await listCalendarRetries()).slice(0, limit);
  const results = [];
  for (const id of ids) {
    const record = await getBookingRecord(id);
    if (!record || !isConfirmedStatus(record.status) || record.calendarSyncStatus === 'synced') {
      await clearCalendarRetry(id);
      results.push({ id, result: 'skipped' });
      continue;
    }
    const next = await addBookingToCalendar(record);
    results.push({ id, result: next?.calendarSyncStatus || 'failed' });
  }
  return results;
}

export function isConfirmedStatus(status) {
  return status === 'odendi' || status === 'onaylandi';
}

/**
 * Bir gün için Google Calendar'da meşgul olan çalışma saati hücrelerini döner
 * (Set<"HH:MM">). Etkinliğin Meet içerip içermemesi önemsizdir; Google'ın
 * "busy" saydığı her aralık (şeffaf/"free" işaretli olmayan her etkinlik)
 * çakıştığı hücreyi kapatır. Hata durumunda istisna fırlatır — çağıran taraf
 * güvenli tarafta kalıp slotu satmamalıdır.
 */
export async function getGoogleBusyCells(dateStr) {
  const calendarIds = [...new Set([process.env.GOOGLE_CALENDAR_ID, 'primary'])];
  const dayStart = new Date(`${dateStr}T00:00:00${TZ_OFFSET}`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

  const { data } = await getCalendar().freebusy.query({
    requestBody: {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      timeZone: TIME_ZONE,
      items: calendarIds.map((id) => ({ id })),
    },
  });

  const intervals = [];
  for (const [id, cal] of Object.entries(data.calendars || {})) {
    if (cal.errors && cal.errors.length) {
      const reason = cal.errors.map((x) => x.reason).join(',');
      throw new Error(`freebusy_error:${id === 'primary' ? 'primary' : 'booking_calendar'}:${reason}`);
    }
    for (const b of cal.busy || []) intervals.push([new Date(b.start).getTime(), new Date(b.end).getTime()]);
  }

  const busy = new Set();
  for (const h of WORK_HOURS) {
    const cellStart = new Date(`${dateStr}T${h}:00${TZ_OFFSET}`).getTime();
    const cellEnd = cellStart + 60 * 60 * 1000;
    if (intervals.some(([s, e]) => s < cellEnd && e > cellStart)) busy.add(h);
  }
  return busy;
}

/** "HH:MM" + dakika → "HH:MM" (aynı gün içinde). */
function addMinutes(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function extractMeetUrl(event) {
  if (event.hangoutLink) return event.hangoutLink;
  const video = event.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video');
  return video?.uri || null;
}

function isConferencePending(event) {
  const status = event.conferenceData?.createRequest?.status?.statusCode;
  // Durum bilgisi hiç yoksa da birkaç kez kontrol etmeye değer.
  return !status || status === 'pending';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Google API hatasından yalnızca güvenli alanları (durum kodu ve mesaj) çıkarır. */
export function describeGoogleError(e) {
  const status = e?.response?.status || e?.code || null;
  const message = e?.response?.data?.error?.message || e?.response?.data?.error || e?.message || 'google_api_error';
  return { status, message: String(message) };
}
