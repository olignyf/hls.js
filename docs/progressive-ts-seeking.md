# Progressive TS seeking (byte-range VoD)

This fork supports **HTTP byte-range MPEG-TS** as a virtual HLS playlist: many `EXT-X-BYTERANGE` fragments over one `.ts` file, with `progressiveTsScheduler: true`. Normal playback loads **serially by SN** with a small prefetch window (`progressiveTsMaxAheadSec`, typically ~6s). **Seeking** is a separate path: wipe stale MSE, jump to the right file bytes, optionally **walk backward** until demux finds a keyframe, then load **forward** until the playhead is buffered.

Enable in config:

```js
progressiveTsScheduler: true,
progressiveTsMaxAheadSec: 6,
```

Diagnostics: console warnings tagged `[hls-player-patch][seek]` when hls.js debug logging is on.

E2E (repo root, HTTPS server on :8444):

- `npm run test:hls:seek` — ~36% / 915s
- `npm run test:hls:seek:75` — 75% of duration (~1926s on the test asset)

---

## Why seeking is hard here

1. **One TS timeline, huge container delay** — PCR/PTS use a large offset (`initPTS` ~92220s). MSE append uses `timestampOffset ≈ -initPTS` so playlist time 0 maps near MSE 0.
2. **Arbitrary byte splits** — Virtual playlist chunks (~4 MiB) are not GOP-aligned. A chunk may contain **no IDR**; the remuxer then reports _“No keyframe found”_ and refuses to append video.
3. **Flow buffer policy** — Default flow mode blocks full-buffer flushes. Scrub must use an explicit **scrub flush** flag or old media (e.g. 0–28s) stays in MSE while the loader targets ~915s.
4. **Playlist time ≠ file bytes until demux** — `frag.start` / `EXTINF` are estimates from `duration × (byte offset / file size)` until golden timeline sync; byte pick falls back to timeline when `EXT-X-BYTERANGE` offsets are missing or invalid.

---

## End-to-end seek flow

```
User seeks (outside buffered range)
        │
        ▼
[1] prepareProgressiveScrubSeek()     capture-phase 'seeking' (before base handler)
        │   set progressiveSeekMediaTime, abort load, clear tracker, flush MSE
        ▼
[2] flushMainBufferForProgressiveSeek progressiveScrubFlush → flow policy allows wipe
        │   wait BUFFER_FLUSHED (or 8s timeout) → tickImmediate
        ▼
[3] pickNextProgressiveFragment       seekBootstrap: first chunk at/ before target
        │   load sn N (HTTP Range for that BYTERANGE)
        ▼
[4] transmux (progressiveSeekJump / progressiveSeekGather)
        │   append with -initPTS, contiguous: false at frag.start
        ▼
[5] No keyframe?  seek-gather-bytes-prev → load sn N-1, N-2, …
        │   until keyframe or sn == startSN
        ▼
[6] Keyframe appended → fragPrevious set, seekBootstrap false
        │   chain sn+1, sn+2, … while progressiveSeekMediaTime unbuffered
        ▼
[7] BufferHelper.isBuffered(media, seekT) → clear progressiveSeekMediaTime
```

---

## Code map (main files)

| Concern                         | File                                         | Symbol / area                                                                                                            |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Scrub entry, flush, state       | `src/controller/stream-controller.ts`        | `prepareProgressiveScrubSeek`, `flushMainBufferForProgressiveSeek`, `progressiveSeekMediaTime`, `progressiveSeekForceSn` |
| Which fragment to load          | `src/controller/progressive-ts-scheduler.ts` | `pickNextProgressiveFragment`, `findFragmentIndexByByte`, `findFragmentIndexByTimeline`, `mediaFragmentsHaveByteMap`     |
| Allow MSE wipe on scrub         | `src/controller/flow-buffer-policy.ts`       | `progressiveScrubFlush` on `BufferFlushingData`                                                                          |
| Remux session on jump / gather  | `src/demux/transmuxer-interface.ts`          | `progressiveSeekJump`, `progressiveSeekGather`                                                                           |
| No keyframe → walk back         | `src/controller/stream-controller.ts`        | `_handleTransmuxComplete` branch `seek-gather-bytes-prev`                                                                |
| Gather flag for transmuxer      | `src/hls.ts`                                 | `progressiveSeekGatheringBack` getter                                                                                    |
| Idle scheduling / prefetch gate | `src/controller/stream-controller.ts`        | `doTickIdle` progressive branch                                                                                          |
| Forward chain after buffer      | `src/controller/stream-controller.ts`        | `onFragBuffered` + `progressiveShouldLoadNextFragment(..., pendingSeek)`                                                 |

---

## 1. Scrub preparation (before base `onMediaSeeking`)

**Where:** `stream-controller.ts` — `onProgressiveScrubSeekingCapture` (capture `true`) → `prepareProgressiveScrubSeek()`.

Base `BaseStreamController.onMediaSeeking` is a **class field**; it cannot be wrapped with `super`. The capture listener runs first so base does not `tickImmediate()` and load the wrong SN.

On **outside-buffer** seek:

- `progressiveSeekMediaTime = currentTime` (kept until playhead is buffered)
- `fragPrevious = null`, `progressiveSeekForceSn = null`
- `resetTransmuxer()`, `fragmentTracker.removeAllFragments()`
- Abort in-flight fragment, `flushMainBufferForProgressiveSeek()` then `tickImmediate` in the flush callback
- `doTickIdle` returns early while `progressiveSeekFlushPending` is set

**Inside-buffer** seek: log `seeking-inside-buffer` and return (normal playback / prefetch rules).

---

## 2. Picking the first byte-range chunk (`seekBootstrap`)

**Where:** `stream-controller.ts` `doTickIdle` → `pickNextProgressiveFragment()` in `progressive-ts-scheduler.ts`.

While `progressiveSeekMediaTime !== null`:

- `forceByteSeek = true`, `seekMediaTime` = scrub target
- **`seekBootstrap`** is true only until the last loaded fragment **covers** the playhead in MSE (`progressiveSerialMseCoversFrag`). Then picking uses **`fragPrevious` and sn+1** (forward chain), not byte ratio again.

Bootstrap pick (`pickProgressiveSeekBootstrapFragment`):

- **Primary:** `findFragmentIndexByTimeline(seekTime)` → load **previous** SN (keyframe headroom). Virtual `EXTINF` is proportional to bytes, so playlist time is the reliable index.
- **Byte map (optional):** used only when every fragment has **monotonic** `byteRangeStartOffset` and byte index agrees with timeline (within ±2 SN). Avoids picking sn 82 for a 75% scrub when offsets are incomplete.
- **`progressiveSeekBootstrapSn`:** locked on scrub so parse errors do not re-bootstrap to the end of the file.

**Forced SN (backward walk):** if `progressiveSeekForceSn` is set, `pickNextProgressiveFragment` returns that fragment immediately (`forceLoadSn`); cleared right after pick in `doTickIdle`.

---

## 3. Walking backward when there is no keyframe

**Where:** `stream-controller.ts` — after transmux, in the video path when `remuxResult.independent === false` and `progressiveSeekMediaTime !== null`.

The remuxer (`mp4-remuxer.ts`) sets `independent = false` when `forceKeyFrameOnDiscontinuity` is on and **no IDR** exists in the chunk (`No keyframe found out of N video samples`).

**Gather logic:**

```text
prevSn = frag.sn - 1
if prevSn < startSN → give up
else:
  removeFragment(current)
  progressiveSeekForceSn = prevSn
  resetTransmuxer()
  resetLoadingState()
  tickImmediate()   // loads sn prevSn via forceLoadSn
```

Console: `[hls-player-patch][seek] seek-gather-bytes-prev { sn, prevSn, seekT }`.

Each step loads **more file bytes earlier in the file** until a chunk contains a keyframe or you reach the first segment. This is not a single wider Range request; it is **discrete previous SN loads**, which matches the virtual playlist’s per-chunk URLs/ranges.

---

## 4. Transmux on seek jump and on gather

**Where:** `transmuxer-interface.ts` — `push()`.

| Mode        | When                                                     | discontinuity | contiguous | timeOffset      |
| ----------- | -------------------------------------------------------- | ------------- | ---------- | --------------- | --------- | ------------ |
| Serial play | `snDiff === 1`                                           | false         | true       | MSE serial tail |
| Scrub jump  | `progressiveSeekJump` (                                  | snDiff        | ≠ 0,1)     | false           | **false** | `frag.start` |
| Gather back | `progressiveSeekGather` + `progressiveSeekGatheringBack` | false         | **false**  | `frag.start`    |

`contiguous: false` on scrub is required so the remuxer does **not** hole-fill from the old MSE tail (~28s) to the new PTS (~915s). `discontinuity: false` avoids resetting `initPTS` per virtual `EXT-X-DISCONTINUITY` (byte splits are not real timeline breaks).

`gatheringBack` also prevents treating “no lastFrag” as `snDiff = 1` (serial) when starting a backward gather load after `resetTransmuxer()`.

---

## 5. Forward chain and completion

After a chunk with a keyframe is **buffered**:

- `onFragBuffered` sets `fragPrevious`, and if `BufferHelper.isBuffered(media, progressiveSeekMediaTime)` clears `progressiveSeekMediaTime` (`seek-playhead-in-buffer`).
- While seek is still active, `progressiveShouldLoadNextFragment` returns true even if the 6s prefetch gate would block normal play.
- `doTickIdle` loads `fragPrevious.sn + 1`, etc., until the scrub target has enough forward buffer.

---

## 6. Flow buffer and flush

**Where:** `flow-buffer-policy.ts`, `types/events.ts` (`progressiveScrubFlush`).

Normal flow mode rejects `flush [0, Infinity]`. Scrub sets `progressiveScrubFlush: true` on `BUFFER_FLUSHING` so `FlowBufferController` allows the wipe.

`flushMainBufferForProgressiveSeek` waits for one `BUFFER_FLUSHED` or **8s timeout**, then runs the pending `tickImmediate`.

---

## Mental model

- **Play:** one forward timeline in MSE, `-initPTS`, prefetch ~6s ahead.
- **Seek:** delete MSE → jump to estimated byte chunk(s) → **if no IDR, step backward SN by SN** → append at playlist time → **crawl forward by SN** until `currentTime` is inside the buffer.

The “clever” backward step is small but essential: arbitrary Range boundaries are not sync points; only an earlier byte range is guaranteed to eventually include a keyframe that anchors decode at the target time.
