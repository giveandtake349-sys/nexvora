"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { Button, ConfigNotice, Input, Label } from "./ui";

function useAuthState() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return { router, searchParams, error, setError, message, setMessage, busy, setBusy };
}

function GoogleButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signInWithGoogle() {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${appUrl}/auth/callback?next=/dashboard` },
    });
    if (error) {
      setError(error.message);
      setBusy(false);
    }
  }
  return (
    <div>
      <Button variant="outline" className="w-full" onClick={signInWithGoogle} disabled={!isSupabaseConfigured() || busy}>
        {busy ? "Redirecting to Google…" : label}
      </Button>
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
    </div>
  );
}

export function LoginForm() {
  const s = useAuthState();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const configured = isSupabaseConfigured();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;
    s.setBusy(true);
    s.setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      s.setError(error.message);
      s.setBusy(false);
      return;
    }
    s.router.push(s.searchParams.get("next") ?? "/dashboard");
    s.router.refresh();
  }

  if (!configured) return <ConfigNotice />;
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <GoogleButton label="Continue with Google" />
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

export function RegisterForm() {
  const s = useAuthState();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const configured = isSupabaseConfigured();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;
    s.setBusy(true);
    s.setError(null);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin;
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: name },
        emailRedirectTo: `${appUrl}/auth/callback?next=/dashboard`,
      },
    });
    if (error) {
      s.setError(error.message);
      s.setBusy(false);
      return;
    }
    s.setMessage("Account created. Check your email to verify your address, then sign in.");
    s.setBusy(false);
  }

  if (!configured) return <ConfigNotice />;
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <GoogleButton label="Continue with Google" />
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

export function ForgotPasswordForm() {
  const s = useAuthState();
  const [email, setEmail] = useState("");
  const configured = isSupabaseConfigured();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;
    s.setBusy(true);
    s.setError(null);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${appUrl}/auth/callback?next=/reset-password`,
    });
    if (error) {
      s.setError(error.message);
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

export function ResetPasswordForm() {
  const s = useAuthState();
  const [password, setPassword] = useState("");
  const configured = isSupabaseConfigured();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;
    s.setBusy(true);
    s.setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      s.setError(error.message);
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
