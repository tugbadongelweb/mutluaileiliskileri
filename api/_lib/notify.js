import { updateBookingRecord } from './redis.js';

/**
 * Yeni kesinleşen randevu için Tuğba'ya e-posta bildirimi (Resend API).
 * Ortam değişkenleri (Vercel, yalnızca sunucu):
 *   RESEND_API_KEY     — Resend API anahtarı; yoksa bildirim atlanır.
 *   NOTIFY_EMAIL_TO    — bildirimin gideceği adres (Tuğba).
 *   NOTIFY_EMAIL_FROM  — gönderen; Resend'de doğrulanmış alan adından olmalı.
 *                        Tanımlı değilse Resend'in test göndericisi kullanılır
 *                        (yalnızca Resend hesabının sahibine teslim eder).
 *
 * Randevu başına en fazla bir e-posta: kayıttaki notifiedAt ve Resend
 * Idempotency-Key ile tekrar gelen bildirimler ikinci e-posta göndermez.
 * Hata randevuyu/ödemeyi etkilemez; yalnızca loglanır ve kayda yazılır.
 */
export async function notifyNewBooking(record) {
  if (!record || record.notifiedAt) return;
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL_TO;
  if (!apiKey || !to) return;

  const { subject, text, html } = renderBookingEmail(record);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `booking-notify-${record.id}`,
      },
      body: JSON.stringify({
        from: process.env.NOTIFY_EMAIL_FROM || 'Randevu Sistemi <onboarding@resend.dev>',
        to: to.split(',').map((s) => s.trim()).filter(Boolean),
        subject,
        text,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`resend_${res.status}: ${body.message || body.name || 'error'}`);
    }
    await updateBookingRecord(record.id, { notifiedAt: new Date().toISOString(), notifyError: null });
  } catch (e) {
    const message = String(e && e.message || e);
    console.error('[notify] booking e-mail failed:', record.id, message);
    try { await updateBookingRecord(record.id, { notifyError: message }); } catch {}
  }
}

const TR_DATE = new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function renderBookingEmail(r) {
  const [h, m] = r.time.split(':').map(Number);
  const endTotal = h * 60 + m + (r.minutes || 60);
  const end = `${String(Math.floor(endTotal / 60)).padStart(2, '0')}:${String(endTotal % 60).padStart(2, '0')}`;
  const dateLabel = TR_DATE.format(new Date(`${r.date}T00:00:00Z`));

  const warnings = [];
  if (r.status === 'odendi_cakisma') {
    warnings.push('DİKKAT: Ödeme geç geldi ve bu saat bu arada başka bir randevuya geçmiş. Takvim etkinliği oluşturulmadı; danışanla iletişime geçip yeni saat belirlemeniz gerekiyor.');
  } else if (r.calendarSyncStatus !== 'synced') {
    warnings.push('DİKKAT: Google Calendar etkinliği henüz oluşturulamadı (sistem her gün otomatik yeniden deneyecek). Danışana Meet daveti gitmemiş olabilir.');
  }

  const rows = [
    ['Görüşme', r.sessionLabel],
    ['Tarih', dateLabel],
    ['Saat', `${r.time} – ${end} (İstanbul)`],
    ['Danışan', r.name],
    ['E-posta', r.email],
    ['Telefon', r.phone || '—'],
    ['Google Meet', r.meetUrl || '—'],
    ['Takvim', r.calendarEventLink || '—'],
    ['Ödeme', r.priceTl ? `${r.priceTl} TL` : '—'],
    ['Randevu no', r.id],
  ];

  const subject = `${warnings.length ? '⚠ ' : ''}Yeni randevu: ${r.name} — ${dateLabel} ${r.time}`;
  const text = [...warnings, warnings.length ? '' : null, ...rows.map(([k, v]) => `${k}: ${v}`)].filter((x) => x !== null).join('\n');
  const link = (v) => (/^https:\/\//.test(v) ? `<a href="${esc(v)}">${esc(v)}</a>` : esc(v));
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#222">
${warnings.map((w) => `<p style="background:#fff4e5;border-left:4px solid #e67e22;padding:10px 12px">${esc(w)}</p>`).join('\n')}
<h2 style="font-size:18px;margin:0 0 12px">Yeni randevu kesinleşti</h2>
<table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#666;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${link(String(v))}</td></tr>`).join('')}</table>
</div>`;
  return { subject, text, html };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
