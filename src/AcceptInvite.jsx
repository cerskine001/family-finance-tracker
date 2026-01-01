import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";
import logo from "./assets/finance-family-tracker-logo.png";

function PasswordInput({
  label,
  value,
  onChange,
  placeholder,
  autoComplete = "new-password",
}) {
  const [show, setShow] = useState(false);

  return (
    <div className="mt-3">
      <label className="block text-sm text-slate-700 mb-1">{label}</label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 pr-14 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
        />

        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-sm text-slate-600 hover:text-slate-900 px-2 py-1"
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
    if (!confirm) return true;
    return password === confirm;
  }, [password, confirm]);

  const canSubmit = useMemo(() => {
    return (
      !busy &&
      password.length >= 8 &&
      confirm.length >= 1 &&
      passwordsMatch
    );
  }, [busy, password, confirm, passwordsMatch]);

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

  // Error state (no session)
  if (error && !ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-200 p-6">
          <h2 className="text-xl font-bold text-slate-900">Invitation problem</h2>
          <p className="mt-3 text-sm text-red-600">{error}</p>
        </div>
      </div>
    );
  }

  // Loading state
  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-200 p-6">
          <h2 className="text-xl font-bold text-slate-900">Preparing your account…</h2>
          <p className="mt-2 text-sm text-slate-600">
            Please wait a moment while we verify your invitation link.
          </p>
        </div>
      </div>
    );
  }

  // Main UI
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-200 p-6">

	<div className="flex flex-col items-center mb-4">
  	<img
    		src={logo}
    		alt="Family Finance Tracker"
    		className="h-14 mb-2"
  	/>
	</div>

        <h2 className="text-xl font-bold text-slate-900">
          Finish setting up your account
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Create a password to complete your invitation.
        </p>

        <div className="mt-4" onKeyDown={onKeyDown}>
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
            <p className="mt-3 text-sm text-red-600">Passwords do not match.</p>
          )}

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

          <button
            type="button"
            onClick={handleSetPassword}
            disabled={!canSubmit}
            className="mt-4 w-full rounded-lg px-4 py-2 text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-400 disabled:cursor-not-allowed"
          >
            {busy ? "Saving…" : "Set password"}
          </button>

          {success && (
            <p className="mt-3 text-sm text-green-700">
              Account ready! Redirecting…
            </p>
          )}

          <p className="mt-3 text-xs text-slate-500">
            Tip: Press <span className="font-semibold">Enter</span> to submit.
          </p>
        </div>
      </div>
    </div>
  );
}
