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

/** Google "G" mark (20px) for the sign-in button. */
function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.07.72-2.44 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28v-3.1H1.29a12 12 0 0 0 0 10.76l3.98-3.1z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.88 8.87 4.77 12 4.77z"
      />
    </svg>
  );
}

/** Spec Chapter 1: Google button — full-width, h 52, glass. */
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
      <button
        type="button"
        onClick={signInWithGoogle}
        disabled={!configured || busy}
        className="pressable flex h-[52px] w-full items-center justify-center gap-3 rounded-[14px] border border-white/10 bg-[rgba(18,27,36,0.72)] text-base font-semibold text-white backdrop-blur-[20px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00E5A8] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        ) : (
          <GoogleG />
        )}
        {busy ? "Redirecting to Google…" : label}
      </button>
      {error && <p className="mt-2 text-xs text-[#FF4757]">{error}</p>}
    </div>
  );
}

/** Spec Chapter 1: 1px line + "or" caption, 20px vertical margins. */
function Divider({ children }: { children: string }) {
  return (
    <div className="my-5 flex items-center gap-3">
      <span className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" aria-hidden="true" />
      <span className="text-xs text-[rgba(242,247,245,0.38)]">{children}</span>
      <span className="h-px flex-1 bg-[rgba(255,255,255,0.06)]" aria-hidden="true" />
    </div>
  );
}

/** Spec Chapter 1: password field with a 20px eye toggle, right inset 14. */
function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
  disabled,
  required,
  minLength,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoComplete: string;
  disabled?: boolean;
  required?: boolean;
  minLength?: number;
  error?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        required={required}
        minLength={minLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        className={`pr-12 ${error ? "border-[#FF4757]" : ""}`}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute top-1/2 right-3.5 -translate-y-1/2 text-[#8FA3A0] hover:text-white focus-visible:outline-2 focus-visible:outline-[#00E5A8]"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {show ? (
            <>
              <path d="M3 3l18 18" />
              <path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c2.5 0 4.9.9 6.8 2.3M6.6 6.6C4.2 8.2 2.6 10 2 12c.6 2.1 2.4 4 4.9 5.2M9.9 9.9a3 3 0 0 0 4.2 4.2" />
            </>
          ) : (
            <>
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </>
          )}
        </svg>
      </button>
    </div>
  );
}

/** Spec Chapter 1: primary — h 52, radius 14, bg #00E5A8, text #062018 16/600. */
function PrimaryButton({
  busy,
  busyLabel,
  children,
  disabled,
}: {
  busy: boolean;
  busyLabel: string;
  children: string;
  disabled?: boolean;
}) {
  return (
    <Button
      type="submit"
      className="h-[52px] w-full text-base"
      disabled={disabled || busy}
    >
      {busy ? (
        <span className="inline-flex items-center gap-2 opacity-70">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#062018]/30 border-t-[#062018]" />
          {busyLabel}
        </span>
      ) : (
        children
      )}
    </Button>
  );
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="text-xs text-[#FF4757]">{error}</p>;
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
    <form onSubmit={onSubmit} className="space-y-3.5">
      <GoogleButton label="Continue with Google" configured={configured} />
      <Divider>or</Divider>
      <div>
        <Label>Email</Label>
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          disabled={s.busy}
          className={s.error ? "border-[#FF4757]" : ""}
        />
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] leading-3 font-bold tracking-[0.06em] text-[rgba(242,247,245,0.62)] uppercase">
            Password
          </span>
          <a
            href="/forgot-password"
            className="text-[13px] font-medium text-[#00E5A8] hover:underline"
          >
            Forgot password?
          </a>
        </div>
        <PasswordInput
          value={password}
          onChange={setPassword}
          placeholder="Your password"
          autoComplete="current-password"
          disabled={s.busy}
          required
          error={Boolean(s.error)}
        />
      </div>
      <ErrorText error={s.error} />
      <PrimaryButton busy={s.busy} busyLabel="Signing in…">
        Sign in
      </PrimaryButton>
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
    <form onSubmit={onSubmit} className="space-y-3.5">
      <GoogleButton label="Continue with Google" configured={configured} />
      <Divider>or</Divider>
      <div>
        <Label>Display name</Label>
        <Input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoComplete="name"
          disabled={s.busy}
          className={s.error ? "border-[#FF4757]" : ""}
        />
      </div>
      <div>
        <Label>Email</Label>
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          disabled={s.busy}
          className={s.error ? "border-[#FF4757]" : ""}
        />
      </div>
      <div>
        <Label>Password</Label>
        <PasswordInput
          value={password}
          onChange={setPassword}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          disabled={s.busy}
          required
          minLength={8}
          error={Boolean(s.error)}
        />
      </div>
      <ErrorText error={s.error} />
      {s.message && <p className="text-sm text-[#00E5A8]">{s.message}</p>}
      <PrimaryButton busy={s.busy} busyLabel="Creating account…">
        Create account
      </PrimaryButton>
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
    <form onSubmit={onSubmit} className="space-y-3.5">
      <div>
        <Label>Email</Label>
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          disabled={s.busy}
          className={s.error ? "border-[#FF4757]" : ""}
        />
      </div>
      <ErrorText error={s.error} />
      {s.message && <p className="text-sm text-[#00E5A8]">{s.message}</p>}
      <PrimaryButton busy={s.busy} busyLabel="Sending…">
        Send reset link
      </PrimaryButton>
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
    <form onSubmit={onSubmit} className="space-y-3.5">
      <div>
        <Label>New password</Label>
        <PasswordInput
          value={password}
          onChange={setPassword}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          disabled={s.busy}
          required
          minLength={8}
          error={Boolean(s.error)}
        />
      </div>
      <ErrorText error={s.error} />
      {s.message && <p className="text-sm text-[#00E5A8]">{s.message}</p>}
      <PrimaryButton busy={s.busy} busyLabel="Updating…">
        Update password
      </PrimaryButton>
    </form>
  );
}
