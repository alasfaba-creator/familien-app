// Schickt eine Push-Benachrichtigung an alle Geräte des jeweils anderen Partners.
// Wird von der App aufgerufen, nachdem ein Eintrag gespeichert wurde.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:familie@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  // Wer ruft auf? Nur angemeldete Mitglieder dürfen Benachrichtigungen auslösen.
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401, headers: cors });

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: member } = await admin.from("members").select("display_name")
    .ilike("email", user.email ?? "").maybeSingle();
  if (!member) return new Response("forbidden", { status: 403, headers: cors });

  const { title, body, tab } = await req.json();
  const { data: subs } = await admin.from("push_subscriptions").select("endpoint, subscription")
    .neq("user_id", user.id);

  const payload = JSON.stringify({
    title: title ?? "Familien-App",
    body: `${member.display_name}: ${body ?? ""}`,
    tab: tab ?? "",
  });

  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(s.subscription, payload);
      sent++;
    } catch (e) {
      // Abgemeldete Geräte aufräumen
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      }
    }
  }));

  return new Response(JSON.stringify({ sent }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
