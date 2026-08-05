// Pure formatting helpers for blame annotations: coarse relative time and an
// age bucket index used to pick a shared decoration colour (newest = 0).

export const AGE_BUCKETS = 5;

const DAY = 86_400;
// Upper bound (in days) for each bucket except the last, which is open-ended.
const BUCKET_DAY_LIMITS = [7, 30, 180, 365];

export function formatRelativeTime(authorTimeSec: number, nowSec: number): string {
  const diff = Math.max(0, nowSec - authorTimeSec);
  if (diff < 60) return '剛剛';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`;
  if (diff < DAY) return `${Math.floor(diff / 3600)} 小時前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))} 個月前`;
  return `${Math.floor(diff / (365 * DAY))} 年前`;
}

export function ageBucket(authorTimeSec: number, nowSec: number): number {
  const days = Math.max(0, nowSec - authorTimeSec) / DAY;
  for (let i = 0; i < BUCKET_DAY_LIMITS.length; i++) {
    if (days < BUCKET_DAY_LIMITS[i]) return i;
  }
  return AGE_BUCKETS - 1;
}
