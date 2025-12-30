// src/components/HouseholdGate.jsx

import { useMemo, useState } from "react";
import { supabase } from "../supabaseClient";

export default function HouseholdGate({ onDone }) {
  const [mode, setMode] = useState("create"); // "create" | "join"
  const [householdName, setHouseholdName] = useState("Our Household");
  const [joinCode, setJoinCode] = useState("");

  const [createdCode, setCreatedCode] = useState(null);
  const [createdHouseholdId, setCreatedHouseholdId] = useState(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [info, setInfo] = useState(null);

  const title = useMemo(
    () => (mode === "create" ? "Create Household" : "Join Household"),
    [mode]
  );

  // Normalize Supabase RPC output (some return array, some return object)
  const normalizeRow = (data) => {
    if (!data) return null;
    return Array.isArray(data) ? data[0] : data;
  };

  // ✅ Re-reveal: fetch existing join_code for a given household id
  const fetchJoinCode = async (hid) => {
    setError(null);
    setInfo(null);
    setCopied(false);

    if (!hid) {
      setError("Missing household id.");
      return;
    }

    setBusy(true);
    try {
      const { data, error } = await supabase
        .from("households")
        .select("join_code")
        .eq("id", hid)
        .single();

      if (error) throw error;

      const code = data?.join_code ?? null;
      if (!code) {
        setError("No join code found for this household.");
        return;
      }
      setCreatedCode(code);
      setInfo("Join code retrieved.");
    } catch (e) {
      setError(e?.message ?? "Could not fetch join code");
    } finally {
      setBusy(false);
    }
  };

  // ✅ Regenerate / rotate code (optional but included)
  // Requires you to create RPC: rotate_household_code(hid uuid) returns text
  const rotateJoinCode = async () => {
    setError(null);
    setInfo(null);
    setCopied(false);

    if (!createdHouseholdId) {
      setError("Create a household first.");
      return;
    }

    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("rotate_household_code", {
        hid: createdHouseholdId,
      });

      if (error) throw error;

      // rotate_household_code returns the new join code as text
      const newCode = data ?? null;
      if (!newCode) {
        setError("Rotate succeeded but no code was returned.");
        return;
      }

      setCreatedCode(newCode);
      setInfo("Join code regenerated.");
    } catch (e) {
      setError(e?.message ?? "Failed to regenerate join code");
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    setError(null);
    setInfo(null);
    setCopied(false);
    setBusy(true);

    try {
      const name = householdName?.trim();
      if (!name) {
        setError("Please enter a household name.");
        return;
      }

      const { data, error } = await supabase.rpc("create_household", {
        household_name: name,
      });
      if (error) throw error;

      const row = normalizeRow(data);

      const hid = row?.household_id ?? null;
      const code = row?.join_code ?? null;

      setCreatedHouseholdId(hid);
      setCreatedCode(code);

      // ✅ If UI was missed, we can still re-reveal later
      // But also try to fetch it immediately to be safe (RLS must allow)
      if (hid && !code) {
        await fetchJoinCode(hid);
      }

      setInfo("Household created. Copy the code and press Continue.");
      // ✅ Do NOT close gate yet; user may want to copy / share code
    } catch (e) {
      setError(e?.message ?? "Failed to create household");
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    setError(null);
    setInfo(null);
    setCopied(false);
    setBusy(true);

    try {
      const code = joinCode.trim();
      if (!code) {
        setError("Enter a join code.");
        return;
      }

      const { data, error } = await supabase.rpc("join_household_by_code", {
        code,
      });
      if (error) throw error;

      // join_household_by_code returns household_id (uuid)
      onDone?.(data);
    } catch (e) {
      setError(e?.message ?? "Invalid join code");
    } finally {
      setBusy(false);
    }
  };

  const copyCreatedCode = async () => {
    if (!createdCode) return;
    try {
      await navigator.clipboard.writeText(createdCode);
      setCopied(true);
      setInfo("Copied to clipboard.");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard copy failed (browser blocked). You can still select & copy.");
    }
  };

  const resetCreateState = () => {
    setCreatedCode(null);
    setCreatedHouseholdId(null);
    setInfo(null);
    setError(null);
    setCopied(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40">
      <div className="bg-white w-full md:max-w-xl rounded-t-2xl md:rounded-2xl shadow-xl p-6 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xl font-bold text-gray-800">{title}</h2>

          <div className="flex gap-2">
            <button
              type="button"
              className={`px-3 py-1 rounded text-sm ${
                mode === "create" ? "bg-indigo-600 text-white" : "bg-gray-200"
              }`}
              onClick={() => {
                setError(null);
                setInfo(null);
                setMode("create");
              }}
            >
              Create
            </button>

            <button
              type="button"
              className={`px-3 py-1 rounded text-sm ${
                mode === "join" ? "bg-indigo-600 text-white" : "bg-gray-200"
              }`}
              onClick={() => {
                setError(null);
                setInfo(null);
                setMode("join");
              }}
            >
              Join
            </button>
          </div>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          You must be in a household to view data.
        </p>

        {mode === "create" ? (
          <div className="space-y-3">
            <input
              className="w-full border rounded px-3 py-2"
              value={householdName}
              onChange={(e) => setHouseholdName(e.target.value)}
              placeholder="Household name"
            />

            <button
              type="button"
              disabled={busy}
              onClick={handleCreate}
              className="w-full bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 disabled:opacity-60"
            >
              {busy ? "Creating..." : "Create Household"}
            </button>

            {(createdCode || createdHouseholdId) && (
              <div className="border rounded-lg p-3 bg-indigo-50">
                <p className="text-sm font-semibold text-gray-800">
                  Your join code:
                </p>

                <div className="mt-1 flex items-center justify-between gap-3">
                  <code className="text-lg font-bold font-mono">
                    {createdCode ?? "—"}
                  </code>

                  <button
                    type="button"
                    className="text-sm text-indigo-700 hover:text-indigo-900"
                    onClick={copyCreatedCode}
                    disabled={!createdCode}
                    title={!createdCode ? "No code to copy yet" : "Copy code"}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>

                <p className="text-xs text-gray-600 mt-2">
                  Share this code with your spouse to join.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3">
                  <button
                    type="button"
                    className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300 text-sm"
                    onClick={resetCreateState}
                  >
                    Create a different one
                  </button>

                  <button
                    type="button"
                    className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300 text-sm"
                    onClick={() => fetchJoinCode(createdHouseholdId)}
                    disabled={!createdHouseholdId || busy}
                    title={!createdHouseholdId ? "Create first to fetch code" : "Fetch join code"}
                  >
                    {busy ? "Loading..." : "Show code again"}
                  </button>

                  <button
                    type="button"
                    className="md:col-span-2 px-3 py-2 rounded bg-gray-900 text-white hover:bg-black text-sm"
                    onClick={rotateJoinCode}
                    disabled={!createdHouseholdId || busy}
                    title="Generate a brand new join code"
                  >
                    {busy ? "Working..." : "Regenerate join code (new)"}
                  </button>

                  {createdHouseholdId && (
                    <button
                      type="button"
                      className="md:col-span-2 px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-sm"
                      onClick={() => onDone?.(createdHouseholdId)}
                    >
                      Continue
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <input
              className="w-full border rounded px-3 py-2"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="Join code"
            />

            <button
              type="button"
              disabled={busy}
              onClick={handleJoin}
              className="w-full bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 disabled:opacity-60"
            >
              {busy ? "Joining..." : "Join Household"}
            </button>
          </div>
        )}

        {info && <p className="text-sm text-green-700 mt-3">{info}</p>}
        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      </div>
    </div>
  );
}
