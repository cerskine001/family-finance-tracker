import { useState } from "react";

export default function InviteMember({ session, householdId }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

const invite = async (e) => {
  e?.preventDefault?.();
  e?.stopPropagation?.();

  console.log("[invite] clicked", { email, role, householdId });

  setMsg(null);
  setBusy(true);

  try {
    const token = session?.access_token;
    if (!token) throw new Error("No access token found. Please sign in again.");
    if (!householdId) throw new Error("No household selected. Please refresh or re-login.");

    const r = await fetch("/api/invite", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email, role, householdId }),
    });

    const text = await r.text();
    if (!r.ok) throw new Error(text || `Invite failed (${r.status})`);

    setMsg("Invite sent ✅");
  } catch (err) {
    console.error("[invite] failed", err);
    setMsg(err?.message || "Invite failed");
  } finally {
    setBusy(false);
  }
};


  return (
    <div className="border rounded-lg p-4 bg-indigo-50 space-y-2">
      <div className="font-semibold text-gray-800">Invite household member</div>

      <div className="flex flex-col md:flex-row gap-2">
        <input
          className="flex-1 border rounded px-3 py-2"
          placeholder="wife@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <select
          className="border rounded px-3 py-2"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="member">Member (full access)</option>
          <option value="owner">Owner (admin)</option>
        </select>
	<div style={{ fontSize: 12, opacity: 0.8 }}>
  	 debug: busy={String(busy)} email={String(!!email)} householdId={String(!!householdId)} 	token={String(!!session?.access_token)}
	</div>

        <button
  	 type="button"
  	 disabled={busy || !email || !householdId}
  	 onClick={invite}
  	className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 disabled:opacity-60"
	>
  	 {busy ? "Sending..." : "Send invite"}
	</button>
      </div>

      {msg && <div className="text-sm text-gray-700">{msg}</div>}
    </div>
  );
}
