// src/components/AuthModal.jsx
import { useState } from "react";
import { supabase } from "../supabaseClient";

function isInviteOrRecoveryUrl() {
  const href = window.location.href;
  return (
    href.includes("type=invite") ||
    href.includes("type=recovery") ||
    href.includes("access_token=") ||
    href.includes("refresh_token=")
  );
}

export default function AuthModal({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState(null);

  const inviteMode =
    window.location.pathname === "/accept-invite" ||
    isInviteOrRecoveryUrl();

  const signInWithGithub = async () => {
    setErrorMsg(null);

    const redirectTo = window.location.origin;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo },
    });

    if (error) setErrorMsg(error.message);
  };

  // ...rest of file


  const handleAuth = async (type) => {
    setErrorMsg(null);

    if (!email || !password) {
      setErrorMsg("Please enter an email and password.");
      return;
    }

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
          />

          <input
            type="password"
            placeholder="Password"
            className="w-full border rounded px-3 py-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}

          {!inviteMode && (
  	  <button
    		type="button"
    		onClick={signInWithGithub}
    		className="w-full bg-black text-white rounded px-4 py-2 hover:opacity-90"
  	  >
    		Continue with GitHub
  	  </button>
	)}


          <div className="flex gap-2 pt-2">
            <button
              onClick={() => handleAuth("signin")}
              className="flex-1 bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700"
            >
              Sign In
            </button>
	    {!inviteMode && (
            <button
              onClick={() => handleAuth("signup")}
              className="flex-1 bg-gray-200 text-gray-800 rounded px-4 py-2 hover:bg-gray-300"
            >
              Sign Up
            </button>
	    )}
          </div>
        </div>
      </div>
    </div>
  );
}
