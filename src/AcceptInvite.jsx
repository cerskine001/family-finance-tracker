import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

function PasswordInput({ label, value, onChange, placeholder, autoComplete }) {
  const [show, setShow] = useState(false);

  return (
    <div style={{ marginTop: 12 }}>
      <label style={{ display: "block", fontSize: 13, color: "#334155", marginBottom: 6 }}>
        {label}
      </label>

      <div style={{ position: "relative" }}>
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          style={{
            width: "100%",
            padding: "12px 44px 12px 12px",
            borderRadius: 10,
            border: "1px solid #d1d5db",
            outline: "none",
            fontSize: 15,
          }}
        />

        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
          style={{
            position: "absolute",
            right: 10,
            top: "50%",
            transform: "translateY(-50%)",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontSize: 13,
            color: "#475569",
            padding: "6px 8px",
          }}
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

export default function AcceptInvite() {
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const passwordsMatch = useMemo(() => {
    if (!confirm) return true; // don't show mismatch while empty
    return password === confirm;
  }, [password, confirm]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (data?.session) {
        setReady(true);
      } else {
        setError("Invite link is invalid or expired. Please request a new invite.");
      }
    })();
  }, []);

  const handleSetPassword = async () => {
    setError(null);

    if (!password || password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (!passwordsMatch) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setError(error.message);
        return;
      }

      setSuccess(true);

      setTimeout(() => {
        window.location.href = "/";
      }, 800);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && ready && !busy) {
      handleSetPassword();
    }
  };

  if (error && !ready) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ maxWidth: 520, width: "100%", padding: 18 }}>
          <div style={{ background: "white", borderRadius: 14, padding: 18, border: "1px solid #e5e7eb" }}>
            <h2 style={{ margin: 0, fontSize: 20, color: "#0f172a" }}>Invitation problem</h2>
            <p style={{ marginTop: 10, color: "#b91c1c" }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ maxWidth: 520, width: "100%", padding: 18 }}>
          <div style={{ background: "white", borderRadius: 14, padding: 18, border: "1px solid #e5e7eb" }}>
            <h2 style={{ margin: 0, fontSize: 20, color: "#0f172a" }}>Preparing your account…</h2>
            <p style={{ marginTop: 8, color: "#475569" }}>
              Please wait a moment while we verify your invitation link.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#f8fafc" }}>
      <div style={{ maxWidth: 520, width: "100%" }}>
        <div style={{ background: "white", borderRadius: 16, padding: 20, border: "1px solid #e5e7eb" }}>
          <h2 style={{ margin: 0, fontSize: 22, color: "#0f172a" }}>
            Finish setting up your account
          </h2>
          <p style={{ marginTop: 8, marginBottom: 0, color: "#475569", fontSize: 14 }}>
            Create a password to complete your invitation.
          </p>

          <div onKeyDown={onKeyDown} style={{ marginTop: 14 }}>
            <PasswordInput
              label="New password"
              value={password}
              onChange={setPassword}
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />

            <PasswordInput
              label="Confirm password"
              value={confirm}
              onChange={setConfirm}
              placeholder="Re-enter password"
              autoComplete="new-password"
            />

            {!passwordsMatch && (
              <p style={{ color: "#b91c1c", fontSize: 13, marginTop: 10, marginBottom: 0 }}>
                Passwords do not match.
              </p>
            )}

            {error && (
              <p style={{ color: "#b91c1c", fontSize: 13, marginTop: 10, marginBottom: 0 }}>
                {error}
              </p>
            )}

            <button
              onClick={handleSetPassword}
              disabled={busy || !password || password.length < 8 || !passwordsMatch}
              style={{
                width: "100%",
                padding: 12,
                marginTop: 14,
                borderRadius: 10,
                border: "none",
                background: busy ? "#94a3b8" : "#4f46e5",
                color: "white",
                fontSize: 15,
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              {busy ? "Saving…" : "Set password"}
            </button>

            {success && (
              <p style={{ color: "#15803d", fontSize: 13, marginTop: 12, marginBottom: 0 }}>
                Account ready! Redirecting…
              </p>
            )}

            <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 12, marginBottom: 0 }}>
              Tip: You can press Enter to submit.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
