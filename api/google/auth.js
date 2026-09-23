import crypto from 'node:crypto';
import {
  GOOGLE_SCOPES,
  STATE_MAX_AGE,
  isGoogleConfigured,
  createOAuthClient,
  stateCookie,
} from '../../lib/google.js';

/**
 * Google Calendar yetkilendirmesini başlatır: rastgele bir state üretip
 * HttpOnly cookie'ye yazar ve kullanıcıyı Google izin ekranına yönlendirir.
 * Bir kere ziyaret edilip refresh token alındıktan sonra tekrar gerekmez.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!isGoogleConfigured()) {
    res.status(500).json({ ok: false, error: 'google_not_configured' });
    return;
  }

  const state = crypto.randomBytes(32).toString('hex');
  const url = createOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state,
  });

  res.setHeader('Set-Cookie', stateCookie(state, STATE_MAX_AGE));
  res.redirect(302, url);
}
