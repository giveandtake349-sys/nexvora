"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { Button, ConfigNotice, Input, Label } from "./ui";

function useAuthState() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return { router, searchParams, error, setError, message, setMessage, busy, setBusy };
}

function GoogleButton({ label, configured }: { label: string; configured: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signInWithGoogle() {
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/dashboard",
    });
    if (error) {
      setError(error.message ?? "Google sign-in failed");
      setBusy(false);
    }
    // On success the client redirects the browser to Google.
  }
  return (
    <div>
      <Button variant="outline" className="w-full" onClick={signInWithGoogle} disabled={!configured || busy}>
        {busy ? "Redirecting to Google…" : label}
      </Button>
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
    </div>
  );
}

export function LoginForm({ configured }: { configured: boolean }) {
  const s = useAuthState();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    s.setBusy(true);
    s.setError(null);
    const { error } = await authClient.signIn.email({ email, password });
    if (error) {
      s.setError(error.message ?? "Sign-in failed");
      s.setBusy(false);
      return;
    }
    s.router.push(s.searchParams.get("next") ?? "/dashboard");
    s.router.refresh();
  }

  if (!configured) return <ConfigNotice />;
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <GoogleButton label="Continue with Google" configured={configured} />
      <div className="text-center text-xs text-[#8FA3A0]">or sign in with email</div>
      <div>
        <Label>Email</Label>
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
      </div>
      <div>
        <Label>Password</Label>
        <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" autoComplete="current-password" />
      </div>
      {s.error && <p className="text-sm text-red-300">{s.error}</p>}
      <Button type="submit" className="w-full" disabled={s.busy}>
        {s.busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

export function RegisterForm({ configured }: { configured: boolean }) {
  const s = useAuthState();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    s.setBusy(true);
    s.setError(null);
    const { error } = await authClient.signUp.email({ email, password, name });
    if (error) {
      s.setError(error.message ?? "Registration failed");
      s.setBusy(false);
      return;
    }
    // If the Neon Auth project does not require email verification the
    // user is signed in immediately — go straight to the dashboard.
    // Otherwise they must verify first; tell them to check their inbox.
    const { data: session } = await authClient.getSession();
    if (session?.session) {
      s.router.push("/dashboard");
      s.router.refresh();
      return;
    }
    s.setMessage("Account created. Check your email to verify your address, then sign in.");
    s.setBusy(false);
  }

  if (!configured) return <ConfigNotice />;
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <GoogleButton label="Continue with Google" configured={configured} />
      <div className="text-center text-xs text-[#8FA3A0]">or register with email</div>
      <div>
        <Label>Display name</Label>
        <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" />
      </div>
      <div>
        <Label>Email</Label>
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
      </div>
      <div>
        <Label>Password</Label>
        <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
      </div>
      {s.error && <p className="text-sm text-red-300">{s.error}</p>}
      {s.message && <p className="text-sm text-[#00E5A8]">{s.message}</p>}
      <Button type="submit" className="w-full" disabled={s.busy}>
        {s.busy ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}

export function ForgotPasswordForm({ configured }: { configured: boolean }) {
  const s = useAuthState();
  const [email, setEmail] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    s.setBusy(true);
    s.setError(null);
    // better-auth 1.7 renamed the reset request: /forget-password was
    // removed in favour of /request-password-reset.
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    if (error) {
      s.setError(error.message ?? "Could not send the reset link");
      s.setBusy(false);
      return;
    }
    s.setMessage("If an account exists for that email, a password reset link has been sent.");
    s.setBusy(false);
  }

  if (!configured) return <ConfigNotice />;
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <Label>Email</Label>
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
      </div>
      {s.error && <p className="text-sm text-red-300">{s.error}</p>}
      {s.message && <p className="text-sm text-[#00E5A8]">{s.message}</p>}
      <Button type="submit" className="w-full" disabled={s.busy}>
        {s.busy ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}

export function ResetPasswordForm({ configured }: { configured: boolean }) {
  const s = useAuthState();
  const [password, setPassword] = useState("");
  const token = s.searchParams.get("token");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) {
      s.setError("This reset link is invalid or expired. Request a new one from the forgot-password page.");
      return;
    }
    s.setBusy(true);
    s.setError(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    if (error) {
      s.setError(error.message ?? "Could not update the password");
      s.setBusy(false);
      return;
    }
    s.setMessage("Password updated. Redirecting to sign in…");
    setTimeout(() => s.router.push("/login"), 1200);
  }

  if (!configured) return <ConfigNotice />;
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <Label>New password</Label>
        <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
      </div>
      {s.error && <p className="text-sm text-red-300">{s.error}</p>}
      {s.message && <p className="text-sm text-[#00E5A8]">{s.message}</p>}
      <Button type="submit" className="w-full" disabled={s.busy}>
        {s.busy ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}
