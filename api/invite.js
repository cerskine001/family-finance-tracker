// api/invite.js
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing auth token" });

    const { email, role = "member" } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!["member", "owner"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    // 1) Identify caller from JWT
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Invalid session" });

    const callerId = userData.user.id;

    // 2) Confirm caller is an OWNER and get their household_id
    const { data: ownerRow, error: ownerErr } = await supabaseAdmin
      .from("household_members")
      .select("household_id, role")
      .eq("user_id", callerId)
      .eq("role", "owner")
      .maybeSingle();

    if (ownerErr) return res.status(500).json({ error: ownerErr.message });
    if (!ownerRow?.household_id) {
      return res.status(403).json({ error: "Only household owners can invite members" });
    }

    const householdId = ownerRow.household_id;

    // 3) Invite user by email (Supabase sends the email)
    const { data: inviteData, error: inviteErr } =
      await supabaseAdmin.auth.admin.inviteUserByEmail(email);

    if (inviteErr) return res.status(400).json({ error: inviteErr.message });

    const invitedUserId = inviteData?.user?.id;
    if (!invitedUserId) {
      return res.status(500).json({ error: "Invite succeeded but no user id returned" });
    }

    // 4) Pre-add them to the household (so your app membership check passes after first login)
    const { error: memberErr } = await supabaseAdmin
      .from("household_members")
      .insert([{ household_id: householdId, user_id: invitedUserId, role }]);

    if (memberErr) return res.status(400).json({ error: memberErr.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
