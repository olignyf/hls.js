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

function activeBufferedIndex(
  media: Bufferable,
  currentTime: number,
): number | null {
  const b = media.buffered;
  if (!b.length) {
    return null;
  }
  for (let i = 0; i < b.length; i++) {
    const s = b.start(i);
    const e = b.end(i);
    if (currentTime >= s - 0.25 && currentTime <= e + 0.25) {
      return i;
    }
    if (currentTime < s) {
      return i > 0 ? i - 1 : 0;
    }
  }
  return b.length - 1;
}

/**
 * On quota: free space behind the playhead, then far-ahead prefetch, then ranges
 * fully before the playhead. Never removes data at/after `currentTime`.
 */
export function computeFlowEvictRange(
  media: Bufferable,
  currentTime: number,
  keepBehindSec: number = 12,
  maxAheadSec: number = 30,
): FlowEvictRange | null {
  const b = media.buffered;
  if (!b.length) {
    return null;
  }

  const activeIdx = activeBufferedIndex(media, currentTime);
  if (activeIdx === null) {
    return null;
  }

  const rangeStart = b.start(activeIdx);
  const rangeEnd = b.end(activeIdx);

  const behindSteps = [keepBehindSec, 4, 1, 0];
  for (let i = 0; i < behindSteps.length; i++) {
    const behind = behindSteps[i];
    const evictEnd = Math.min(rangeEnd, currentTime - behind);
    if (evictEnd > rangeStart + 0.5) {
      return { start: rangeStart, end: evictEnd };
    }
  }

  const aheadStart = currentTime + maxAheadSec;
  if (aheadStart < rangeEnd - 0.5) {
    return {
      start: Math.max(rangeStart, aheadStart),
      end: rangeEnd,
    };
  }

  if (activeIdx > 0) {
    const prevEnd = b.end(activeIdx - 1);
    if (prevEnd < currentTime - 0.25) {
      return { start: b.start(0), end: prevEnd };
    }
  }

  // Disjoint high-timestamp islands (bad progressive stitch) — drop whole ranges.
  // FIXME unit test to see if useful
  for (let i = 0; i < b.length; i++) {
    if (i === activeIdx) {
      continue;
    }
    if (b.start(i) > rangeEnd + 1) {
      return { start: b.start(i), end: b.end(i) };
    }
  }

  return null;
}
