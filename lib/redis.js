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
  cift: { label: 'Çift Danışmanlığı', minutes: 90, cells: 2 },
  aile: { label: 'Aile Danışmanlığı', minutes: 90, cells: 2 },
};

/** YYYY-MM-DD biçiminde, tarihin hafta içi olup olmadığını doğrular (Pzt–Cuma). */
export function isWeekday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDay(); // 0=Pazar, 6=Cumartesi
  return day >= 1 && day <= 5;
}

/** Bir tarihin bugünden itibaren makul bir randevu penceresinde (0–60 gün) olduğunu doğrular. */
export function isWithinBookingWindow(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
  return diffDays >= 0 && diffDays <= 60;
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
const HOLD_TTL_SECONDS = 15 * 60; // ödeme bekleyen rezervasyon için 15 dakika
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

export async function releaseCells(dateStr, cells) {
  const redis = getRedis();
  const keys = cells.map((c) => cellKey(dateStr, c));
  await redis.del(...keys);
}

/** Ödeme onaylandığında (veya ödeme gerekmediğinde) hücrelerin süresini uzun bir değere çeker. */
export async function confirmCells(dateStr, cells) {
  const redis = getRedis();
  for (const c of cells) {
    await redis.expire(cellKey(dateStr, c), CONFIRMED_TTL_SECONDS);
  }
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
  await saveBookingRecord(id, next);
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
  const count = await redis.incr(rk);
  if (count === 1) {
    await redis.expire(rk, windowSeconds);
  }
  return { ok: count <= maxRequests, count };
}
