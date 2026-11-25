/**
 * Session recording v1 unit tests — pure logic only, no browser.
 * Covers: the one-time grant gate (canRecord), the recording state
 * machine, track picking, mime-type selection, chunk assembly,
 * duration/size formatting, file naming, and the 1-hour auto-stop
 * cap.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_RECORDING_DURATION_MS,
  RECORDING_CHUNK_TIMESLICE_MS,
  assembleRecordingBlob,
  canRecord,
  formatRecordingDuration,
  formatRecordingSize,
  hasRecordableTrack,
  pickRecordingMimeType,
  pickRecordingTracks,
  recordingFileName,
  shouldAutoStopRecording,
  transitionRecordingState,
  type RecordingState,
} from "../recording";
import type { PermissionScope } from "../permissions";

const live = { readyState: "live" };
const ended = { readyState: "ended" };

describe("recording grant gate — the one-time pairing grant covers it", () => {
  it("the device owner may always record", () => {
    expect(canRecord([], true)).toBe(true);
    expect(canRecord(["file_transfer"], true)).toBe(true);
  });

  it("a participant with any live media grant may record", () => {
    expect(canRecord(["screen"], false)).toBe(true);
    expect(canRecord(["camera"], false)).toBe(true);
    expect(canRecord(["microphone"], false)).toBe(true);
    expect(canRecord(["screen", "file_transfer", "location"], false)).toBe(true);
  });

  it("a participant with only non-media grants may not record", () => {
    expect(canRecord([], false)).toBe(false);
    expect(canRecord(["file_transfer"], false)).toBe(false);
    expect(canRecord(["location"], false)).toBe(false);
    expect(canRecord(["speaker"], false)).toBe(false);
    expect(canRecord(["notifications"], false)).toBe(false);
    expect(canRecord(["remote_interaction"], false)).toBe(false);
    expect(
      canRecord(
        ["file_transfer", "location", "speaker", "notifications", "remote_interaction"] as PermissionScope[],
        false,
      ),
    ).toBe(false);
  });
});

describe("recording state machine", () => {
  it("idle -> recording on start, recording -> stopped on stop, stopped -> idle on reset", () => {
    let state: RecordingState = "idle";
    state = transitionRecordingState(state, "start");
    expect(state).toBe("recording");
    state = transitionRecordingState(state, "stop");
    expect(state).toBe("stopped");
    state = transitionRecordingState(state, "reset");
    expect(state).toBe("idle");
  });

  it("ignores events that do not belong to the current state", () => {
    expect(transitionRecordingState("idle", "stop")).toBe("idle");
    expect(transitionRecordingState("idle", "reset")).toBe("idle");
    expect(transitionRecordingState("recording", "start")).toBe("recording");
    expect(transitionRecordingState("recording", "reset")).toBe("recording");
    expect(transitionRecordingState("stopped", "start")).toBe("stopped");
    expect(transitionRecordingState("stopped", "stop")).toBe("stopped");
  });
});

describe("track picking", () => {
  it("prefers the live screen over the live camera, and takes audio", () => {
    const pick = pickRecordingTracks({ screen: live, camera: live, audio: live });
    expect(pick.video).toBe(live);
    expect(pick.audio).toBe(live);
    expect(hasRecordableTrack(pick)).toBe(true);
  });

  it("falls back to the camera when the screen is not live", () => {
    const pick = pickRecordingTracks({ screen: ended, camera: live, audio: null });
    expect(pick.video).toBe(live);
    expect(pick.audio).toBeNull();
  });

  it("records audio alone when no video is live", () => {
    const pick = pickRecordingTracks({ screen: null, camera: null, audio: live });
    expect(pick.video).toBeNull();
    expect(pick.audio).toBe(live);
    expect(hasRecordableTrack(pick)).toBe(true);
  });

  it("returns nothing when no track is live", () => {
    const pick = pickRecordingTracks({ screen: ended, camera: null, audio: ended });
    expect(pick).toEqual({ video: null, audio: null });
    expect(hasRecordableTrack(pick)).toBe(false);
  });
});

describe("mime-type selection", () => {
  it("takes the first supported candidate, best first", () => {
    expect(pickRecordingMimeType((m) => m === "video/webm;codecs=vp8,opus")).toBe(
      "video/webm;codecs=vp8,opus",
    );
    expect(pickRecordingMimeType(() => true)).toBe("video/webm;codecs=vp9,opus");
  });

  it("falls back to the browser default when nothing matches", () => {
    expect(pickRecordingMimeType(() => false)).toBe("");
    expect(
      pickRecordingMimeType(() => {
        throw new Error("unsupported");
      }),
    ).toBe("");
  });
});

describe("chunk assembly and formatting", () => {
  it("assembles chunks into one blob of the given type", () => {
    const blob = assembleRecordingBlob(
      [new Blob(["ab"]), new Blob(["c"])],
      "video/webm;codecs=vp8,opus",
    );
    expect(blob.size).toBe(3);
    expect(blob.type).toBe("video/webm;codecs=vp8,opus");
  });

  it("defaults to video/webm when no mime type is given", () => {
    expect(assembleRecordingBlob([new Blob(["x"])], "").type).toBe("video/webm");
  });

  it("formats durations as mm:ss, and h:mm:ss past an hour", () => {
    expect(formatRecordingDuration(0)).toBe("00:00");
    expect(formatRecordingDuration(65_000)).toBe("01:05");
    expect(formatRecordingDuration(59_000)).toBe("00:59");
    expect(formatRecordingDuration(3_661_000)).toBe("1:01:01");
  });

  it("formats sizes in binary units with one decimal", () => {
    expect(formatRecordingSize(500)).toBe("500 B");
    expect(formatRecordingSize(2048)).toBe("2.0 KB");
    expect(formatRecordingSize(13_000_000)).toBe("12.4 MB");
  });

  it("builds a safe file name from the device name and start time", () => {
    const name = recordingFileName("Muse Test Laptop", Date.UTC(2026, 10, 25, 17, 30));
    expect(name).toMatch(/^nexvora-recording-muse-test-laptop-\d{4}-\d{2}-\d{2}-\d{4}\.webm$/);
    expect(recordingFileName("../../etc/passwd", 0)).not.toContain("..");
    expect(recordingFileName("", 0)).toContain("device");
  });

  it("caps a recording at one hour with 1-second chunks", () => {
    expect(MAX_RECORDING_DURATION_MS).toBe(3_600_000);
    expect(RECORDING_CHUNK_TIMESLICE_MS).toBe(1000);
    expect(shouldAutoStopRecording(3_599_999)).toBe(false);
    expect(shouldAutoStopRecording(3_600_000)).toBe(true);
    expect(shouldAutoStopRecording(7_200_000)).toBe(true);
  });
});
