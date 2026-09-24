import { Redis } from '@upstash/redis';

let client = null;

/** Lazily-created shared Upstash Redis client (uses Vercel-provisioned KV_REST_API_* env vars). */
export function getRedis() {
  if (!client) {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error('Upstash Redis yapılandırılmamış (KV_REST_API_URL / KV_REST_API_TOKEN eksik).');
    }
    client = new Redis({ url, token });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Randevu takvimi yardımcıları
// ---------------------------------------------------------------------------

/** Çalışma saatleri: hafta içi, 10:00–18:00 arası, saatlik hücreler. */
export const WORK_HOURS = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

export const SESSION_TYPES = {
  bireysel: { label: 'Bireysel Danışmanlık', minutes: 60, cells: 1 },
  bireysel_paket: { label: 'Bireysel Danışmanlık — Aylık Paket', minutes: 60, cells: 1 },
  cift: { label: 'Çift Danışmanlığı', minutes: 90, cells: 2 },
  cift_paket: { label: 'Çift Danışmanlığı — Aylık Paket', minutes: 90, cells: 2 },
};

/** YYYY-MM-DD biçiminde, tarihin hafta içi olup olmadığını doğrular (Pzt–Cuma). */
export function isWeekday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDay(); // 0=Pazar, 6=Cumartesi
  return day >= 1 && day <= 5;
}

// Randevu saatleri İstanbul saatidir. Türkiye 2016'dan beri yaz saati
// uygulamadan sabit UTC+3 kullanır.
export const TZ_OFFSET = '+03:00';

/** İstanbul saatine göre bugünün tarihi, YYYY-MM-DD. */
export function todayInIstanbul(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(now);
}

/** Bir tarihin bugünden (İstanbul) itibaren makul bir randevu penceresinde (0–60 gün) olduğunu doğrular. */
export function isWithinBookingWindow(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date(todayInIstanbul() + 'T00:00:00Z');
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
  return diffDays >= 0 && diffDays <= 60;
}

/** Hücrenin başlangıç anı (İstanbul saati) geçmişte mi — bugünün geçmiş saatleri satılamaz. */
export function isPastCell(dateStr, time, now = new Date()) {
  return new Date(`${dateStr}T${time}:00${TZ_OFFSET}`).getTime() <= now.getTime();
}

function cellsFor(sessionType) {
  const s = SESSION_TYPES[sessionType];
  return s ? s.cells : null;
}

// Her hücre ayrı bir anahtar olarak tutulur; ödeme bekleyen (henüz onaylanmamış)
// rezervasyonlar HOLD_TTL_SECONDS sonunda kendiliğinden serbest kalır — bu
// sayede ödeme tamamlamadan bırakılan randevular takvimi kalıcı olarak
// kilitlemez. Ödeme onaylanınca (veya PayTR yapılandırılmamışken doğrudan)
// confirmCells() ile süre uzun bir değere çekilir.
// PayTR ödeme sayfası timeout_limit (bkz. paytr.js, 20 dk) boyunca açık
// kalabilir; tutma süresi bundan uzun olmalı ki ödeme sürerken slot başkasına
// satılmasın.
const HOLD_TTL_SECONDS = 30 * 60; // ödeme bekleyen rezervasyon için 30 dakika
const CONFIRMED_TTL_SECONDS = 60 * 60 * 24 * 400; // onaylanmış randevu için ~400 gün

function cellKey(dateStr, time) {
  return `randevu:cell:${dateStr}:${time}`;
}

/** Bir tarih için dolu hücre kümesini döner (Set<string>, örn. {"10:00","14:00"}). */
export async function getOccupiedCells(dateStr) {
  const redis = getRedis();
  const keys = WORK_HOURS.map((h) => cellKey(dateStr, h));
  const values = await redis.mget(...keys);
  const occupied = new Set();
  WORK_HOURS.forEach((h, i) => { if (values[i] != null) occupied.add(h); });
  return occupied;
}

/**
 * Verilen başlangıç saatinden itibaren, seans türünün ihtiyaç duyduğu ardışık
 * hücreleri döner; sığmıyorsa null. 90 dakikalık (2 hücreli) türler için
 * randevular her zaman iki saatte bir (10:00, 12:00, 14:00, 16:00) başlar —
 * tek saatlik ilk hücreden (11:00, 13:00...) başlatılamaz.
 */
export function cellsNeededFrom(time, sessionType) {
  const need = cellsFor(sessionType);
  if (!need) return null;
  const idx = WORK_HOURS.indexOf(time);
  if (idx === -1) return null;
  if (need > 1 && idx % need !== 0) return null;
  if (idx + need > WORK_HOURS.length) return null;
  return WORK_HOURS.slice(idx, idx + need);
}

/**
 * Bir randevu için gereken hücreleri atomik biçimde ayırmaya çalışır: her
 * hücre için ayrı bir SET NX (var olmayan anahtara yazar) kullanılır — bu
 * gerçekten atomiktir, yarış payı yoktur. Hücrelerden biri zaten doluysa
 * false döner ve o ana kadar aldığı hücreleri geri bırakır. Yeni hücreler
 * HOLD_TTL_SECONDS sonunda otomatik boşalır (bkz. confirmCells).
 */
export async function tryReserveCells(dateStr, cells, bookingId) {
  const redis = getRedis();
  const claimed = [];
  for (const c of cells) {
    const key = cellKey(dateStr, c);
    const result = await redis.set(key, bookingId || '1', { nx: true, ex: HOLD_TTL_SECONDS });
    if (result !== 'OK') {
      for (const k of claimed) await redis.del(k);
      return false;
    }
    claimed.push(key);
  }
  return true;
}

// Hücreler yalnızca sahibi olan randevu (değeri = bookingId) tarafından
// bırakılabilir/onaylanabilir. Aksi halde tutma süresi dolmuş bir randevunun
// geç gelen PayTR bildirimi, aynı saati bu arada almış başka birinin
// hücresini silebilir veya uzatabilirdi. Kontrol + işlem Lua ile atomiktir.
const RELEASE_OWNED_SCRIPT = `
local n = 0
for _, k in ipairs(KEYS) do
  if redis.call('GET', k) == ARGV[1] then redis.call('DEL', k); n = n + 1 end
end
return n`;

// Sahibiyse süresini uzatır, boşsa (tutma süresi dolmuşsa) yeniden alır,
// başkasınınsa dokunmaz ve çakışma sayar.
const CONFIRM_OWNED_SCRIPT = `
local conflicts = 0
for _, k in ipairs(KEYS) do
  local v = redis.call('GET', k)
  if v == ARGV[1] then redis.call('EXPIRE', k, ARGV[2])
  elseif not v then redis.call('SET', k, ARGV[1], 'EX', ARGV[2])
  else conflicts = conflicts + 1 end
end
return conflicts`;

export async function releaseCells(dateStr, cells, bookingId) {
  const keys = cells.map((c) => cellKey(dateStr, c));
  return getRedis().eval(RELEASE_OWNED_SCRIPT, keys, [bookingId]);
}

/**
 * Ödeme onaylandığında (veya ödeme gerekmediğinde) randevunun hücrelerini
 * kalıcı hale getirir. Dönüş: başka bir randevuya ait olduğu için
 * alınamayan hücre sayısı (0 = sorun yok).
 */
export async function confirmCells(dateStr, cells, bookingId) {
  const keys = cells.map((c) => cellKey(dateStr, c));
  return Number(await getRedis().eval(CONFIRM_OWNED_SCRIPT, keys, [bookingId, String(CONFIRMED_TTL_SECONDS)]));
}

/** Aynı randevunun eşzamanlı işlenmesini engelleyen kısa süreli kilit. */
export async function acquireLock(name, ttlSeconds) {
  return (await getRedis().set(`lock:${name}`, '1', { nx: true, ex: ttlSeconds })) === 'OK';
}

export async function releaseLock(name) {
  await getRedis().del(`lock:${name}`);
}

// Takvim etkinliği oluşturulamayan randevular (bkz. google-calendar.js).
const CALENDAR_RETRY_SET = 'randevu:calendar:retry';

export async function markCalendarRetry(id) {
  await getRedis().sadd(CALENDAR_RETRY_SET, id);
}

export async function clearCalendarRetry(id) {
  await getRedis().srem(CALENDAR_RETRY_SET, id);
}

export async function listCalendarRetries() {
  return (await getRedis().smembers(CALENDAR_RETRY_SET)) || [];
}

export async function saveBookingRecord(id, record) {
  const redis = getRedis();
  await redis.set(`randevu:detay:${id}`, JSON.stringify(record));
  await redis.lpush('randevu:log', id);
}

export async function getBookingRecord(id) {
  const redis = getRedis();
  const raw = await redis.get(`randevu:detay:${id}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function updateBookingRecord(id, patch) {
  const current = await getBookingRecord(id);
  if (!current) return null;
  const next = Object.assign({}, current, patch);
  // saveBookingRecord değil: o, id'yi randevu:log listesine tekrar ekler.
  await getRedis().set(`randevu:detay:${id}`, JSON.stringify(next));
  return next;
}

/**
 * Basit sabit-pencere hız sınırlama: `key` (örn. IP adresi) `windowSeconds`
 * içinde en fazla `maxRequests` kez izin verilir. Kötüye kullanımı/otomatik
 * spam'i engellemek için — kimlik doğrulama gerektirmeyen uç noktalarda kritik.
 */
export async function checkRateLimit(key, maxRequests, windowSeconds) {
  const redis = getRedis();
  const rk = `ratelimit:${key}`;
  // Önce süreli anahtar oluşturulur, sonra artırılır (INCR süreyi korur).
  // INCR + ayrı EXPIRE'da EXPIRE başarısız olursa anahtar süresiz kalıp
  // o IP'yi kalıcı olarak engelleyebilirdi.
  await redis.set(rk, 0, { nx: true, ex: windowSeconds });
  const count = await redis.incr(rk);
  return { ok: count <= maxRequests, count };
}
