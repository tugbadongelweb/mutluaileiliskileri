import crypto from 'node:crypto';
import {
  STATE_COOKIE,
  isGoogleConfigured,
  createOAuthClient,
  readCookie,
  stateCookie,
} from '../../lib/google.js';

/**
 * Google'ın yetkilendirme sonrası döndüğü adres (GOOGLE_REDIRECT_URI).
 * State'i cookie ile karşılaştırır, authorization code'u token'a çevirir ve
 * yalnızca refresh_token değerini ekranda gösterir. Bu değer elle
 * GOOGLE_REFRESH_TOKEN gibi bir Vercel ortam değişkenine kopyalanmalıdır.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  // State tek kullanımlık: her durumda cookie'yi temizle.
  res.setHeader('Set-Cookie', stateCookie('', 0));

  if (req.method !== 'GET') {
    res.status(405).send('method_not_allowed');
    return;
  }
  if (!isGoogleConfigured()) {
    sendPage(res, 500, 'Google yapılandırılmamış', '<p>GOOGLE_* ortam değişkenleri eksik.</p>');
    return;
  }

  const { code, state, error } = req.query;
  if (error) {
    sendPage(res, 400, 'Yetkilendirme reddedildi', `<p>Google yanıtı: ${escapeHtml(String(error))}</p>`);
    return;
  }

  const expected = readCookie(req, STATE_COOKIE);
  if (!isSameState(expected, state)) {
    sendPage(res, 400, 'Geçersiz istek', '<p>State doğrulanamadı. Lütfen <a href="/api/google/auth">/api/google/auth</a> adresinden yeniden başlayın.</p>');
    return;
  }
  if (typeof code !== 'string' || !code) {
    sendPage(res, 400, 'Geçersiz istek', '<p>Authorization code eksik.</p>');
    return;
  }

  try {
    const { tokens } = await createOAuthClient().getToken(code);
    if (!tokens.refresh_token) {
      sendPage(res, 200, 'Refresh token dönmedi',
        '<p>Google bu hesap için refresh token vermedi. Google Hesabı &gt; Güvenlik &gt; Üçüncü taraf erişimi bölümünden uygulamanın erişimini kaldırıp <a href="/api/google/auth">/api/google/auth</a> adresinden tekrar deneyin.</p>');
      return;
    }
    sendPage(res, 200, 'Refresh token alındı',
      `<p>Aşağıdaki değeri Vercel ortam değişkenine kaydedin. Bu sayfayı kapattıktan sonra tekrar gösterilmez.</p>
       <pre>${escapeHtml(tokens.refresh_token)}</pre>`);
  } catch (e) {
    // Hata nesnesi istek gövdesini (client secret dahil) içerebileceği için loglanmaz.
    const reason = e?.response?.data?.error || 'token_exchange_failed';
    console.error('Google token exchange failed:', reason);
    sendPage(res, 500, 'Token alınamadı', `<p>${escapeHtml(String(reason))}</p>`);
  }
}

function isSameState(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sendPage(res, status, title, body) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(status).send(`<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px}pre{white-space:pre-wrap;word-break:break-all;background:#f4f4f4;padding:12px;border-radius:6px}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`);
}
