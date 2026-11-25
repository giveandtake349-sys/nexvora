/**
 * Milestone 4 live-feature unit tests — pure logic only, no browser.
 * Covers: location validation + throttling + map link, notification
 * validation + feed capping, remote-interaction validation, and the
 * audit-events route body validation.
 */
import { describe, it, expect } from "vitest";
import {
  LOCATION_UPDATE_MIN_INTERVAL_MS,
  MAX_NOTIFICATION_FEED_ENTRIES,
  appendNotificationFeed,
  formatCoordinates,
  isLiveSessionAuditAction,
  openStreetMapLink,
  shouldSendLocationUpdate,
  validateDeviceNotification,
  validateLocationFix,
  validateRemoteKeyEvent,
  validateRemotePointerEvent,
  validateSessionEventBody,
} from "../live-features";

describe("location validation", () => {
  it("accepts a valid fix, with or without accuracy", () => {
    expect(
      validateLocationFix({ latitude: 24.7136, longitude: 46.6753, accuracy: 12, timestamp: 1700000000000 }),
    ).toEqual({ latitude: 24.7136, longitude: 46.6753, accuracy: 12, timestamp: 1700000000000 });
    expect(
      validateLocationFix({ latitude: -33.86, longitude: 151.2, accuracy: null, timestamp: 1 }),
    ).toEqual({ latitude: -33.86, longitude: 151.2, accuracy: null, timestamp: 1 });
  });

  it("rejects impossible coordinates, bad accuracy and bad timestamps", () => {
    expect(validateLocationFix({ latitude: 91, longitude: 0, timestamp: 1 })).toBeNull();
    expect(validateLocationFix({ latitude: -91, longitude: 0, timestamp: 1 })).toBeNull();
    expect(validateLocationFix({ latitude: 0, longitude: 181, timestamp: 1 })).toBeNull();
    expect(validateLocationFix({ latitude: 0, longitude: -181, timestamp: 1 })).toBeNull();
    expect(validateLocationFix({ latitude: "24", longitude: 0, timestamp: 1 })).toBeNull();
    expect(validateLocationFix({ latitude: 0, longitude: 0, accuracy: -1, timestamp: 1 })).toBeNull();
    expect(validateLocationFix({ latitude: 0, longitude: 0, accuracy: 1e9, timestamp: 1 })).toBeNull();
    expect(validateLocationFix({ latitude: 0, longitude: 0, timestamp: 0 })).toBeNull();
    expect(validateLocationFix({ latitude: 0, longitude: 0 })).toBeNull();
    expect(validateLocationFix(null)).toBeNull();
  });

  it("throttles updates to one per 5 seconds", () => {
    expect(LOCATION_UPDATE_MIN_INTERVAL_MS).toBe(5000);
    expect(shouldSendLocationUpdate(10_000, null)).toBe(true);
    expect(shouldSendLocationUpdate(10_000, 10_000)).toBe(false);
    expect(shouldSendLocationUpdate(14_999, 10_000)).toBe(false);
    expect(shouldSendLocationUpdate(15_000, 10_000)).toBe(true);
  });

  it("builds an OpenStreetMap link with no API key", () => {
    const link = openStreetMapLink(24.7136, 46.6753);
    expect(link).toBe("https://www.openstreetmap.org/?mlat=24.7136&mlon=46.6753#map=16/24.7136/46.6753");
    expect(link).not.toContain("key=");
  });

  it("formats coordinates to 5 decimal places", () => {
    expect(formatCoordinates(24.71361, 46.67529)).toBe("24.71361, 46.67529");
  });
});

describe("notification validation — nothing is faked, malformed is dropped", () => {
  const valid = {
    app: "Messenger",
    title: "Ayesha",
    body: "Hey, are you coming?",
    receivedAt: 1700000000000,
  };

  it("accepts a well-formed notification", () => {
    expect(validateDeviceNotification(valid)).toEqual(valid);
  });

  it("accepts an empty body (title-only notifications exist)", () => {
    expect(validateDeviceNotification({ ...valid, body: "" })).toEqual({ ...valid, body: "" });
  });

  it("rejects missing/empty app or title, oversize fields, bad timestamps", () => {
    expect(validateDeviceNotification({ ...valid, app: "" })).toBeNull();
    expect(validateDeviceNotification({ ...valid, app: "x".repeat(101) })).toBeNull();
    expect(validateDeviceNotification({ ...valid, title: "   " })).toBeNull();
    expect(validateDeviceNotification({ ...valid, title: "x".repeat(201) })).toBeNull();
    expect(validateDeviceNotification({ ...valid, body: "x".repeat(1001) })).toBeNull();
    expect(validateDeviceNotification({ ...valid, receivedAt: 0 })).toBeNull();
    expect(validateDeviceNotification({ ...valid, receivedAt: "now" })).toBeNull();
    expect(validateDeviceNotification({ app: "A", title: "T" })).toBeNull();
    expect(validateDeviceNotification(null)).toBeNull();
  });

  it("caps the feed at 50 entries, newest first", () => {
    expect(MAX_NOTIFICATION_FEED_ENTRIES).toBe(50);
    let typed: { app: string; title: string; body: string; receivedAt: number }[] = [];
    for (let i = 0; i < 50; i++) {
      typed = appendNotificationFeed(typed, { ...valid, title: `n${i}`, receivedAt: i + 1 });
    }
    expect(typed.length).toBe(50);
    expect(typed[0].title).toBe("n49");
    typed = appendNotificationFeed(typed, { ...valid, title: "n50", receivedAt: 51 });
    expect(typed.length).toBe(50);
    expect(typed[0].title).toBe("n50");
    expect(typed[49].title).toBe("n1");
  });
});

describe("remote-interaction validation — in-page only", () => {
  it("accepts normalised pointer positions in [0, 1]", () => {
    expect(validateRemotePointerEvent({ kind: "move", x: 0, y: 1 })).toEqual({
      kind: "move",
      x: 0,
      y: 1,
    });
    expect(validateRemotePointerEvent({ kind: "click", x: 0.5, y: 0.25 })).toEqual({
      kind: "click",
      x: 0.5,
      y: 0.25,
    });
  });

  it("rejects out-of-range coordinates and unknown kinds", () => {
    expect(validateRemotePointerEvent({ kind: "move", x: -0.01, y: 0.5 })).toBeNull();
    expect(validateRemotePointerEvent({ kind: "move", x: 0.5, y: 1.01 })).toBeNull();
    expect(validateRemotePointerEvent({ kind: "drag", x: 0.5, y: 0.5 })).toBeNull();
    expect(validateRemotePointerEvent({ kind: "move", x: "0.5", y: 0.5 })).toBeNull();
    expect(validateRemotePointerEvent(null)).toBeNull();
  });

  it("accepts short keys and rejects empty / over-long ones", () => {
    expect(validateRemoteKeyEvent({ key: "a" })).toEqual({ key: "a" });
    expect(validateRemoteKeyEvent({ key: "Enter" })).toEqual({ key: "Enter" });
    expect(validateRemoteKeyEvent({ key: "" })).toBeNull();
    expect(validateRemoteKeyEvent({ key: "x".repeat(33) })).toBeNull();
    expect(validateRemoteKeyEvent({ key: 5 })).toBeNull();
    expect(validateRemoteKeyEvent(null)).toBeNull();
  });
});

describe("session audit-event body validation", () => {
  it("accepts the seven allowed actions", () => {
    for (const action of [
      "location.sharing_started",
      "location.sharing_stopped",
      "notifications.sharing_started",
      "notifications.sharing_stopped",
      "interaction.started",
      "interaction.stopped",
      "interaction.killed",
    ] as const) {
      expect(isLiveSessionAuditAction(action)).toBe(true);
      expect(validateSessionEventBody({ action })).toEqual({
        ok: true,
        action,
        details: {},
      });
    }
  });

  it("rejects anything outside the allowlist, bad details, oversize details", () => {
    expect(isLiveSessionAuditAction("session.ended")).toBe(false);
    expect(isLiveSessionAuditAction("file_transfer.completed")).toBe(false);
    expect(validateSessionEventBody({ action: "session.ended" }).ok).toBe(false);
    expect(validateSessionEventBody({ action: "location.sharing_started", details: [] }).ok).toBe(
      false,
    );
    expect(
      validateSessionEventBody({
        action: "location.sharing_started",
        details: { big: "x".repeat(3000) },
      }),
    ).toEqual({ ok: false, error: expect.any(String), status: 413 });
    expect(validateSessionEventBody(null).ok).toBe(false);
  });
});
