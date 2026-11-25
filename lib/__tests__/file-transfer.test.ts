/**
 * File-transfer unit tests (Milestone 4) — pure logic only, no browser.
 * Covers: channel name + limits, file-name/size validation, chunking
 * and progress math, binary chunk framing, the transfer state machine
 * (transitions + who may perform them), and API body validation.
 */
import { describe, it, expect } from "vitest";
import {
  FILE_BUFFERED_AMOUNT_HIGH_WATERMARK,
  FILE_BUFFERED_AMOUNT_LOW_WATERMARK,
  FILE_CHANNEL_NAME,
  FILE_CHUNK_HEADER_BYTES,
  FILE_CHUNK_SIZE_BYTES,
  FILE_TRANSFER_STATUSES,
  MAX_FILE_SIZE_BYTES,
  canActorTransitionTransferStatus,
  canTransitionTransferStatus,
  chunkCountFor,
  chunkRangeFor,
  decodeFileChunk,
  encodeFileChunk,
  transferProgressPercent,
  validateFileName,
  validateFileSize,
  validateFileTransferCreateBody,
  validateFileTransferStatusBody,
} from "../file-transfer";

describe("channel + limits", () => {
  it("uses a dedicated binary channel named nexvora-file", () => {
    expect(FILE_CHANNEL_NAME).toBe("nexvora-file");
  });

  it("caps files at 50 MB in 16 KiB chunks", () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
    expect(FILE_CHUNK_SIZE_BYTES).toBe(16 * 1024);
    expect(FILE_CHUNK_HEADER_BYTES).toBe(4);
  });

  it("has a high watermark above the low watermark (backpressure works)", () => {
    expect(FILE_BUFFERED_AMOUNT_HIGH_WATERMARK).toBeGreaterThan(
      FILE_BUFFERED_AMOUNT_LOW_WATERMARK,
    );
  });
});

describe("file-name validation — never trust a client-supplied path", () => {
  it("accepts bare names", () => {
    expect(validateFileName("report.pdf")).toEqual({ ok: true, name: "report.pdf" });
    expect(validateFileName("  photo 1.png  ")).toEqual({ ok: true, name: "photo 1.png" });
  });

  it("rejects paths, dot names, empty names and control characters", () => {
    expect(validateFileName("../../etc/passwd").ok).toBe(false);
    expect(validateFileName("folder/file.txt").ok).toBe(false);
    expect(validateFileName("folder\\file.txt").ok).toBe(false);
    expect(validateFileName("..").ok).toBe(false);
    expect(validateFileName(".").ok).toBe(false);
    expect(validateFileName("").ok).toBe(false);
    expect(validateFileName("   ").ok).toBe(false);
    expect(validateFileName("a\u0000b").ok).toBe(false);
    expect(validateFileName(42).ok).toBe(false);
    expect(validateFileName(null).ok).toBe(false);
  });

  it("rejects names over 255 characters", () => {
    expect(validateFileName("a".repeat(256)).ok).toBe(false);
    expect(validateFileName("a".repeat(255)).ok).toBe(true);
  });
});

describe("file-size validation — 50 MB enforced on both sides", () => {
  it("accepts sizes from 1 byte to exactly 50 MB", () => {
    expect(validateFileSize(1)).toEqual({ ok: true, size: 1 });
    expect(validateFileSize(MAX_FILE_SIZE_BYTES)).toEqual({
      ok: true,
      size: MAX_FILE_SIZE_BYTES,
    });
  });

  it("rejects zero, negative, fractional, non-numeric and oversize values", () => {
    expect(validateFileSize(0).ok).toBe(false);
    expect(validateFileSize(-5).ok).toBe(false);
    expect(validateFileSize(1.5).ok).toBe(false);
    expect(validateFileSize("100").ok).toBe(false);
    expect(validateFileSize(MAX_FILE_SIZE_BYTES + 1).ok).toBe(false);
    expect(validateFileSize(Number.NaN).ok).toBe(false);
  });
});

describe("chunking + progress math", () => {
  it("counts chunks (16 KiB each, last one partial)", () => {
    expect(chunkCountFor(0)).toBe(0);
    expect(chunkCountFor(1)).toBe(1);
    expect(chunkCountFor(16 * 1024)).toBe(1);
    expect(chunkCountFor(16 * 1024 + 1)).toBe(2);
    expect(chunkCountFor(50 * 1024 * 1024)).toBe(3200);
  });

  it("computes byte ranges per chunk", () => {
    expect(chunkRangeFor(0, 40_000)).toEqual({ start: 0, end: 16_384 });
    expect(chunkRangeFor(2, 40_000)).toEqual({ start: 32_768, end: 40_000 });
    expect(chunkRangeFor(0, 16_384)).toEqual({ start: 0, end: 16_384 });
  });

  it("reports whole-number progress, clamped to 0–100", () => {
    expect(transferProgressPercent(0, 1000)).toBe(0);
    expect(transferProgressPercent(500, 1000)).toBe(50);
    expect(transferProgressPercent(999, 1000)).toBe(99);
    expect(transferProgressPercent(1000, 1000)).toBe(100);
    expect(transferProgressPercent(1500, 1000)).toBe(100);
    expect(transferProgressPercent(0, 0)).toBe(0);
  });
});

describe("binary chunk framing", () => {
  it("round-trips index + payload through the 4-byte header", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = encodeFileChunk(7, payload);
    expect(encoded.length).toBe(4 + 5);
    const decoded = decodeFileChunk(encoded.buffer as ArrayBuffer);
    expect(decoded?.index).toBe(7);
    expect(decoded?.data).toEqual(payload);
  });

  it("handles index 0 and an empty payload", () => {
    const decoded = decodeFileChunk(
      encodeFileChunk(0, new Uint8Array([])).buffer as ArrayBuffer,
    );
    expect(decoded?.index).toBe(0);
    expect(decoded?.data.length).toBe(0);
  });

  it("rejects buffers too short to hold a header", () => {
    expect(decodeFileChunk(new ArrayBuffer(0))).toBeNull();
    expect(decodeFileChunk(new ArrayBuffer(3))).toBeNull();
  });
});

describe("transfer state machine", () => {
  it("allows the happy path pending -> approved -> in_progress -> completed", () => {
    expect(canTransitionTransferStatus("pending", "approved")).toBe(true);
    expect(canTransitionTransferStatus("approved", "in_progress")).toBe(true);
    expect(canTransitionTransferStatus("in_progress", "completed")).toBe(true);
  });

  it("allows rejection from pending and failure from any live state", () => {
    expect(canTransitionTransferStatus("pending", "rejected")).toBe(true);
    expect(canTransitionTransferStatus("pending", "failed")).toBe(true);
    expect(canTransitionTransferStatus("approved", "failed")).toBe(true);
    expect(canTransitionTransferStatus("in_progress", "failed")).toBe(true);
  });

  it("terminal states never move, and skipping is impossible", () => {
    for (const from of ["completed", "rejected", "failed"] as const) {
      for (const to of FILE_TRANSFER_STATUSES) {
        expect(canTransitionTransferStatus(from, to)).toBe(false);
      }
    }
    expect(canTransitionTransferStatus("pending", "completed")).toBe(false);
    expect(canTransitionTransferStatus("pending", "in_progress")).toBe(false);
    expect(canTransitionTransferStatus("approved", "completed")).toBe(false);
    expect(canTransitionTransferStatus("approved", "rejected")).toBe(false);
  });

  it("only the receiver approves/rejects; only the sender starts/completes", () => {
    expect(canActorTransitionTransferStatus("receiver", "pending", "approved")).toBe(true);
    expect(canActorTransitionTransferStatus("sender", "pending", "approved")).toBe(false);
    expect(canActorTransitionTransferStatus("receiver", "pending", "rejected")).toBe(true);
    expect(canActorTransitionTransferStatus("sender", "pending", "rejected")).toBe(false);
    expect(canActorTransitionTransferStatus("sender", "approved", "in_progress")).toBe(true);
    expect(canActorTransitionTransferStatus("receiver", "approved", "in_progress")).toBe(false);
    expect(canActorTransitionTransferStatus("sender", "in_progress", "completed")).toBe(true);
    expect(canActorTransitionTransferStatus("receiver", "in_progress", "completed")).toBe(false);
    // Either side may fail a live transfer (error or cancel).
    expect(canActorTransitionTransferStatus("sender", "pending", "failed")).toBe(true);
    expect(canActorTransitionTransferStatus("receiver", "in_progress", "failed")).toBe(true);
  });
});

describe("API body validation", () => {
  it("accepts a valid create body", () => {
    expect(
      validateFileTransferCreateBody({ fileName: "a.txt", fileSizeBytes: 123 }),
    ).toEqual({ ok: true, fileName: "a.txt", fileSizeBytes: 123 });
  });

  it("rejects bad names and sizes in the create body (413 for oversize)", () => {
    expect(validateFileTransferCreateBody({ fileName: "../x", fileSizeBytes: 1 })).toEqual({
      ok: false,
      error: expect.any(String),
      status: 400,
    });
    expect(
      validateFileTransferCreateBody({ fileName: "a.txt", fileSizeBytes: MAX_FILE_SIZE_BYTES + 1 }),
    ).toEqual({ ok: false, error: expect.any(String), status: 413 });
    expect(validateFileTransferCreateBody({ fileName: "a.txt" })).toEqual({
      ok: false,
      error: expect.any(String),
      status: 400,
    });
    expect(validateFileTransferCreateBody(null)).toEqual({
      ok: false,
      error: expect.any(String),
      status: 400,
    });
  });

  it("accepts valid statuses and rejects unknown ones", () => {
    expect(validateFileTransferStatusBody({ status: "completed" })).toEqual({
      ok: true,
      status: "completed",
    });
    expect(validateFileTransferStatusBody({ status: "cancelled" }).ok).toBe(false);
    expect(validateFileTransferStatusBody({ status: "pending" })).toEqual({
      ok: true,
      status: "pending",
    });
    expect(validateFileTransferStatusBody({})).toEqual({
      ok: false,
      error: expect.any(String),
      status: 400,
    });
  });
});
