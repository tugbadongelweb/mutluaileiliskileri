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

/** Bir tarih için dolu hücre kümesini döner (Set<string>, örn. {"10:00","14:00"}). */
export async function getOccupiedCells(dateStr) {
  const redis = getRedis();
  const members = await redis.smembers(`randevu:gun:${dateStr}`);
  return new Set(members || []);
}

/** Verilen başlangıç saatinden itibaren, seans türünün ihtiyaç duyduğu ardışık hücreleri döner; sığmıyorsa null. */
export function cellsNeededFrom(time, sessionType) {
  const need = cellsFor(sessionType);
  if (!need) return null;
  const idx = WORK_HOURS.indexOf(time);
  if (idx === -1) return null;
  if (idx + need > WORK_HOURS.length) return null;
  return WORK_HOURS.slice(idx, idx + need);
}

/**
 * Bir randevu için gereken hücreleri atomik biçimde ayırmaya çalışır (SADD ile
 * — küçük bir yarış payı var ama bu ölçekte pratikte yeterli; ileride Lua/WATCH
 * ile sıkılaştırılabilir). Başarılıysa true, hücrelerden biri zaten doluysa
 * false döner ve aldığı hücreleri geri bırakır.
 */
export async function tryReserveCells(dateStr, cells) {
  const redis = getRedis();
  const key = `randevu:gun:${dateStr}`;
  const occupied = await getOccupiedCells(dateStr);
  for (const c of cells) {
    if (occupied.has(c)) return false;
  }
  const added = await redis.sadd(key, ...cells);
  if (added !== cells.length) {
    // Yarış durumu: biri araya girdi. Sadece bizim eklediğimiz kısmı geri al
    // (basit yaklaşım: hepsini kontrol edip fazlalıkları bırakmadan çık).
    await redis.srem(key, ...cells);
    return false;
  }
  // Gün anahtarının süresiz şişmemesi için 400 gün TTL (yeterince uzun, geçmiş
  // tarihler zamanla düşer).
  await redis.expire(key, 60 * 60 * 24 * 400);
  return true;
}

export async function releaseCells(dateStr, cells) {
  const redis = getRedis();
  await redis.srem(`randevu:gun:${dateStr}`, ...cells);
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
