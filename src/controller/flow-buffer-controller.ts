import BufferController from './buffer-controller';
import { createDoNothingErrorAction } from './error-controller';
import {
  computeFlowEvictRange,
  flowAllowsBufferFlush,
  flowShouldTrimFrontBuffer,
} from './flow-buffer-policy';
import {
  getProgressiveMaxAheadSec,
  getSerialMseAppendTail,
} from './progressive-ts-scheduler';
import { ErrorDetails, ErrorTypes } from '../errors';
import { Events } from '../events';
import { PlaylistLevelType } from '../types/loader';
import type { FragmentTracker } from './fragment-tracker';
import type Hls from '../hls';
import type { MediaFragment, Part } from '../loader/fragment';
import type { SourceBufferName } from '../types/buffer';
import type { BufferFlushingData, ErrorData } from '../types/events';
import type { ChunkMetadata } from '../types/transmuxer';

type QuotaRetryContext = {
  frag: MediaFragment;
  part: Part | null;
  chunkMeta: ChunkMetadata;
};

/**
 * MSE buffer policy for progressive TS ("go with the flow"):
 * - VoD byte-range and live TS with discontinuities
 * - No full-buffer flush on quota; evict behind/ahead of playhead
 * - Defer append retry until BUFFER_FLUSHED completes
 */
export default class FlowBufferController extends BufferController {
  private quotaRetry: QuotaRetryContext | null = null;
  private quotaFlushDoneTimer: number = -1;

  constructor(hls: Hls, fragmentTracker: FragmentTracker) {
    super(hls, fragmentTracker);
    hls.on(Events.BUFFER_FLUSHED, this.onFlowBufferFlushed, this);
  }

  public override destroy(): void {
    const hls = this.getHlsInstance();
    hls.off(Events.BUFFER_FLUSHED, this.onFlowBufferFlushed, this);
    self.clearTimeout(this.quotaFlushDoneTimer);
    this.quotaRetry = null;
    super.destroy();
  }

  private onFlowBufferFlushed = (): void => {
    if (!this.quotaRetry) {
      return;
    }
    self.clearTimeout(this.quotaFlushDoneTimer);
    this.quotaFlushDoneTimer = self.setTimeout(() => {
      const ctx = this.quotaRetry;
      this.quotaRetry = null;
      if (!ctx) {
        return;
      }
      this.log(
        `flow buffer: quota flush done — retry sn ${ctx.frag.sn} append`,
      );
      this.getHlsInstance().trigger(Events.ERROR, {
        type: ErrorTypes.MEDIA_ERROR,
        parent: PlaylistLevelType.MAIN,
        details: ErrorDetails.BUFFER_APPEND_ERROR,
        fatal: false,
        frag: ctx.frag,
        part: ctx.part,
        chunkMeta: ctx.chunkMeta,
        error: new Error('flow buffer quota retry'),
        errorAction: createDoNothingErrorAction(true),
      });
    }, 0);
  };

  protected override useFlowBufferPolicy(): boolean {
    return true;
  }

  protected override shouldEmitQuotaErrorImmediately(): boolean {
    return !this.quotaRetry;
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
    _type: SourceBufferName,
  ): boolean {
    const media = this.getMediaElement();
    if (!media || !event.frag || !event.chunkMeta) {
      return false;
    }
    const ct = media.currentTime;
    const hls = this.getHlsInstance();
    const maxAhead = getProgressiveMaxAheadSec(hls.config);
    const keepBehind = Math.min(12, Math.max(2, maxAhead * 0.25));
    const range = computeFlowEvictRange(media, ct, keepBehind, maxAhead);
    if (!range) {
      this.warn(
        `flow buffer: quota at ${ct.toFixed(3)} — could not compute evict range`,
      );
      return false;
    }

    this.log(
      `flow buffer: quota — evict [${range.start.toFixed(3)}, ${range.end.toFixed(3)}] (playhead ${ct.toFixed(3)})`,
    );
    this.quotaRetry = {
      frag: event.frag as MediaFragment,
      part: event.part ?? null,
      chunkMeta: event.chunkMeta,
    };
    hls.trigger(Events.BUFFER_FLUSHING, {
      startOffset: range.start,
      endOffset: range.end,
      type: null,
    });
    event.details = ErrorDetails.BUFFER_APPEND_ERROR;
    event.fatal = false;
    event.errorAction = createDoNothingErrorAction(true);
    return true;
  }

  /** Serial progressive: stitch at MSE tail, not playlist frag.start on init-only appends. */
  protected override resolveFlowTimestampOffset(
    fragStart: number,
    remuxOffset: number | undefined,
    _cc: number,
  ): number {
    if (remuxOffset !== undefined && Number.isFinite(remuxOffset)) {
      return remuxOffset;
    }
    const tail = getSerialMseAppendTail(this.getMediaElement());
    if (tail !== null) {
      return tail;
    }
    return fragStart;
  }
}
