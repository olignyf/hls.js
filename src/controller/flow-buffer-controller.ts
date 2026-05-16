import BufferController from './buffer-controller';
import { createDoNothingErrorAction } from './error-controller';
import {
  computeFlowEvictRange,
  flowAllowsBufferFlush,
  flowShouldTrimFrontBuffer,
} from './flow-buffer-policy';
import { ErrorDetails } from '../errors';
import { Events } from '../events';
import type { FragmentTracker } from './fragment-tracker';
import type Hls from '../hls';
import type { SourceBufferName } from '../types/buffer';
import type { BufferFlushingData, ErrorData } from '../types/events';

/**
 * MSE buffer policy for progressive TS ("go with the flow"):
 * - VoD byte-range and live TS with discontinuities
 * - No full-buffer flush on quota; evict behind playhead / old ranges
 * - No front flush across timeline holes
 * - Timestamp offsets follow demuxed fragment starts on discontinuity
 */
export default class FlowBufferController extends BufferController {
  constructor(hls: Hls, fragmentTracker: FragmentTracker) {
    super(hls, fragmentTracker);
  }

  protected override useFlowBufferPolicy(): boolean {
    return true;
  }

  protected override shouldAllowBufferFlush(data: BufferFlushingData): boolean {
    return flowAllowsBufferFlush(data, this.getMediaElement());
  }

  protected override shouldTrimFrontBuffer(): boolean {
    return flowShouldTrimFrontBuffer(this.getMediaElement());
  }

  protected override shouldTrimBackBuffer(): boolean {
    const details = this.getLevelDetails();
    if (details?.live && details.type !== 'VOD') {
      return true;
    }
    const media = this.getMediaElement();
    if (!media?.buffered) {
      return false;
    }
    return media.buffered.length <= 1;
  }

  protected override handleFlowQuotaExceeded(
    event: ErrorData,
    type: SourceBufferName,
  ): boolean {
    const media = this.getMediaElement();
    if (!media) {
      return false;
    }
    const ct = media.currentTime;
    const hls = this.getHlsInstance();
    const keepBehind = Math.min(
      30,
      Math.max(8, hls.config.maxBufferLength * 0.4),
    );
    const range = computeFlowEvictRange(media, ct, keepBehind);
    if (range) {
      this.log(
        `flow buffer: quota — evict [${range.start.toFixed(3)}, ${range.end.toFixed(3)}] (playhead ${ct.toFixed(3)})`,
      );
      hls.trigger(Events.BUFFER_FLUSHING, {
        startOffset: range.start,
        endOffset: range.end,
        type,
      });
    } else {
      this.warn(
        `flow buffer: quota at ${ct.toFixed(3)} — no safe evict range; retry append`,
      );
    }
    event.details = ErrorDetails.BUFFER_APPEND_ERROR;
    event.fatal = false;
    event.errorAction = createDoNothingErrorAction(true);
    return true;
  }

  /** Let the remuxer stitch timestamps; do not reset offset on discontinuity (CC). */
  protected override resolveFlowTimestampOffset(
    fragStart: number,
    remuxOffset: number | undefined,
    _cc: number,
  ): number {
    return remuxOffset !== undefined && Number.isFinite(remuxOffset)
      ? remuxOffset
      : fragStart;
  }
}
