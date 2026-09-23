import crypto from 'node:crypto';
import { google } from 'googleapis';
import { createOAuthClient } from './google.js';

/**
 * Google Calendar'a sunucu tarafında GOOGLE_REFRESH_TOKEN ile bağlanır.
 * Etkinlikler GOOGLE_CALENDAR_ID takvimine yazılır.
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
      process.env.GOOGLE_REDIRECT_URI &&
      process.env.GOOGLE_CALENDAR_ID &&
      process.env.GOOGLE_REFRESH_TOKEN
  );
}

function getCalendar() {
  const auth = createOAuthClient();
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}

/**
 * Google Meet linkli bir takvim etkinliği oluşturur.
 *
 * startDateTime / endDateTime: saat dilimi eki olmadan yerel İstanbul saati,
 * örn. "2026-09-25T10:00:00". email verilmezse davetli eklenmez.
 * summary verilmezse `${serviceName} — Tuğba Döngel` kullanılır.
 *
 * @returns {Promise<{ eventId: string, eventHtmlLink: string, meetUrl: string | null }>}
 */
export async function createGoogleMeetEvent({ name, email, startDateTime, endDateTime, serviceName, summary }) {
  const calendar = getCalendar();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const descriptionLines = [];
  if (name) descriptionLines.push(`Danışan: ${name}`);
  if (email) descriptionLines.push(`E-posta: ${email}`);

  const { data: created } = await calendar.events.insert({
    calendarId,
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary: summary || `${serviceName} — Tuğba Döngel`,
      description: descriptionLines.join('\n'),
      start: { dateTime: startDateTime, timeZone: TIME_ZONE },
      end: { dateTime: endDateTime, timeZone: TIME_ZONE },
      attendees: email ? [{ email, displayName: name || undefined }] : [],
      conferenceData: {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
  });

  let event = created;
  for (let i = 0; i < MEET_POLL_ATTEMPTS && !extractMeetUrl(event) && isConferencePending(event); i++) {
    await sleep(MEET_POLL_DELAY_MS);
    ({ data: event } = await calendar.events.get({ calendarId, eventId: created.id }));
  }

  return {
    eventId: event.id,
    eventHtmlLink: event.htmlLink,
    meetUrl: extractMeetUrl(event),
  };
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
  const message = e?.response?.data?.error?.message || e?.response?.data?.error || 'google_api_error';
  return { status, message: String(message) };
}
