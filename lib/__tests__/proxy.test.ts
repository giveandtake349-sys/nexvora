/**
 * Middleware public-routes regression tests — M1 debug fix.
 *
 * Signed-out /api/* requests used to be 307-redirected to /login by
 * the Neon Auth middleware, so API handlers never got to return their
 * JSON 401 and the signaling client followed the redirect to an HTML
 * login page. /api must stay public TO THE MIDDLEWARE (the handlers
 * still enforce auth via requireAuth()); only the page routes below
 * keep the login redirect.
 */
import { describe, it, expect } from "vitest";
import { PUBLIC_ROUTES } from "../public-routes";

describe("PUBLIC_ROUTES (proxy.ts)", () => {
  it("includes /api so unauthenticated API calls reach their handlers' JSON 401", () => {
    expect(PUBLIC_ROUTES).toContain("/api");
  });

  it("still lists the public page routes (landing + auth pages)", () => {
    expect(PUBLIC_ROUTES).toContain("/");
    expect(PUBLIC_ROUTES).toContain("/login");
    expect(PUBLIC_ROUTES).toContain("/register");
    expect(PUBLIC_ROUTES).toContain("/forgot-password");
    expect(PUBLIC_ROUTES).toContain("/reset-password");
  });

  it("does not list any protected page route", () => {
    expect(PUBLIC_ROUTES).not.toContain("/dashboard");
    expect(PUBLIC_ROUTES).not.toContain("/dashboard/devices");
  });
});
