import { verifyPaytrCallback } from './_lib/paytr.js';
import {
  getBookingRecord,
  updateBookingRecord,
  releaseCells,
  confirmCells,
  acquireLock,
  releaseLock,
} from './_lib/redis.js';
import { addBookingToCalendar } from './_lib/google-calendar.js';
import { notifyNewBooking } from './_lib/notify.js';

/**
 * PayTR'nin ödeme sonucu için sunucudan sunucuya çağırdığı bildirim (webhook)
 * adresi. PayTR panelinde "Bildirim URL" alanına bu fonksiyonun tam adresi
 * girilmelidir, örn: https://mutluaileiliskileri.com/api/paytr-callback
 *
 * Randevu YALNIZCA burada, imzası doğrulanmış status === 'success'
 * bildirimiyle kesinleşir; merchant_ok_url (tarayıcı dönüşü) hiçbir şeyi
 * onaylamaz.
 *
 * PayTR bu adrese POST eder; işlendikten sonra yanıt olarak SADECE "OK"
 * metni dönülmelidir — aksi halde PayTR bildirimi tekrar dener. Geçici bir
 * hata olursa bilerek OK dönülmez ki PayTR tekrar göndersin; işlem
 * idempotent olduğu için tekrar gelen bildirim ikinci kez işlem yapmaz.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('method_not_allowed');
    return;
  }

  let fields = req.body;
  if (typeof fields === 'string') {
    fields = Object.fromEntries(new URLSearchParams(fields));
  }
  fields = fields || {};

  const ok = verifyPaytrCallback(fields);
  if (!ok) {
    res.status(400).send('hash mismatch');
    return;
  }

  // randevu.js, id'yi (tire'siz UUID) doğrudan merchant_oid olarak kullanır,
  // bu yüzden burada ek bir eşleme tablosuna gerek yok.
  const id = String(fields.merchant_oid);
  const status = fields.status; // 'success' | 'failed'

  // Aynı bildirimin eşzamanlı iki kopyası aynı anda işlenmesin.
  const lockName = `paytr:${id}`;
  let locked = false;
  try {
    locked = await acquireLock(lockName, 120);
    if (!locked) {
      res.status(409).send('busy'); // PayTR daha sonra tekrar dener
      return;
    }

    const record = await getBookingRecord(id);
    if (!record) {
      console.error('[paytr-callback] unknown merchant_oid', id);
      res.status(200).send('OK');
      return;
    }

    if (status === 'success') {
      let paid = record;
      if (record.status === 'odeme_bekleniyor' || record.status === 'odeme_basarisiz') {
        // Hücreler hâlâ bu randevunundur (tutma süresi PayTR zaman aşımından
        // uzun). Çok geç gelen bir ödemede saat bu arada başkasına geçmişse
        // çift satış yapılmaz; kayıt elle ilgilenilmek üzere işaretlenir.
        const conflicts = await confirmCells(record.date, record.cells, id);
        paid = await updateBookingRecord(id, {
          status: conflicts ? 'odendi_cakisma' : 'odendi',
          paidAt: new Date().toISOString(),
          paytrTotalAmount: fields.total_amount,
          paytrPaymentAmount: fields.payment_amount,
        });
        if (conflicts) console.error('[paytr-callback] paid booking lost its slot, needs manual handling', id);
      }
      // Ödenmiş ama takvime henüz yazılamamış randevu için tekrar gelen
      // bildirim de güvenle yeniden dener (aynı etkinlik kimliği).
      if (paid.status === 'odendi') {
        await addBookingToCalendar(paid);
      }
      // Tuğba'ya bildirim (randevu başına bir kez; çakışma/takvim hatası uyarısıyla).
      await notifyNewBooking(await getBookingRecord(id));
    } else if (record.status === 'odeme_bekleniyor') {
      await updateBookingRecord(id, {
        status: 'odeme_basarisiz',
        failedAt: new Date().toISOString(),
        paytrFailedReason: fields.failed_reason_code || null,
      });
      await releaseCells(record.date, record.cells, id);
    }

    res.status(200).send('OK');
  } catch (e) {
    console.error('[paytr-callback]', id, String(e && e.message || e));
    res.status(500).send('error'); // OK dönülmez: PayTR bildirimi tekrar gönderir
  } finally {
    if (locked) {
      try { await releaseLock(lockName); } catch {}
    }
  }
}
