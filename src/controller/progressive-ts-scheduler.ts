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
import type { LevelDetails } from '../loader/level-details';

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
  /** Playlist-time seek / scrub position (seconds). */
  seekMediaTime?: number;
  knownFileBytes?: number | null;
  /** When true, pick by byte ratio from `seekMediaTime` instead of sn+1. */
  forceByteSeek?: boolean;
};

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
  } else if (opts.liveSequential || !fragPrevious) {
    startIdx = 0;
  } else {
    startIdx = fragPrevious.sn - details.startSN + 1;
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
