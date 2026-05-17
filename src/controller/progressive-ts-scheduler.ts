import { FragmentState } from './fragment-tracker';
import {
  type Fragment,
  isMediaFragment,
  type MediaFragment,
} from '../loader/fragment';
import {
  type Bufferable,
  BufferHelper,
  type BufferInfo,
} from '../utils/buffer-helper';
import type { HlsConfig } from '../config';
import type { LevelDetails } from '../loader/level-details';
import type { TimestampOffset } from '../utils/timescale-conversion';

/** Max seconds of demuxed media to keep ahead of playhead in progressive TS mode. */
export function getProgressiveMaxAheadSec(
  config: Pick<HlsConfig, 'progressiveTsMaxAheadSec' | 'maxBufferLength'>,
): number {
  const ahead = config.progressiveTsMaxAheadSec;
  if (Number.isFinite(ahead) && ahead > 0) {
    return ahead;
  }
  return config.maxBufferLength;
}

/**
 * Sequential byte-range / raw-TS scheduling: advance by segment SN and demuxed
 * timeline, not playlist EXTINF × position. Seeking (VoD only) uses known file
 * bytes when available.
 */
export function vodFileBytesFromDetails(details: LevelDetails): number | null {
  if (details.live && details.type !== 'VOD') {
    return null;
  }
  const frags = details.fragments;
  if (!frags.length) {
    return null;
  }
  const last = frags[frags.length - 1];
  const end = last.byteRangeEndOffset;
  return typeof end === 'number' && Number.isFinite(end) && end > 0
    ? end
    : null;
}

/** Fragment whose timeline range contains `time`, or the last fragment before it. */
export function findFragmentIndexByTimeline(
  fragments: MediaFragment[],
  time: number,
): number {
  if (!fragments.length) {
    return 0;
  }
  let lo = 0;
  let hi = fragments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fragments[mid].start <= time) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function findFragmentIndexByByte(
  fragments: MediaFragment[],
  bytePos: number,
): number {
  if (!fragments.length) {
    return 0;
  }
  let lo = 0;
  let hi = fragments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const start = fragments[mid].byteRangeStartOffset ?? 0;
    if (bytePos < start) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const f = fragments[lo];
  if (f && bytePos < (f.byteRangeStartOffset ?? 0) && lo > 0) {
    return lo - 1;
  }
  return lo;
}

/** Same MPEG-TS timeline for every byte-range chunk — use first initPTS, not per-cc. */
export function getProgressiveInitPTS(
  initPTS: Array<TimestampOffset | undefined>,
): TimestampOffset | undefined {
  const row = initPTS[0];
  return row?.timescale ? row : undefined;
}

/**
 * End of the contiguous buffered prefix from the first range (stops at the first MSE hole).
 * Serial progressive append must stitch here — not at a mis-timed later TimeRange.
 */
export function getSerialMseAppendTail(
  media: Bufferable | null,
  maxGapSec: number = 0.5,
): number | null {
  if (!media) {
    return null;
  }
  const ranges = BufferHelper.bufferedRanges(media);
  if (!ranges.length) {
    return null;
  }
  let tail = ranges[0].end;
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start - tail > maxGapSec) {
      break;
    }
    tail = Math.max(tail, ranges[i].end);
  }
  return tail;
}

/** Evict a mis-stitched high-timestamp MSE island (serial tail is still near playhead). */
// FIXME verify if needed
export function progressiveBogusIslandEvictRange(
  media: Bufferable | null,
): { start: number; end: number } | null {
  const serialTail = getSerialMseAppendTail(media);
  if (serialTail === null) {
    return null;
  }
  const ranges = BufferHelper.bufferedRanges(media);
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i].start > serialTail + 1) {
      return { start: ranges[i].start, end: ranges[i].end };
    }
  }
  return null;
}

/**
 * MSE timestampOffset for progressive TS byte-range: transmuxed fMP4 sample decode
 * times stay on the MPEG-TS initPTS axis (~92220s). Presentation time is
 * decodeTime + timestampOffset, so use a constant −initPTS for every chunk — not
 * tail − initPTS (that only works when decode times are 0-based per fragment).
 */
export function progressiveContinuousAppendOffset(
  _media: Bufferable | null,
  initPTS: { baseTime: number; timescale: number } | undefined,
): number | undefined {
  if (!initPTS?.timescale) {
    return undefined;
  }
  return -initPTS.baseTime / initPTS.timescale;
}

/** True when serial MSE timeline includes this fragment's demuxed end. */
export function progressiveSerialMseCoversFrag(
  media: Bufferable | null,
  frag: MediaFragment,
  marginSec: number = 0.35,
): boolean {
  const tail = getSerialMseAppendTail(media);
  if (tail === null) {
    return false;
  }
  const expectEnd =
    Number.isFinite(frag.endPTS) && (frag.endPTS as number) > 0
      ? (frag.endPTS as number)
      : frag.start + frag.duration;
  return tail + marginSec >= expectEnd;
}

/**
 * Gate serial prefetch: enough ahead in MSE, and the last fragment actually landed
 * before pulling another ~4MB chunk.
 */
export function progressiveShouldLoadNextFragment(
  media: Bufferable | null,
  currentTime: number,
  maxAheadSec: number,
  fragPrevious: MediaFragment | null,
  initPTS?: Array<TimestampOffset | undefined>,
  lastBufferedFrag?: MediaFragment | null,
): boolean {
  const hasInitPTS = !!getProgressiveInitPTS(initPTS ?? [])?.timescale;
  if (!hasInitPTS) {
    // initPTS is discovered by transmuxing the first byte-range chunk — do not
    // block the bootstrap load waiting for it.
    if (
      getSerialMseAppendTail(media) === null &&
      !fragPrevious &&
      !lastBufferedFrag
    ) {
      return shouldKeepFlowPrefetching(media, currentTime, 0, maxAheadSec);
    }
    return false;
  }
  if (!shouldKeepFlowPrefetching(media, currentTime, 0, maxAheadSec)) {
    return false;
  }
  const coverageFrag = lastBufferedFrag ?? fragPrevious;
  if (coverageFrag && !progressiveSerialMseCoversFrag(media, coverageFrag)) {
    return false;
  }
  if (fragPrevious && !progressiveSerialMseCoversFrag(media, fragPrevious)) {
    return false;
  }
  if (fragPrevious && progressiveFragNeedsMseCoverage(fragPrevious, media)) {
    return false;
  }
  return true;
}

export function getLastBufferedEnd(media: Bufferable | null): number | null {
  if (!media) {
    return null;
  }
  const ranges = BufferHelper.bufferedRanges(media);
  if (!ranges.length) {
    return null;
  }
  return ranges[ranges.length - 1].end;
}

/** Playhead in a gap with a later buffered range already in MSE (PTS discontinuity). */
export function getPlayheadBufferedHole(
  media: Bufferable | null,
  currentTime: number,
): { nextStart: number; gap: number; prevEnd: number | null } | null {
  if (!media || !Number.isFinite(currentTime)) {
    return null;
  }
  if (BufferHelper.isBuffered(media, currentTime)) {
    return null;
  }
  const info = BufferHelper.bufferInfo(media, currentTime, 0);
  const nextStart = info.nextStart;
  if (nextStart === undefined || nextStart <= currentTime + 0.02) {
    return null;
  }
  let prevEnd: number | null = null;
  const b = media.buffered;
  if (b?.length) {
    for (let i = 0; i < b.length; i++) {
      if (b.end(i) <= currentTime + 0.05) {
        prevEnd = b.end(i);
      }
    }
  }
  return { nextStart, gap: nextStart - currentTime, prevEnd };
}

/** Seconds of demuxed media at/after playhead on the serial timeline (ignores mis-timed ranges). */
export function progressiveBufferedAheadSec(
  media: Bufferable | null,
  currentTime: number,
): number {
  const tail = getSerialMseAppendTail(media);
  if (tail === null || !Number.isFinite(currentTime)) {
    return 0;
  }
  return Math.max(0, tail - currentTime);
}

/** Jump target when next range is already buffered; does not skip file bytes. */
export function progressiveHoleJumpTarget(
  media: Bufferable | null,
  currentTime: number,
  maxJumpSec: number,
  paddingSec: number = 0.05,
): number | null {
  const hole = getPlayheadBufferedHole(media, currentTime);
  if (!hole || hole.gap > maxJumpSec) {
    return null;
  }
  const bufInfo = BufferHelper.bufferInfo(media!, currentTime, 0);
  if (!shouldJumpBufferedHole(bufInfo, currentTime, maxJumpSec)) {
    return null;
  }
  return hole.nextStart + paddingSec;
}

/** Playhead past MSE data (scrubber uses playlist duration, buffer uses demux timeline). */
export function isPlayheadPastBuffered(
  media: Bufferable | null,
  currentTime: number,
  marginSec: number = 0.5,
): boolean {
  if (!media || !Number.isFinite(currentTime)) {
    return false;
  }
  if (BufferHelper.isBuffered(media, currentTime)) {
    return false;
  }
  const lastEnd = getLastBufferedEnd(media);
  return lastEnd !== null && currentTime > lastEnd + marginSec;
}

export function progressiveFwdBufferAnchor(
  media: Bufferable | null,
  currentTime: number,
): number {
  if (
    media &&
    Number.isFinite(currentTime) &&
    BufferHelper.isBuffered(media, currentTime)
  ) {
    return currentTime;
  }
  const hole = getPlayheadBufferedHole(media, currentTime);
  if (hole?.prevEnd != null) {
    return Math.max(0, hole.prevEnd - 1e-3);
  }
  const lastEnd = getLastBufferedEnd(media);
  if (lastEnd !== null) {
    return Math.max(0, lastEnd - 1e-3);
  }
  return Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
}

export function progressiveLoadTarget(
  bufferInfo: BufferInfo,
  media: Bufferable | null,
  currentTime: number,
): number {
  if (isPlayheadPastBuffered(media, currentTime)) {
    const lastEnd = getLastBufferedEnd(media);
    return lastEnd !== null ? lastEnd : bufferInfo.end;
  }
  return bufferInfo.end;
}

export type PickNextProgressiveOpts = {
  /** Live TS: load next SN only; no byte-ratio seek. */
  liveSequential: boolean;
  /** Playlist-time seek / scrub position (seconds). Only used with `forceByteSeek`. */
  seekMediaTime?: number;
  knownFileBytes?: number | null;
  /** User scrub only: map `seekMediaTime` to bytes. Never set for automatic playback. */
  forceByteSeek?: boolean;
};

/** Highest SN already loaded/appended — for serial resume when `fragPrevious` was cleared. */
export function lastSerialLoadedSn(
  details: LevelDetails,
  getState: (frag: Fragment) => FragmentState,
): number | null {
  const frags = details.fragments;
  for (let i = frags.length - 1; i >= 0; i--) {
    const frag = frags[i];
    if (!isMediaFragment(frag)) {
      continue;
    }
    const st = getState(frag);
    if (st === FragmentState.OK || st === FragmentState.APPENDING) {
      return frag.sn;
    }
  }
  return null;
}

export function pickNextProgressiveFragment(
  details: LevelDetails,
  fragPrevious: MediaFragment | null,
  getState: (frag: Fragment) => FragmentState,
  opts: PickNextProgressiveOpts,
): MediaFragment | null {
  const frags = details.fragments;
  if (!frags.length) {
    return null;
  }

  let startIdx = 0;

  const useByteSeek =
    !opts.liveSequential &&
    opts.forceByteSeek &&
    opts.seekMediaTime !== undefined &&
    !!opts.knownFileBytes &&
    !!details.totalduration;

  if (useByteSeek) {
    const ratio = Math.max(
      0,
      Math.min(1, opts.seekMediaTime! / details.totalduration),
    );
    const bytePos = Math.floor(ratio * opts.knownFileBytes!);
    startIdx = findFragmentIndexByByte(frags, bytePos);
  } else if (fragPrevious) {
    startIdx = fragPrevious.sn - details.startSN + 1;
  } else {
    const lastSn = lastSerialLoadedSn(details, getState);
    startIdx = lastSn !== null ? lastSn - details.startSN + 1 : 0;
  }

  if (startIdx < 0) {
    startIdx = 0;
  }
  if (startIdx >= frags.length) {
    return null;
  }

  for (let i = startIdx; i < frags.length; i++) {
    const frag = frags[i];
    if (!isMediaFragment(frag)) {
      continue;
    }
    const st = getState(frag);
    if (st !== FragmentState.OK && st !== FragmentState.APPENDING) {
      return frag;
    }
  }

  return null;
}

/** Decoder waiting while MSE still has media ahead — keep loading, don't treat as empty buffer. */
export function progressiveShouldIgnoreStallReport(
  bufferInfo: BufferInfo,
  minForwardSec: number,
): boolean {
  return bufferInfo.len >= minForwardSec;
}

/** True when fragment tracker says OK but MSE has not reached this segment's demux tail. */
export function progressiveFragNeedsMseCoverage(
  frag: MediaFragment,
  media: Bufferable | null,
  marginSec: number = 0.35,
): boolean {
  const tail = getSerialMseAppendTail(media);
  if (tail === null) {
    return true;
  }
  const expectEnd =
    Number.isFinite(frag.endPTS) && (frag.endPTS as number) > 0
      ? (frag.endPTS as number)
      : frag.start + frag.duration;
  return tail + marginSec < expectEnd;
}

export function clearBogusOkFragmentsAhead(
  details: LevelDetails,
  fragPrevious: MediaFragment | null,
  media: Bufferable | null,
  getState: (f: Fragment) => FragmentState,
  removeFragment: (f: Fragment) => void,
): void {
  if (!fragPrevious || !media) {
    return;
  }
  for (let sn = fragPrevious.sn + 1; sn <= details.endSN; sn++) {
    const f = details.fragments[sn - details.startSN];
    if (!f || !isMediaFragment(f)) {
      continue;
    }
    const st = getState(f);
    if (st === FragmentState.OK) {
      if (progressiveFragNeedsMseCoverage(f, media)) {
        removeFragment(f);
      } else {
        break;
      }
    }
  }
}

function mseRangeAtPlayhead(
  media: Bufferable | null,
  timelineStart: number,
): { mseStart: number; mseEnd: number } | null {
  if (!media?.buffered || !Number.isFinite(timelineStart)) {
    return null;
  }
  const b = media.buffered;
  for (let i = 0; i < b.length; i++) {
    const s = b.start(i);
    const e = b.end(i);
    if (timelineStart >= s - 0.5 && timelineStart <= e + 0.5) {
      return { mseStart: s, mseEnd: e };
    }
  }
  if (b.length > 0) {
    const i = b.length - 1;
    return { mseStart: b.start(i), mseEnd: b.end(i) };
  }
  return null;
}

/**
 * Rewrite playlist segment start/duration from demuxed PTS and MSE as fragments arrive
 * ("go with the flow" timeline instead of precomputed EXTINF).
 */
export function syncFlowTimelineFromDemux(
  details: LevelDetails,
  frag: MediaFragment,
  media: Bufferable | null,
): void {
  const idx = frag.sn - details.startSN;
  const frags = details.fragments;
  if (idx < 0 || idx >= frags.length) {
    return;
  }
  const row = frags[idx];
  if (!isMediaFragment(row)) {
    return;
  }

  let dur = frag.duration;
  if (
    Number.isFinite(frag.startPTS) &&
    Number.isFinite(frag.endPTS) &&
    (frag.endPTS as number) > (frag.startPTS as number)
  ) {
    dur = (frag.endPTS as number) - (frag.startPTS as number);
  }
  row.duration = dur;
  frag.duration = dur;

  if (idx === 0) {
    const mse = mseRangeAtPlayhead(media, frag.start);
    row.start =
      mse?.mseStart ??
      (Number.isFinite(frag.startPTS) ? (frag.startPTS as number) : 0);
  } else {
    const prev = frags[idx - 1];
    row.start = prev.start + prev.duration;
  }
  frag.start = row.start;

  if (idx === frags.length - 1 || !details.live) {
    const flowEnd = row.start + row.duration;
    const vodCap = details.progressiveVodDuration;
    if (vodCap > 0) {
      details.totalduration = Math.min(vodCap, Math.max(flowEnd, row.start));
    } else {
      details.totalduration = Math.max(details.totalduration || 0, flowEnd);
    }
  }
}

export function shouldKeepFlowPrefetching(
  media: Bufferable | null,
  currentTime: number,
  _bufferLen: number,
  maxAheadSec: number,
): boolean {
  if (getPlayheadBufferedHole(media, currentTime)) {
    return false;
  }
  const ahead = progressiveBufferedAheadSec(media, currentTime);
  if (Number.isFinite(currentTime)) {
    return ahead < maxAheadSec - 0.25;
  }
  return _bufferLen < maxAheadSec;
}

/** True when playhead is at the end of a range and the next buffered range is already loaded. */
export function shouldJumpBufferedHole(
  bufferInfo: { len: number; nextStart?: number },
  currentTime: number,
  maxJumpSec: number,
): boolean {
  const nextStart = bufferInfo.nextStart;
  if (!nextStart || nextStart <= currentTime) {
    return false;
  }
  const gap = nextStart - currentTime;
  return gap > 0 && gap <= maxJumpSec && bufferInfo.len < 2;
}

/** Visible console diagnostics for progressive TS byte-range mode (`hlsDiag` / devtools). */
export function warnProgressiveTsDiag(
  config: Pick<HlsConfig, 'progressiveTsScheduler'> | undefined,
  message: string,
  ...detail: unknown[]
): void {
  if (!config?.progressiveTsScheduler) {
    return;
  }
  console.warn('[hls-player-patch]', message, ...detail);
}
