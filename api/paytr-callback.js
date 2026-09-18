import { verifyPaytrCallback } from '../lib/paytr.js';
import { getBookingRecord, updateBookingRecord, releaseCells } from '../lib/redis.js';

/**
 * PayTR'nin ödeme sonucu için sunucudan sunucuya çağırdığı bildirim (webhook)
 * adresi. PayTR panelinde "Bildirim URL" alanına bu fonksiyonun tam adresi
 * girilmelidir, örn: https://mutluaileiliskileri.com/api/paytr-callback
 *
 * PayTR bu adrese POST eder; imza doğrulandıktan sonra yanıt olarak SADECE
 * "OK" metni dönülmelidir — aksi halde PayTR bildirimi tekrar dener.
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
  const id = fields.merchant_oid;
  const status = fields.status; // 'success' | 'failed'

  try {
    const record = await getBookingRecord(id);
    if (record && record.status === 'odeme_bekleniyor') {
      if (status === 'success') {
        await updateBookingRecord(id, { status: 'odendi', paidAt: new Date().toISOString() });
      } else {
        await updateBookingRecord(id, { status: 'odeme_basarisiz' });
        await releaseCells(record.date, record.cells);
      }
    }
    res.status(200).send('OK');
  } catch (e) {
    console.error('[paytr-callback]', e);
    res.status(200).send('OK'); // PayTR'ye her durumda OK dönülür; hata yukarıda loglanır.
  }
}
