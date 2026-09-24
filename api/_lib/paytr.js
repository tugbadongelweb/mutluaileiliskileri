import crypto from 'node:crypto';

/**
 * PayTR "iFrame API" token üretimi. Hesap açıldığında Vercel ortam
 * değişkenlerine şunlar eklenmelidir:
 *   PAYTR_MERCHANT_ID, PAYTR_MERCHANT_KEY, PAYTR_MERCHANT_SALT
 * ve fiyatlar için (TL, ondalıksız kuruş cinsinden değil — aşağıda TL*100
 * ile kuruşa çevriliyor):
 *   FIYAT_BIREYSEL, FIYAT_BIREYSEL_PAKET, FIYAT_CIFT, FIYAT_CIFT_PAKET
 *
 * Bu üç PAYTR_* değişkeni tanımlı olmadığı sürece isPaytrConfigured() false
 * döner ve randevu akışı ödeme adımını atlayıp "ödeme sistemi yakında aktif
 * olacak" mesajıyla rezervasyonu tamamlar — kod değişikliği gerekmeden, sadece
 * ortam değişkenleri eklenince gerçek ödemeye geçilebilir.
 *
 * PayTR resmi dokümantasyonuna göre doğrulanmalı:
 * https://dev.paytr.com/iframe-api
 */

export function isPaytrConfigured() {
  return Boolean(
    process.env.PAYTR_MERCHANT_ID &&
      process.env.PAYTR_MERCHANT_KEY &&
      process.env.PAYTR_MERCHANT_SALT
  );
}

export function priceForSessionType(sessionType) {
  const map = {
    bireysel: process.env.FIYAT_BIREYSEL,
    bireysel_paket: process.env.FIYAT_BIREYSEL_PAKET,
    cift: process.env.FIYAT_CIFT,
    cift_paket: process.env.FIYAT_CIFT_PAKET,
  };
  const tl = Number(map[sessionType]);
  return Number.isFinite(tl) && tl > 0 ? tl : null;
}

/**
 * PayTR'den bir ödeme token'ı ister ve `https://www.paytr.com/odeme/guvenli/<token>`
 * adresini döner — bu adres hem iframe'e gömülebilir hem de doğrudan tam
 * sayfa yönlendirmesi (redirect) olarak kullanılabilir.
 */
export async function createPaytrPaymentUrl({
  merchantOid,
  amountTl,
  email,
  userName,
  userPhone,
  userIp,
  basketLabel,
  okUrl,
  failUrl,
}) {
  const merchantId = process.env.PAYTR_MERCHANT_ID;
  const merchantKey = process.env.PAYTR_MERCHANT_KEY;
  const merchantSalt = process.env.PAYTR_MERCHANT_SALT;
  const testMode = process.env.PAYTR_TEST_MODE === '1' ? '1' : '0';

  const paymentAmount = Math.round(amountTl * 100); // kuruş
  const userBasket = Buffer.from(
    JSON.stringify([[basketLabel, amountTl.toFixed(2), 1]])
  ).toString('base64');
  const noInstallment = '1';
  const maxInstallment = '0';
  const currency = 'TL';

  const hashStr =
    merchantId +
    userIp +
    merchantOid +
    email +
    paymentAmount +
    userBasket +
    noInstallment +
    maxInstallment +
    currency +
    testMode;

  const paytrToken = crypto
    .createHmac('sha256', merchantKey)
    .update(hashStr + merchantSalt)
    .digest('base64');

  const body = new URLSearchParams({
    merchant_id: merchantId,
    user_ip: userIp,
    merchant_oid: merchantOid,
    email,
    payment_amount: String(paymentAmount),
    paytr_token: paytrToken,
    user_basket: userBasket,
    debug_on: '0',
    no_installment: noInstallment,
    max_installment: maxInstallment,
    user_name: userName,
    user_address: 'Online görüşme — adres yok',
    user_phone: userPhone,
    merchant_ok_url: okUrl,
    merchant_fail_url: failUrl,
    timeout_limit: '20', // dakika; redis.js'teki HOLD_TTL_SECONDS (30 dk) bundan uzun olmalı
    currency,
    test_mode: testMode,
    lang: 'tr',
  });

  const res = await fetch('https://www.paytr.com/odeme/api/get-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (data.status !== 'success') {
    throw new Error('PayTR token alınamadı: ' + (data.reason || 'bilinmeyen hata'));
  }
  return 'https://www.paytr.com/odeme/guvenli/' + data.token;
}

/** PayTR bildirim (callback) imzasını sabit-zamanlı karşılaştırmayla doğrular. */
export function verifyPaytrCallback(fields) {
  const merchantKey = process.env.PAYTR_MERCHANT_KEY;
  const merchantSalt = process.env.PAYTR_MERCHANT_SALT;
  if (!merchantKey || !merchantSalt) return false;
  const { merchant_oid, status, total_amount, hash } = fields;
  if (typeof merchant_oid !== 'string' || !/^[0-9a-f]{32}$/.test(merchant_oid)) return false;
  if (typeof status !== 'string' || typeof total_amount !== 'string' || !total_amount || typeof hash !== 'string') return false;
  const hashStr = merchant_oid + merchantSalt + status + total_amount;
  const expected = crypto.createHmac('sha256', merchantKey).update(hashStr).digest('base64');
  const expectedBuf = Buffer.from(expected);
  const hashBuf = Buffer.from(hash);
  if (expectedBuf.length !== hashBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, hashBuf);
}
