// src/components/AuthModal.jsx
import { useState } from "react";
import { supabase } from "../supabaseClient";

export default function AuthModal({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);

 const handleAuth = async (type) => {
  setError(null);

  if (!email || !password) {
    setError("Please enter an email and password.");
    return;
  }

  if (type === "signin") {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      return;
    }
    if (data?.session) onSignedIn?.(); // close modal only if session exists
    return;
  }

  if (error) {
  console.error("Supabase auth error:", error);
  setError(error.message);
  return;
}


  // signup
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    setError(error.message);
    return;
  }

  // If confirmations are ON, session will be null until email confirmed
  if (data?.session) {
    onSignedIn?.();
  } else {
    setError("Signup created. Email confirmation is enabled—confirm your email, then Sign In.");
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
          />

          <input
            type="password"
            placeholder="Password"
            className="w-full border rounded px-3 py-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button
              onClick={() => handleAuth("signin")}
              className="flex-1 bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700"
            >
              Sign In
            </button>
            <button
              onClick={() => handleAuth("signup")}
              className="flex-1 bg-gray-200 text-gray-800 rounded px-4 py-2 hover:bg-gray-300"
            >
              Sign Up
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
