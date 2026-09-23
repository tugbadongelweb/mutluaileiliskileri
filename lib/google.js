import { google } from 'googleapis';

/**
 * Google Calendar OAuth yardımcıları. Vercel ortam değişkenleri:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_CALENDAR_ID
 *
 * GOOGLE_REDIRECT_URI, Google Cloud Console'daki OAuth istemcisinde
 * "Authorized redirect URIs" listesine birebir eklenmiş olmalıdır, örn:
 * https://mutluaileiliskileri.com/api/google/callback
 */

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];

/** CSRF koruması için state değerini taşıyan cookie. */
export const STATE_COOKIE = 'google_oauth_state';
export const STATE_MAX_AGE = 600; // 10 dakika

export function isGoogleConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REDIRECT_URI
  );
}

export function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/** Cookie header'ından tek bir değeri okur. */
export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export function stateCookie(value, maxAge) {
  return `${STATE_COOKIE}=${encodeURIComponent(value)}; Path=/api/google; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
