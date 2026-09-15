// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToBase64,
  RealtimeTalkInputGate,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmOutputQueue,
} from "./realtime-talk-audio.ts";

describe("RealtimeTalkInputGate", () => {
  const sampleRate = 1_000;
  const frame = (level: number, milliseconds = 100) => new Float32Array(milliseconds).fill(level);

  it("suppresses idle silence and restores pre-roll at speech onset", () => {
    const gate = new RealtimeTalkInputGate(300, 600);

    for (let index = 0; index < 20; index += 1) {
      expect(gate.push(frame(0), sampleRate).frames).toEqual([]);
    }
    const started = gate.push(frame(0.1), sampleRate);

    expect(started.frames).toHaveLength(4);
    expect(
      started.frames.slice(0, 3).every((samples) => samples.every((sample) => sample === 0)),
    ).toBe(true);
  });

  it("sends one trailing window, signals pause, then suppresses silence again", () => {
    const gate = new RealtimeTalkInputGate(200, 300);

    expect(gate.push(frame(0.1), sampleRate).frames).toHaveLength(1);
    expect(gate.push(frame(0), sampleRate).streamPaused).toBe(false);
    expect(gate.push(frame(0), sampleRate).streamPaused).toBe(false);
    expect(gate.push(frame(0), sampleRate).streamPaused).toBe(true);
    expect(gate.push(frame(0), sampleRate).frames).toEqual([]);
  });

  it("learns stable low background noise without opening the stream", () => {
    const gate = new RealtimeTalkInputGate();

    for (let index = 0; index < 100; index += 1) {
      expect(gate.push(frame(0.01), sampleRate).frames).toEqual([]);
    }
    expect(gate.push(frame(0.08), sampleRate).frames.length).toBeGreaterThan(0);
  });
});

class MockAudioBufferSource {
  buffer: unknown = null;
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();
  private ended: (() => void) | null = null;

  addEventListener(type: string, handler: () => void): void {
    if (type === "ended") {
      this.ended = handler;
    }
  }

  emitEnded(): void {
    this.ended?.();
  }
}

class MockOutputAudioContext {
  currentTime = 0;
  readonly destination = {};
  readonly sources: MockAudioBufferSource[] = [];

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const channel = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => channel,
    };
  }

  createBufferSource(): MockAudioBufferSource {
    const source = new MockAudioBufferSource();
    this.sources.push(source);
    return source;
  }
}

function silentPcmBase64(sampleCount: number): string {
  return bytesToBase64(new Uint8Array(sampleCount * 2));
}

describe("RealtimeTalkMediaStreamMeter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("samples a WebRTC input stream and resets its level when stopped", () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const disconnectSource = vi.fn();
    const disconnectAnalyser = vi.fn();
    const analyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      disconnect: disconnectAnalyser,
      getFloatTimeDomainData: vi
        .fn()
        .mockImplementationOnce((samples: Float32Array) => samples.fill(0.2))
        .mockImplementation((samples: Float32Array) => samples.fill(0)),
    };
    class MockAudioContext {
      readonly close = close;
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: disconnectSource };
      }
      createAnalyser() {
        return analyser;
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onLevel = vi.fn();
    const meter = new RealtimeTalkMediaStreamMeter(onLevel);

    meter.start({} as MediaStream);
    vi.advanceTimersByTime(3_000);

    expect(onLevel.mock.calls.some(([level]) => level > 0)).toBe(true);
    expect(onLevel).toHaveBeenLastCalledWith(0);
    meter.stop();

    expect(analyser.fftSize).toBe(512);
    expect(onLevel).toHaveBeenLastCalledWith(0);
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectAnalyser).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reclaims its interval when the initial level callback stops it", () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const disconnectSource = vi.fn();
    const disconnectAnalyser = vi.fn();
    class MockAudioContext {
      readonly close = close;
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: disconnectSource };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          disconnect: disconnectAnalyser,
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
        };
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onLevel = vi.fn((level: number) => {
      if (level > 0) {
        meter.stop();
      }
    });
    const meter = new RealtimeTalkMediaStreamMeter(onLevel);

    meter.start({} as MediaStream);
    meter.stop();
    meter.stop();
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectAnalyser).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes an owned AudioContext when analyser setup fails", () => {
    const close = vi.fn(async () => undefined);
    class MockAudioContext {
      readonly close = close;
      createMediaStreamSource() {
        throw new Error("source unavailable");
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onLevel = vi.fn();

    new RealtimeTalkMediaStreamMeter(onLevel).start({} as MediaStream);

    expect(close).toHaveBeenCalledOnce();
    expect(onLevel).toHaveBeenLastCalledWith(0);
  });
});

describe("RealtimeTalkPcmOutputQueue", () => {
  it("preserves ordered playback while the AudioContext advances normally", () => {
    const context = new MockOutputAudioContext();
    context.currentTime = 1;
    const queue = new RealtimeTalkPcmOutputQueue();

    expect(queue.play(silentPcmBase64(100), context as unknown as AudioContext, 100)).toBe(
      "queued",
    );
    context.currentTime = 1.5;
    expect(queue.play(silentPcmBase64(50), context as unknown as AudioContext, 100)).toBe("queued");

    expect(context.sources.map((source) => source.start.mock.calls[0]?.[0])).toEqual([1, 2]);
    expect(queue.queuedUntil).toBe(2.5);
    expect(queue.isPlaying).toBe(true);
  });

  it("bounds a frozen AudioContext by queued seconds before allocating another source", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();

    expect(queue.play(silentPcmBase64(600), context as unknown as AudioContext, 100)).toBe(
      "queued",
    );
    expect(queue.play(silentPcmBase64(500), context as unknown as AudioContext, 100)).toBe(
      "overflow",
    );

    expect(context.sources).toHaveLength(1);
    expect(queue.queuedUntil).toBe(6);
  });

  it("rejects an oversized frame before base64 decoding", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();

    expect(queue.play("!".repeat(3_000), context as unknown as AudioContext, 100)).toBe("overflow");
    expect(context.sources).toHaveLength(0);
  });

  it("ignores malformed base64 frames instead of throwing", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();

    // Short enough to pass the size gate, invalid enough to fail atob.
    expect(queue.play("!!!", context as unknown as AudioContext, 100)).toBe("ignored");
    expect(context.sources).toHaveLength(0);
  });

  it("hard-caps source ownership across ten thousand suspended-context chunks", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();
    let queued = 0;
    let overflowed = 0;

    for (let index = 0; index < 10_000; index += 1) {
      const result = queue.play(silentPcmBase64(1), context as unknown as AudioContext, 48_000);
      if (result === "queued") {
        queued += 1;
      } else if (result === "overflow") {
        overflowed += 1;
      }
    }

    expect(queued).toBe(320);
    expect(overflowed).toBe(9_680);
    expect(context.sources).toHaveLength(320);
  });

  it("releases source ownership on ended", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();
    const chunk = silentPcmBase64(1);

    for (let index = 0; index < 320; index += 1) {
      expect(queue.play(chunk, context as unknown as AudioContext, 48_000)).toBe("queued");
    }
    expect(queue.play(chunk, context as unknown as AudioContext, 48_000)).toBe("overflow");

    context.sources[0]?.emitEnded();

    expect(queue.play(chunk, context as unknown as AudioContext, 48_000)).toBe("queued");
    expect(context.sources).toHaveLength(321);
  });

  it("stops idempotently and isolates late ended events from replacement playback", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();
    const chunk = silentPcmBase64(100);

    expect(queue.play(chunk, context as unknown as AudioContext, 100)).toBe("queued");
    const oldSource = context.sources[0];
    context.currentTime = 0.25;
    queue.stop(context as unknown as AudioContext);
    queue.stop(context as unknown as AudioContext);

    expect(oldSource?.stop).toHaveBeenCalledOnce();
    expect(queue.isPlaying).toBe(false);
    expect(queue.queuedUntil).toBe(0.25);

    expect(queue.play(chunk, context as unknown as AudioContext, 100)).toBe("queued");
    const replacementSource = context.sources[1];
    oldSource?.emitEnded();

    expect(queue.isPlaying).toBe(true);
    expect(queue.queuedUntil).toBe(1.25);
    expect(replacementSource?.stop).not.toHaveBeenCalled();
  });
});
