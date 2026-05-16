import { FragmentState } from './fragment-tracker';
import {
  type Fragment,
  isMediaFragment,
  type MediaFragment,
} from '../loader/fragment';
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

export type PickNextProgressiveOpts = {
  /** Live TS: load next SN only; no byte-ratio seek. */
  liveSequential: boolean;
  /** User/media seek target (seconds). Used only when `knownFileBytes` is set. */
  seekMediaTime?: number;
  knownFileBytes?: number | null;
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

  if (
    opts.liveSequential ||
    opts.seekMediaTime === undefined ||
    !opts.knownFileBytes ||
    !details.totalduration
  ) {
    if (fragPrevious) {
      startIdx = fragPrevious.sn - details.startSN + 1;
    }
  } else {
    const ratio = Math.max(
      0,
      Math.min(1, opts.seekMediaTime / details.totalduration),
    );
    const bytePos = Math.floor(ratio * opts.knownFileBytes);
    startIdx = findFragmentIndexByByte(frags, bytePos);
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
