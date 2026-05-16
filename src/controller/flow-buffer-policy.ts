import type { BufferFlushingData } from '../types/events';
import type { Bufferable } from '../utils/buffer-helper';

export type FlowEvictRange = { start: number; end: number };

/** Reject full MSE wipes — flow mode trims locally and keeps decoding forward. */
export function flowAllowsBufferFlush(
  data: BufferFlushingData,
  _media: Bufferable | null,
): boolean {
  const { startOffset, endOffset } = data;
  if (startOffset <= 0 && !Number.isFinite(endOffset)) {
    return false;
  }
  if (startOffset <= 0 && endOffset === Number.POSITIVE_INFINITY) {
    return false;
  }
  return true;
}

/** Gapped timeline (discontinuity): do not front-flush across holes. */
export function flowShouldTrimFrontBuffer(media: Bufferable | null): boolean {
  if (!media?.buffered) {
    return false;
  }
  return media.buffered.length < 2;
}

/**
 * On quota: trim only within the buffered range that contains the playhead.
 * Never drops whole prior ranges (PTS discontinuities stay in MSE until back-trim).
 */
export function computeFlowEvictRange(
  media: Bufferable,
  currentTime: number,
  keepBehindSec: number = 12,
): FlowEvictRange | null {
  const b = media.buffered;
  if (!b.length) {
    return null;
  }

  let activeIdx = 0;
  for (let i = 0; i < b.length; i++) {
    const s = b.start(i);
    const e = b.end(i);
    if (currentTime >= s - 0.25 && currentTime <= e + 0.25) {
      activeIdx = i;
      break;
    }
    if (currentTime < s) {
      return null;
    }
    activeIdx = i;
  }

  const rangeStart = b.start(activeIdx);
  const rangeEnd = b.end(activeIdx);
  const evictEnd = Math.min(rangeEnd, currentTime - keepBehindSec);
  if (evictEnd > rangeStart + 0.5) {
    return { start: rangeStart, end: evictEnd };
  }

  return null;
}
