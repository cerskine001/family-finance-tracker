import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

export default function AcceptInvite() {
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    // Supabase will auto-detect the session from the invite URL
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

    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      return;
    }

    setSuccess(true);

    // redirect back to app
    setTimeout(() => {
      window.location.href = "/";
    }, 800);
  };

  if (error) {
    return <div style={{ padding: 24 }}>{error}</div>;
  }

  if (!ready) {
    return <div style={{ padding: 24 }}>Preparing your account…</div>;
  }

  return (
    <div style={{ padding: 24, maxWidth: 420 }}>
      <h2>Finish setting up your account</h2>
      <p>Create a password to complete your invitation.</p>

      <input
        type="password"
        placeholder="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={{ width: "100%", padding: 10, marginTop: 12 }}
      />

      <button
        onClick={handleSetPassword}
        style={{ width: "100%", padding: 10, marginTop: 12 }}
      >
        Set password
      </button>

      {success && <p style={{ color: "green" }}>Account ready! Redirecting…</p>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </div>
  );
}
