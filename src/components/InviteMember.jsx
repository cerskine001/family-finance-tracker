import { useState } from "react";

export default function InviteMember({ session }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const invite = async () => {
  setMsg(null);
  setBusy(true);

  try {
    const r = await fetch("/api/invite", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ email, role }),
    });

    const contentType = r.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await r.json()
      : { error: await r.text() };

    if (!r.ok) {
      throw new Error(payload?.error || `Invite failed (${r.status})`);
    }
     const text = await r.text();
	let j;
	try { j = JSON.parse(text); } catch { j = { error: text }; }

	if (!r.ok) throw new Error(j.error || "Invite failed"); 

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
