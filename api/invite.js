import { createClient } from "@supabase/supabase-js";
const supabaseAdmin = createClient(...)
// outside export default

export default async function handler(req, res) {
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
      hasAPP_URL: !!process.env.APP_URL,
    });

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({
        error:
          "Server misconfigured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      });
    }
    if (!process.env.APP_URL) {
      return res.status(500).json({
        error: "Server misconfigured: missing APP_URL",
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

    // --- Body parsing ---
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const { email, role = "member", householdId } = body;

    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!householdId)
      return res.status(400).json({ error: "householdId is required" });

    // --- Validate caller ---
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({
        error: "Invalid session token",
        details: userErr?.message,
      });
    }
    const callerId = userData.user.id;

    // --- Confirm caller is owner ---
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

    const normalizedEmail = String(email).trim().toLowerCase();

    // --- Invite or reset ---
    const getBaseUrl = (req) => {
  	if (process.env.APP_URL) return process.env.APP_URL;                // explicit wins
  	if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`; // preview/prod on Vercel
  	const host = req.headers["x-forwarded-host"] || req.headers.host;   // fallback
  	const proto = req.headers["x-forwarded-proto"] || "http";
  	return `${proto}://${host}`;                                        // last resort
	};

	const redirectTo = `${getBaseUrl(req)}/accept-invite`;


    	const { data: inviteData, error: inviteErr } =
      	await supabaseAdmin.auth.admin.inviteUserByEmail(normalizedEmail, { redirectTo });

  if (inviteErr) {
  const msg = (inviteErr.message || "").toLowerCase();
  const looksLikeExists =
    msg.includes("already") ||
    msg.includes("exists") ||
    msg.includes("registered");

  if (!looksLikeExists) {
    return res.status(400).json({
      error: "Invite failed",
      details: inviteErr.message,
    });
  }

  // 1️ Send password reset email
  const { error: resetErr } =
    await supabaseAdmin.auth.resetPasswordForEmail(normalizedEmail, { redirectTo });

  if (resetErr) {
    return res.status(400).json({
      error: "User exists but password reset failed",
      details: resetErr.message,
    });
  }

  // 2️ Resolve existing user id
  const { data: usersPage, error: listErr } =
//    await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
let found = null;
for (let page = 1; page <= 10 && !found; page++) {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
  if (error) throw error;
  found = data?.users?.find(u => (u.email || "").toLowerCase() === normalizedEmail);
}
if (!found?.id) { ... }


  if (listErr) {
    return res.status(500).json({
      error: "Could not list users",
      details: listErr.message,
    });
  }

  const matchUser = usersPage?.users?.find(
    (u) => (u.email || "").toLowerCase() === normalizedEmail
  );

  if (!matchUser?.id) {
    return res.status(500).json({
      error: "User exists but could not resolve user id",
    });
  }

  // 3️ ENSURE household membership
  const { error: upsertErr } = await supabaseAdmin
    .from("household_members")
    .upsert(
      {
        household_id: householdId,
        user_id: matchUser.id,
        role,
      },
      { onConflict: "household_id,user_id" }
    );

  if (upsertErr) {
    return res.status(500).json({
      error: "Failed to add existing user to household",
      details: upsertErr.message,
    });
  }

  // 4️ Success
  return res.status(200).json({
    ok: true,
    email,
    householdId,
    role,
    note: "User already exists — reset email sent and membership ensured.",
  });
}


    const invitedUserId = inviteData?.user?.id;
    if (!invitedUserId) {
      return res.status(500).json({
        error: "Invite succeeded but no user id returned",
      });
    }

    const { error: insertErr } = await supabaseAdmin
      .from("household_members")
      .upsert(
        { household_id: householdId, user_id: invitedUserId, role },
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
      email:normalizedEmail,
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
