import { useState } from "react";

export default function InviteMember({ session, householdId }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const invite = async () => {
    setMsg(null);
    setBusy(true);

    try {
  	const token = session?.access_token;

  	console.log("[invite] sending", {
    	url: "/api/invite",
    	hasToken: !!token,
    	tokenPrefix: token?.slice(0, 10),
  	});

  	if (!token) {
    	throw new Error("No access token found. Please sign in again.");
  	}

  	const r = await fetch("/api/invite", {
    	method: "POST",
    	headers: {
      	"Content-Type": "application/json",
      	Authorization: `Bearer ${token}`,
    	},
    	body: JSON.stringify({ email, role, householdId, }),
  	});

      // Read body ONCE, then try to parse
      const text = await r.text();
      let data = null;

      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON (could be HTML, plain text, etc.)
        data = null;
      }

      if (!r.ok) {
        const serverMsg =
          (data && (data.error || data.message)) ||
          (text && text.trim()) ||
          `Invite failed (${r.status})`;
        throw new Error(serverMsg);
      }

      setMsg("Invite sent! They’ll receive an email to set password and sign in.");
      setEmail("");
      setRole("member");
    } catch (e) {
      setMsg(e?.message || "Invite failed");
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

        <button
          disabled={busy || !email}
          onClick={invite}
          className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 disabled:opacity-60"
        >
          {busy ? "Inviting..." : "Send invite"}
        </button>
      </div>

      {msg && <div className="text-sm text-gray-700">{msg}</div>}
    </div>
  );
}
