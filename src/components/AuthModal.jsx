// src/components/AuthModal.jsx
import { useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import logo from "./assets/finance-family-tracker-logo.png";

function isInviteOrRecoveryUrl() {
  const href = window.location.href;
  return (
    href.includes("type=invite") ||
    href.includes("type=recovery") ||
    href.includes("access_token=") ||
    href.includes("refresh_token=")
  );
}

function PasswordInput({
  value,
  onChange,
  placeholder = "Password",
  autoComplete = "current-password",
}) {
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
	<img src={logo} alt="Family Finance Tracker" className="h-10 mb-2" />

      <input
        type={show ? "text" : "password"}
        placeholder={placeholder}
        className="w-full border rounded px-3 py-2 pr-12"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-sm text-gray-600 hover:text-gray-900 px-2 py-1"
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

export default function AuthModal({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const inviteMode = useMemo(() => {
    return (
      window.location.pathname === "/accept-invite" || isInviteOrRecoveryUrl()
    );
  }, []);

  const signInWithGithub = async () => {
    setErrorMsg(null);
    setBusy(true);
    try {
      const redirectTo = window.location.origin;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo },
      });
      if (error) setErrorMsg(error.message);
    } finally {
      setBusy(false);
    }
  };

  const handleAuth = async (type) => {
    setErrorMsg(null);

    if (!email || !password) {
      setErrorMsg("Please enter an email and password.");
      return;
    }

    setBusy(true);
    try {
      if (type === "signin") {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) return setErrorMsg(error.message);
        if (data?.session) onSignedIn?.();
        return;
      }

      // signup
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return setErrorMsg(error.message);

      // If email confirmations are ON, session will be null until confirmed
      if (data?.session) onSignedIn?.();
      else setErrorMsg("Signup created. Confirm your email, then Sign In.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-xl font-bold mb-4 text-gray-800">
          Sign in to Family Finance Tracker
        </h2>

        <div className="space-y-3">
          <input
            type="email"
            placeholder="Email"
            className="w-full border rounded px-3 py-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />

          <PasswordInput
            value={password}
            onChange={setPassword}
            placeholder="Password"
            autoComplete="current-password"
          />

          {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}

          {!inviteMode && (
            <button
              type="button"
              onClick={signInWithGithub}
              disabled={busy}
              className="w-full bg-black text-white rounded px-4 py-2 hover:opacity-90 disabled:opacity-60"
            >
              Continue with GitHub
            </button>
          )}

          <div className="flex gap-2 pt-2">
            <button
              onClick={() => handleAuth("signin")}
              disabled={busy}
              className="flex-1 bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 disabled:opacity-60"
            >
              Sign In
            </button>

            {!inviteMode && (
              <button
                onClick={() => handleAuth("signup")}
                disabled={busy}
                className="flex-1 bg-gray-200 text-gray-800 rounded px-4 py-2 hover:bg-gray-300 disabled:opacity-60"
              >
                Sign Up
              </button>
            )}
          </div>

          {inviteMode && (
            <p className="text-xs text-gray-500 pt-2">
              You’re finishing an invitation/password setup. OAuth sign-in is
              disabled here on purpose.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
