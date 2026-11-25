"use client";

import { createAuthClient } from "@neon/auth/next";

/**
 * Browser auth client (Managed Better Auth via @neon/auth). It talks to
 * the same-origin proxy at /api/auth/* — no auth URL is needed in the
 * browser and no keys are exposed to client code.
 */
export const authClient = createAuthClient();
