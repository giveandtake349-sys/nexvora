"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";
import { PERMISSION_SCOPES, SCOPE_LABELS, type PermissionScope } from "@/lib/permissions";
import { Button, Input, Label } from "./ui";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return { router, error, setError, message, setMessage, busy, setBusy };
}

/** Register the current browser as a device. */
export function RegisterDeviceForm() {
  const s = useAction();
  const [name, setName] = useState("");
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    s.setBusy(true);
    s.setError(null);
    try {
      const fingerprint = localStorage.getItem("nexvora-device-id") ?? crypto.randomUUID();
      localStorage.setItem("nexvora-device-id", fingerprint);
      await api("/api/devices", { method: "POST", body: JSON.stringify({ name, fingerprint }) });
      s.setMessage("Device registered.");
      setName("");
      s.router.refresh();
    } catch (err) {
      s.setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      s.setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex-1">
        <Label>Device name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My Laptop" required />
      </div>
      <Button type="submit" disabled={s.busy}>
        {s.busy ? "Registering…" : "Register this device"}
      </Button>
      {s.error && <p className="text-sm text-red-300">{s.error}</p>}
      {s.message && <p className="text-sm text-[#00E5A8]">{s.message}</p>}
    </form>
  );
}

export function RemoveDeviceButton({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  const s = useAction();
  async function remove() {
    if (!confirm(`Remove "${deviceName}"? Its grants will be revoked and its sessions ended.`)) return;
    s.setBusy(true);
    try {
      await api(`/api/devices?id=${deviceId}`, { method: "DELETE" });
      s.router.refresh();
    } catch (err) {
      s.setError(err instanceof Error ? err.message : "Removal failed");
      s.setBusy(false);
    }
  }
  return (
    <div>
      <Button variant="danger" onClick={remove} disabled={s.busy}>
        Remove
      </Button>
      {s.error && <p className="mt-1 text-xs text-red-300">{s.error}</p>}
    </div>
  );
}

/** Generate a temporary 6-digit pairing code for one of my devices. */
export function GenerateCodeForm({ devices }: { devices: { id: string; name: string }[] }) {
  const s = useAction();
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "");
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    s.setBusy(true);
    s.setError(null);
    try {
      const data = await api("/api/pairing/generate", { method: "POST", body: JSON.stringify({ deviceId }) });
      setCode(data.code);
      setExpiresAt(data.expiresAt);
    } catch (err) {
      s.setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      s.setBusy(false);
    }
  }
  if (devices.length === 0) {
    return <p className="text-sm text-[#8FA3A0]">Register a device first (My Devices), then generate a pairing code for it.</p>;
  }
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label>Device to share</Label>
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="w-full rounded-lg border border-[#1E2D38] bg-[#0D141B] px-3.5 py-2.5 text-sm text-white outline-none">
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" disabled={s.busy}>
        {s.busy ? "Generating…" : "Generate pairing code"}
      </Button>
      {s.error && <p className="text-sm text-red-300">{s.error}</p>}
      {code && (
        <div className="rounded-[20px] border border-[#D4AF37]/35 bg-[rgba(18,27,36,0.72)] p-4 text-center shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
          <p className="text-[10px] leading-3 font-bold tracking-[0.06em] text-[rgba(242,247,245,0.62)] uppercase">
            Pairing code
          </p>
          <p className="mt-2 font-display text-[32px] leading-8 font-bold tracking-[8px] text-[#D4AF37]">
            {code}
          </p>
          <p className="mt-2 text-xs text-[#8FA3A0]">
            Enter on your new device · expires{" "}
            {expiresAt ? new Date(expiresAt).toLocaleTimeString() : ""}. The code alone grants
            nothing — you must still approve the request.
          </p>
        </div>
      )}
    </form>
  );
}

/** Enter a pairing code received from another user. */
export function RedeemCodeForm() {
  const s = useAction();
  const [code, setCode] = useState("");
  const [selected, setSelected] = useState<PermissionScope[]>(["device_info"]);
  function toggle(scope: PermissionScope) {
    setSelected((prev) => (prev.includes(scope) ? prev.filter((x) => x !== scope) : [...prev, scope]));
  }
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    s.setBusy(true);
    s.setError(null);
    try {
      const fingerprint = localStorage.getItem("nexvora-device-id") ?? crypto.randomUUID();
      localStorage.setItem("nexvora-device-id", fingerprint);
      await api("/api/pairing/redeem", {
        method: "POST",
        body: JSON.stringify({ code, deviceId: null, requestedScopes: selected }),
      });
      s.setMessage("Connection request sent. The device owner must approve it before anything is granted.");
      setCode("");
      s.router.refresh();
    } catch (err) {
      s.setError(err instanceof Error ? err.message : "Redeem failed");
    } finally {
      s.setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label>Pairing code</Label>
        <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6-digit code" inputMode="numeric" required />
      </div>
      <div>
        <Label>Permissions to request</Label>
        <div className="flex flex-wrap gap-2">
          {PERMISSION_SCOPES.map((scope) => (
            <button
              key={scope}
              type="button"
              onClick={() => toggle(scope)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                selected.includes(scope)
                  ? "border-[#00E5A8] bg-[#00E5A8]/10 text-[#00E5A8]"
                  : "border-[#1E2D38] text-[#8FA3A0]"
              }`}
            >
              {SCOPE_LABELS[scope]}
            </button>
          ))}
        </div>
      </div>
      <Button type="submit" disabled={s.busy}>
        {s.busy ? "Sending request…" : "Send connection request"}
      </Button>
      {s.error && <p className="text-sm text-red-300">{s.error}</p>}
      {s.message && <p className="text-sm text-[#00E5A8]">{s.message}</p>}
    </form>
  );
}

/** Owner approves (subset) or rejects a pending connection request. */
export function DecideRequestForm({
  requestId,
  requestedScopes,
}: {
  requestId: string;
  requestedScopes: PermissionScope[];
}) {
  const s = useAction();
  const [selected, setSelected] = useState<PermissionScope[]>(requestedScopes);
  function toggle(scope: PermissionScope) {
    setSelected((prev) => (prev.includes(scope) ? prev.filter((x) => x !== scope) : [...prev, scope]));
  }
  async function approve() {
    s.setBusy(true);
    s.setError(null);
    try {
      await api(`/api/connection-requests/${requestId}/approve`, { method: "POST", body: JSON.stringify({ scopes: selected }) });
      s.router.refresh();
    } catch (err) {
      s.setError(err instanceof Error ? err.message : "Approval failed");
      s.setBusy(false);
    }
  }
  async function reject() {
    if (!confirm("Reject this connection request? No permissions will be granted.")) return;
    s.setBusy(true);
    try {
      await api(`/api/connection-requests/${requestId}/reject`, { method: "POST" });
      s.router.refresh();
    } catch (err) {
      s.setError(err instanceof Error ? err.message : "Rejection failed");
      s.setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {requestedScopes.map((scope) => (
          <button
            key={scope}
            type="button"
            onClick={() => toggle(scope)}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
              selected.includes(scope)
                ? "border-[#00E5A8] bg-[#00E5A8]/10 text-[#00E5A8]"
                : "border-[#1E2D38] text-[#8FA3A0]"
            }`}
          >
            {SCOPE_LABELS[scope]}
          </button>
        ))}
      </div>
      <p className="text-xs text-[#8FA3A0]">
        Only the checked scopes will be granted (30-day expiry). Unchecked scopes stay ungranted.
      </p>
      <div className="flex gap-3">
        <Button onClick={approve} disabled={s.busy || selected.length === 0} className="h-10 flex-1">
          Approve selected
        </Button>
        <Button variant="glass" onClick={reject} disabled={s.busy} className="h-10 flex-1">
          Decline
        </Button>
      </div>
      {s.error && <p className="text-sm text-red-300">{s.error}</p>}
    </div>
  );
}

export function RevokePermissionButton({ permissionId, scope }: { permissionId: string; scope: string }) {
  const s = useAction();
  async function revoke() {
    if (!confirm(`Revoke the "${scope}" permission? Active sessions for that user on this device will end immediately.`)) return;
    s.setBusy(true);
    try {
      await api(`/api/permissions?id=${permissionId}`, { method: "DELETE" });
      s.router.refresh();
    } catch (err) {
      s.setError(err instanceof Error ? err.message : "Revocation failed");
      s.setBusy(false);
    }
  }
  return (
    <div>
      <Button variant="danger" onClick={revoke} disabled={s.busy}>
        Revoke
      </Button>
      {s.error && <p className="mt-1 text-xs text-red-300">{s.error}</p>}
    </div>
  );
}

export function RevokeDeviceButton({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  const s = useAction();
  async function revoke() {
    if (!confirm(`Revoke ALL access to "${deviceName}"? Every grant is revoked and every active session ends immediately.`)) return;
    s.setBusy(true);
    try {
      await api("/api/permissions/revoke-device", { method: "POST", body: JSON.stringify({ deviceId }) });
      s.router.refresh();
    } catch (err) {
      s.setError(err instanceof Error ? err.message : "Revocation failed");
      s.setBusy(false);
    }
  }
  return (
    <div>
      <Button variant="danger" onClick={revoke} disabled={s.busy}>
        Revoke device
      </Button>
      {s.error && <p className="mt-1 text-xs text-red-300">{s.error}</p>}
    </div>
  );
}

export function DisconnectSessionButton({ sessionId }: { sessionId: string }) {
  const s = useAction();
  async function disconnect() {
    s.setBusy(true);
    try {
      await api("/api/sessions/disconnect", { method: "POST", body: JSON.stringify({ sessionId }) });
      s.router.refresh();
    } catch (err) {
      s.setError(err instanceof Error ? err.message : "Disconnect failed");
      s.setBusy(false);
    }
  }
  return (
    <div>
      <Button variant="outline" onClick={disconnect} disabled={s.busy}>
        Disconnect
      </Button>
      {s.error && <p className="mt-1 text-xs text-red-300">{s.error}</p>}
    </div>
  );
}

export function DisconnectAllButton() {
  const s = useAction();
  async function disconnectAll() {
    if (!confirm("Disconnect ALL of your active sessions?")) return;
    s.setBusy(true);
    try {
      const data = await api("/api/sessions/disconnect-all", { method: "POST" });
      s.setMessage(`Ended ${data.endedCount} session(s).`);
      s.router.refresh();
    } catch (err) {
      s.setError(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      s.setBusy(false);
    }
  }
  return (
    <div>
      <Button variant="danger" onClick={disconnectAll} disabled={s.busy}>
        Disconnect all sessions
      </Button>
      {s.error && <p className="mt-1 text-sm text-red-300">{s.error}</p>}
      {s.message && <p className="mt-1 text-sm text-[#00E5A8]">{s.message}</p>}
    </div>
  );
}

/** Edit the signed-in user's display name. */
export function UpdateProfileForm({ currentName }: { currentName: string }) {
  const s = useAction();
  const [name, setName] = useState(currentName);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    s.setBusy(true);
    s.setError(null);
    try {
      // The auth user record is the source of truth for the display name
      // shown across the dashboard (getSessionUser reads it), so update
      // it first; the profile row is then synced by the PATCH below.
      const { error: authError } = await authClient.updateUser({ name });
      if (authError) throw new Error(authError.message ?? "Could not update your name");
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Update failed");
      s.setMessage("Profile updated.");
      s.router.refresh();
    } catch (err) {
      s.setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      s.setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label>Display name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <Button type="submit" disabled={s.busy}>
        {s.busy ? "Saving…" : "Save profile"}
      </Button>
      {s.error && <p className="text-sm text-red-300">{s.error}</p>}
      {s.message && <p className="text-sm text-[#00E5A8]">{s.message}</p>}
    </form>
  );
}
