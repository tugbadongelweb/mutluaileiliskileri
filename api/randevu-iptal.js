import { getBookingRecord } from './_lib/redis.js';
import { isValidCancelToken, isCancellable, cancelBooking } from './_lib/cancel.js';
import { formatBookingWhen } from './_lib/notify.js';

/**
 * Tuğba'nın bildirim e-postasındaki iptal linki.
 *   GET  → randevu bilgileri + "İptal et" onay butonu (hiçbir şeyi değiştirmez;
 *          e-posta tarayıcıları linki otomatik açsa bile iptal olmaz)
 *   POST → imza doğrulanırsa randevuyu iptal eder.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const params = req.method === 'POST' ? parseBody(req.body) : req.query;
  const id = typeof params.id === 'string' ? params.id : '';
  const token = typeof params.t === 'string' ? params.t : '';

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).send('method_not_allowed');
    return;
  }
  if (!/^[0-9a-f]{32}$/.test(id) || !isValidCancelToken(id, token)) {
    page(res, 404, 'Bağlantı geçersiz', '<p>Bu iptal bağlantısı geçersiz veya eksik.</p>');
    return;
  }

  try {
    if (req.method === 'GET') {
      const record = await getBookingRecord(id);
      if (!record) {
        page(res, 404, 'Randevu bulunamadı', '<p>Bu randevu kaydı bulunamadı.</p>');
      } else if (record.status === 'iptal_edildi') {
        page(res, 200, 'Randevu zaten iptal edilmiş', `${summary(record)}<p>Bu randevu ${esc(fmtTime(record.cancelledAt))} tarihinde iptal edildi.</p>${refundNote(record)}`);
      } else if (!isCancellable(record)) {
        page(res, 409, 'İptal edilemez', `${summary(record)}<p>Bu randevunun ödemesi tamamlanmamış; iptal edilecek kesinleşmiş bir randevu yok.</p>`);
      } else {
        page(res, 200, 'Randevuyu iptal et', `${summary(record)}
<p>İptal edildiğinde:</p>
<ul><li>Saat sitede yeniden müsait olur.</li><li>Google Takvim etkinliği silinir ve danışana Google'dan iptal e-postası gider.</li><li><strong>Ödeme iadesi otomatik yapılmaz</strong> — PayTR panelinden ayrıca yapmanız gerekir.</li></ul>
<form method="POST" action="/api/randevu-iptal">
<input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="t" value="${esc(token)}">
<button type="submit" style="background:#c0392b;color:#fff;border:0;padding:12px 20px;border-radius:6px;font-size:16px;cursor:pointer">Randevuyu iptal et</button>
</form>`);
      }
      return;
    }

    const { result, record, calendarError } = await cancelBooking(id);
    if (result === 'cancelled') {
      page(res, 200, 'Randevu iptal edildi', `${summary(record)}
<p>✓ Saat sitede yeniden müsait.</p>
${calendarError
    ? `<p style="background:#fff4e5;border-left:4px solid #e67e22;padding:10px 12px">Google Takvim etkinliği silinemedi (${esc(calendarError)}). Lütfen etkinliği takvimden elle silin; danışana iptal bildirimi gitmemiş olabilir.</p>`
    : '<p>✓ Google Takvim etkinliği silindi, danışana iptal e-postası gönderildi.</p>'}
${refundNote(record)}`);
    } else if (result === 'already_cancelled') {
      page(res, 200, 'Randevu zaten iptal edilmiş', `${summary(record)}${refundNote(record)}`);
    } else if (result === 'not_cancellable') {
      page(res, 409, 'İptal edilemez', `${summary(record)}<p>Bu randevunun ödemesi tamamlanmamış.</p>`);
    } else if (result === 'busy') {
      page(res, 409, 'Lütfen tekrar deneyin', '<p>Randevu şu anda işleniyor. Birkaç saniye sonra tekrar deneyin.</p>');
    } else {
      page(res, 404, 'Randevu bulunamadı', '<p>Bu randevu kaydı bulunamadı.</p>');
    }
  } catch (e) {
    console.error('[randevu-iptal]', id, String(e && e.message || e));
    page(res, 500, 'Bir sorun oluştu', '<p>İşlem tamamlanamadı. Lütfen biraz sonra tekrar deneyin.</p>');
  }
}

function summary(r) {
  const rows = [
    ['Görüşme', r.sessionLabel],
    ['Tarih / saat', formatBookingWhen(r)],
    ['Danışan', r.name],
    ['E-posta', r.email],
    ['Telefon', r.phone || '—'],
  ];
  return `<table style="border-collapse:collapse;margin:0 0 16px">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('')}</table>`;
}

function refundNote(r) {
  if (!r.priceTl) return '';
  return `<p style="background:#eef6ff;border-left:4px solid #2f80ed;padding:10px 12px"><strong>İade hatırlatması:</strong> ${esc(r.priceTl)} TL ödeme için iadeyi PayTR panelinden yapın. PayTR sipariş no: <code>${esc(r.id)}</code></p>`;
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Istanbul' }).format(new Date(iso));
}

function parseBody(body) {
  if (typeof body === 'string') return Object.fromEntries(new URLSearchParams(body));
  return body || {};
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(res, status, title, body) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(status).send(`<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#222;max-width:560px;margin:40px auto;padding:0 16px}h1{font-size:22px}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`);
}
