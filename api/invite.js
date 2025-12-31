import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // Always respond JSON (prevents frontend JSON-parse crashes on HTML)
  res.setHeader("Content-Type", "application/json");

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    console.log("[invite] env present:", {
      hasSUPABASE_URL: !!SUPABASE_URL,
      hasSERVICE_ROLE: !!SERVICE_ROLE,
    });

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({
        error: "Server misconfigured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
        details: {
          hasSUPABASE_URL: !!SUPABASE_URL,
          hasSERVICE_ROLE: !!SERVICE_ROLE,
        },
      });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // --- Auth header ---
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1];

    if (!token) {
      return res.status(401).json({
        error: "Missing Authorization header (expected: Bearer <token>)",
      });
    }

    // --- Body parsing (Vercel can provide string body) ---
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { email, role = "member", householdId } = body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // If you require householdId (recommended for multi-household), enforce it.
    if (!householdId) {
      return res.status(400).json({ error: "householdId is required" });
    }

    // --- Validate caller from token ---
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({
        error: "Invalid session token",
        details: userErr?.message,
      });
    }
    const callerId = userData.user.id;

    // --- Confirm caller is owner of household ---
    const { data: ownerRow, error: ownerErr } = await supabaseAdmin
      .from("household_members")
      .select("role")
      .eq("household_id", householdId)
      .eq("user_id", callerId)
      .maybeSingle();

    if (ownerErr) {
      return res.status(500).json({
        error: "Owner lookup failed",
        details: ownerErr.message,
      });
    }

    if (!ownerRow || ownerRow.role !== "owner") {
      return res.status(403).json({ error: "Only household owners can invite" });
    }
	// Send password reset
	await supabase.auth.resetPasswordForEmail(email, {
  	redirectTo: `${window.location.origin}/accept-invite`,
	});

    // --- Invite via Supabase Admin ---
    const redirectTo = `${process.env.APP_URL}/accept-invite`;
    const { data: inviteData, error: inviteErr } =
      await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo });

    if (inviteErr) {
      return res.status(400).json({
        error: "Invite failed",
        details: inviteErr.message,
      });
    }

    const invitedUserId = inviteData?.user?.id;
    if (!invitedUserId) {
      return res.status(500).json({
        error: "Invite succeeded but no user id returned",
      });
    }

    // --- Pre-add to household_members (upsert is safest) ---
    const { error: insertErr } = await supabaseAdmin
      .from("household_members")
      .upsert(
        {
          household_id: householdId,
          user_id: invitedUserId,
          role,
        },
        { onConflict: "household_id,user_id" }
      );

    if (insertErr) {
      return res.status(500).json({
        error: "Failed to add invited user to household",
        details: insertErr.message,
      });
    }

    return res.status(200).json({
      ok: true,
      invitedUserId,
      email,
      householdId,
      role,
    });
  } catch (e) {
    console.error("[invite] unhandled error:", e);
    return res.status(500).json({
      error: "Unhandled server error",
      details: e?.message || String(e),
    });
  }
}
