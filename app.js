import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from "./config.js";
import { CATALOG, CATEGORIES, categoryOf, isAlcoholic, search } from "./products.js";

const $ = (s) => document.querySelector(s);
const state = {
  user: null,
  members: [],
  events: [],
  items: [],
  month: startOfMonth(new Date()),
  selected: toISO(new Date()),
  tab: "calendar",
  editingEvent: null,
  editingItem: null,
};

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  show("setup");
  throw new Error("config.js fehlt");
}

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ---------- Hilfsfunktionen ----------
function show(screen) {
  for (const id of ["login", "setup", "main"]) $("#" + id).classList.toggle("hidden", id !== screen);
}
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fromISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
const fmtMonth = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" });
const fmtDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long" });
const fmtShort = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short" });
const hm = (t) => (t ? t.slice(0, 5) : "");
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
function nameOf(userId) {
  if (userId === state.user?.id) return "Du";
  return state.members.find((m) => m.email.toLowerCase() !== state.user?.email?.toLowerCase())?.display_name ?? "Partner";
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3000);
}
async function notify(title, body, tab) {
  try { await db.functions.invoke("Notify", { body: { title, body, tab } }); } catch { /* offline: egal */ }
}

// ---------- Anmeldung ----------
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  const { error } = await db.auth.signInWithPassword({
    email: $("#login-email").value.trim(),
    password: $("#login-password").value,
  });
  if (error) $("#login-error").textContent = "Anmeldung fehlgeschlagen. E-Mail oder Passwort prüfen.";
});
$("#logout").addEventListener("click", async () => {
  await unsubscribePush();
  await db.auth.signOut();
});

let started = false;
db.auth.onAuthStateChange((_event, session) => {
  state.user = session?.user ?? null;
  if (!state.user) { started = false; show("login"); return; }
  if (!started) { started = true; start(); }
});

async function start() {
  show("main");
  $("#who").textContent = `Angemeldet als ${state.user.email}`;
  const { data: members, error } = await db.from("members").select("*");
  if (error || !members?.length) {
    toast("Dieses Konto ist nicht freigeschaltet.");
    await db.auth.signOut();
    return;
  }
  state.members = members;
  await Promise.all([loadEvents(), loadItems()]);
  subscribeRealtime();
  updatePushStatus();
  const tab = new URLSearchParams(location.search).get("tab");
  if (tab) switchTab(tab);
}

// ---------- Live-Synchronisierung ----------
let channel;
function subscribeRealtime() {
  channel?.unsubscribe();
  channel = db.channel("familie")
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, (p) => {
      applyChange(state.events, p);
      sortEvents();
      renderCalendar();
      if (p.eventType !== "DELETE" && p.new.updated_by !== state.user.id) {
        toast(`${nameOf(p.new.updated_by)}: Termin „${p.new.title}“`);
      }
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "shopping_items" }, (p) => {
      applyChange(state.items, p);
      renderShopping();
      if (p.eventType === "INSERT" && p.new.created_by !== state.user.id) {
        toast(`${nameOf(p.new.created_by)} hat „${p.new.name}“ hinzugefügt`);
      }
    })
    .subscribe((status) => {
      $("#sync-dot").classList.toggle("on", status === "SUBSCRIBED");
      // Nach Verbindungsabbruch alles neu laden, damit nichts verpasst wird
      if (status === "SUBSCRIBED") { loadEvents(); loadItems(); }
    });
}
function applyChange(list, p) {
  const id = p.eventType === "DELETE" ? p.old.id : p.new.id;
  const i = list.findIndex((x) => x.id === id);
  if (p.eventType === "DELETE") { if (i >= 0) list.splice(i, 1); }
  else if (i >= 0) list[i] = p.new;
  else list.push(p.new);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.user) { loadEvents(); loadItems(); }
});

// ---------- Navigation ----------
const TITLES = { calendar: "Kalender", shopping: "Einkauf", settings: "Mehr" };
function switchTab(tab) {
  if (!TITLES[tab]) return;
  state.tab = tab;
  for (const t of Object.keys(TITLES)) $("#tab-" + t).classList.toggle("hidden", t !== tab);
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#page-title").textContent = TITLES[tab];
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.tab) switchTab(e.data.tab); });

// ---------- Kalender ----------
async function loadEvents() {
  const { data } = await db.from("events").select("*");
  if (data) { state.events = data; sortEvents(); renderCalendar(); }
}
function sortEvents() {
  state.events.sort((a, b) => (a.date + (a.start_time ?? "")).localeCompare(b.date + (b.start_time ?? "")));
}
function renderCalendar() {
  const m = state.month;
  $("#month-label").textContent = fmtMonth.format(m);
  const grid = $("#month-grid");
  grid.replaceChildren();
  const offset = (m.getDay() + 6) % 7; // Montag zuerst
  const first = new Date(m.getFullYear(), m.getMonth(), 1 - offset);
  const today = toISO(new Date());
  const countByDay = {};
  for (const e of state.events) countByDay[e.date] = (countByDay[e.date] ?? 0) + 1;
  for (let i = 0; i < 42; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    if (i === 35 && d.getMonth() !== m.getMonth()) break;
    const iso = toISO(d);
    const n = Math.min(countByDay[iso] ?? 0, 3);
    const cls = ["day", d.getMonth() !== m.getMonth() && "other", iso === today && "today", iso === state.selected && "selected"].filter(Boolean).join(" ");
    grid.append(el("button", { class: cls, onclick: () => { state.selected = iso; renderCalendar(); } },
      String(d.getDate()),
      el("span", { class: "dots" }, Array.from({ length: n }, () => el("i")))));
  }

  $("#day-label").textContent = fmtDay.format(fromISO(state.selected));
  const dayEvents = state.events.filter((e) => e.date === state.selected);
  $("#day-events").replaceChildren(...(dayEvents.length
    ? dayEvents.map((e) => eventRow(e, false))
    : [el("li", { class: "empty" }, "Keine Termine. Mit + einen Termin eintragen.")]));

  const upcoming = state.events.filter((e) => e.date >= today).slice(0, 8);
  $("#upcoming-events").replaceChildren(...(upcoming.length
    ? upcoming.map((e) => eventRow(e, true))
    : [el("li", { class: "empty" }, "Nichts geplant.")]));
}
function eventRow(e, withDate) {
  const time = e.start_time ? hm(e.start_time) + (e.end_time ? `–${hm(e.end_time)}` : "") : "ganztags";
  return el("li", {}, el("button", { class: "event", onclick: () => openEvent(e) },
    el("span", { class: "time" }, withDate ? fmtShort.format(fromISO(e.date)) : time),
    el("span", {},
      el("div", { class: "title" }, e.title),
      withDate ? el("div", { class: "meta" }, time) : null,
      e.note ? el("div", { class: "note" }, e.note) : null,
      el("div", { class: "meta" }, `von ${nameOf(e.created_by)}`))));
}
$("#prev-month").addEventListener("click", () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); renderCalendar(); });
$("#next-month").addEventListener("click", () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); renderCalendar(); });
$("#month-label").addEventListener("click", () => {
  state.month = startOfMonth(new Date()); state.selected = toISO(new Date()); renderCalendar();
});

function openEvent(e) {
  state.editingEvent = e;
  $("#event-dialog-title").textContent = e ? "Termin bearbeiten" : "Neuer Termin";
  $("#ev-title").value = e?.title ?? "";
  $("#ev-date").value = e?.date ?? state.selected;
  $("#ev-start").value = hm(e?.start_time);
  $("#ev-end").value = hm(e?.end_time);
  $("#ev-note").value = e?.note ?? "";
  $("#ev-delete").classList.toggle("hidden", !e);
  $("#event-dialog").showModal();
}
$("#add-event").addEventListener("click", () => openEvent(null));
$("#ev-cancel").addEventListener("click", () => $("#event-dialog").close());
$("#event-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const row = {
    title: $("#ev-title").value.trim(),
    date: $("#ev-date").value,
    start_time: $("#ev-start").value || null,
    end_time: $("#ev-end").value || null,
    note: $("#ev-note").value.trim() || null,
  };
  if (!row.title || !row.date) return;
  const editing = state.editingEvent;
  const q = editing ? db.from("events").update(row).eq("id", editing.id) : db.from("events").insert(row);
  const { error } = await q;
  if (error) { toast("Speichern fehlgeschlagen."); return; }
  $("#event-dialog").close();
  state.selected = row.date;
  state.month = startOfMonth(fromISO(row.date));
  await loadEvents();
  const when = fmtShort.format(fromISO(row.date)) + (row.start_time ? `, ${row.start_time}` : "");
  notify(editing ? "Termin geändert" : "Neuer Termin", `${row.title} (${when})`, "calendar");
});
$("#ev-delete").addEventListener("click", async () => {
  const e = state.editingEvent;
  if (!e || !confirm(`Termin „${e.title}“ löschen?`)) return;
  await db.from("events").delete().eq("id", e.id);
  $("#event-dialog").close();
  await loadEvents();
  notify("Termin gelöscht", e.title, "calendar");
});

// ---------- Einkaufsliste ----------
async function loadItems() {
  const { data } = await db.from("shopping_items").select("*");
  if (data) { state.items = data; renderShopping(); }
}
function renderShopping() {
  const open = state.items.filter((i) => !i.checked);
  const done = state.items.filter((i) => i.checked);
  const badge = $("#shop-badge");
  badge.textContent = open.length;
  badge.classList.toggle("hidden", open.length === 0);

  const wrap = $("#shopping-list");
  wrap.replaceChildren();
  if (!state.items.length) {
    wrap.append(el("p", { class: "empty" }, "Die Liste ist leer. Oben etwas eintippen oder im Katalog auswählen."));
    return;
  }
  for (const cat of CATEGORIES) {
    const items = open.filter((i) => i.category === cat).sort((a, b) => a.name.localeCompare(b.name, "de"));
    if (!items.length) continue;
    wrap.append(el("div", { class: "cat-title" }, cat), el("ul", { class: "items" }, items.map(itemRow)));
  }
  const otherCats = open.filter((i) => !CATEGORIES.includes(i.category));
  if (otherCats.length) wrap.append(el("div", { class: "cat-title" }, "Sonstiges"), el("ul", { class: "items" }, otherCats.map(itemRow)));
  if (done.length) {
    wrap.append(el("div", { class: "cat-title" }, `Im Wagen (${done.length})`),
      el("ul", { class: "items" }, done.sort((a, b) => a.name.localeCompare(b.name, "de")).map(itemRow)));
  }
}
function itemRow(i) {
  return el("li", { class: "item" + (i.checked ? " done" : "") },
    el("button", { class: "check", onclick: () => toggleItem(i) },
      el("span", { class: "box" }, i.checked ? "✓" : ""),
      el("span", { class: "name" }, i.name),
      i.quantity ? el("span", { class: "qtyl" }, i.quantity) : null),
    el("button", { class: "edit", "aria-label": "Bearbeiten", onclick: () => openItem(i) }, "⋯"));
}
async function toggleItem(i) {
  i.checked = !i.checked;
  renderShopping();
  const { error } = await db.from("shopping_items").update({ checked: i.checked }).eq("id", i.id);
  if (error) { i.checked = !i.checked; renderShopping(); toast("Keine Verbindung."); }
}
async function addItem(name, quantity, category) {
  name = name.trim();
  if (!name) return false;
  if (isAlcoholic(name)) {
    $("#item-error").textContent = "Alkoholische Produkte sind in dieser Liste nicht erlaubt.";
    return false;
  }
  $("#item-error").textContent = "";
  const existing = state.items.find((i) => !i.checked && i.name.toLowerCase() === name.toLowerCase());
  if (existing) { toast(`„${name}“ steht schon auf der Liste.`); return true; }
  const row = { name, quantity: quantity?.trim() || null, category: category ?? categoryOf(name) };
  const { data, error } = await db.from("shopping_items").insert(row).select().single();
  if (error) { toast("Speichern fehlgeschlagen."); return false; }
  if (!state.items.some((i) => i.id === data.id)) state.items.push(data);
  renderShopping();
  notifyItemAdded(row);
  return true;
}
// Mehrere Artikel kurz hintereinander werden zu einer Benachrichtigung zusammengefasst.
let pendingAdds = [], addTimer;
function notifyItemAdded(row) {
  pendingAdds.push(row.quantity ? `${row.name} (${row.quantity})` : row.name);
  clearTimeout(addTimer);
  addTimer = setTimeout(() => {
    const list = pendingAdds; pendingAdds = [];
    notify("Einkaufsliste", list.length === 1 ? `${list[0]} hinzugefügt` : `${list.length} Artikel hinzugefügt: ${list.join(", ")}`, "shopping");
  }, 4000);
}

const input = $("#item-input");
const sugg = $("#suggestions");
let suggIndex = -1;
function renderSuggestions() {
  const hits = search(input.value);
  suggIndex = -1;
  sugg.replaceChildren(...hits.map((h) => el("li", {}, el("button", {
    type: "button",
    onclick: async () => { await addItem(h.name, $("#qty-input").value, h.cat); resetInput(); },
  }, h.name, el("small", {}, h.cat)))));
  sugg.classList.toggle("hidden", hits.length === 0);
}
function resetInput() {
  input.value = ""; $("#qty-input").value = ""; sugg.classList.add("hidden"); input.focus();
}
input.addEventListener("input", () => { $("#item-error").textContent = ""; renderSuggestions(); });
input.addEventListener("keydown", (e) => {
  const btns = [...sugg.querySelectorAll("button")];
  if (!btns.length || sugg.classList.contains("hidden")) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    suggIndex = (suggIndex + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length;
    btns.forEach((b, i) => b.classList.toggle("focus", i === suggIndex));
  } else if (e.key === "Enter" && suggIndex >= 0) {
    e.preventDefault(); btns[suggIndex].click();
  } else if (e.key === "Escape") sugg.classList.add("hidden");
});
$("#add-item-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await addItem(input.value, $("#qty-input").value)) resetInput();
});
$("#clear-checked").addEventListener("click", async () => {
  const done = state.items.filter((i) => i.checked);
  if (!done.length) { toast("Nichts zum Löschen."); return; }
  if (!confirm(`${done.length} erledigte Artikel löschen?`)) return;
  await db.from("shopping_items").delete().in("id", done.map((i) => i.id));
  await loadItems();
});

$("#it-cat").append(...CATEGORIES.map((c) => el("option", { value: c }, c)));
function openItem(i) {
  state.editingItem = i;
  $("#it-name").value = i.name;
  $("#it-qty").value = i.quantity ?? "";
  $("#it-cat").value = CATEGORIES.includes(i.category) ? i.category : "Sonstiges";
  $("#it-error").textContent = "";
  $("#item-dialog").showModal();
}
$("#it-cancel").addEventListener("click", () => $("#item-dialog").close());
$("#item-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const i = state.editingItem;
  const name = $("#it-name").value.trim();
  if (isAlcoholic(name)) { $("#it-error").textContent = "Alkoholische Produkte sind nicht erlaubt."; return; }
  const row = { name, quantity: $("#it-qty").value.trim() || null, category: $("#it-cat").value };
  const { error } = await db.from("shopping_items").update(row).eq("id", i.id);
  if (error) { toast("Speichern fehlgeschlagen."); return; }
  $("#item-dialog").close();
  await loadItems();
  notify("Einkaufsliste", `${row.name}${row.quantity ? ` (${row.quantity})` : ""} geändert`, "shopping");
});
$("#it-delete").addEventListener("click", async () => {
  const i = state.editingItem;
  await db.from("shopping_items").delete().eq("id", i.id);
  $("#item-dialog").close();
  await loadItems();
});

// Katalog
$("#open-catalog").addEventListener("click", () => {
  const onList = new Set(state.items.filter((i) => !i.checked).map((i) => i.name.toLowerCase()));
  $("#catalog-body").replaceChildren(...Object.entries(CATALOG).map(([cat, items]) =>
    el("details", {}, el("summary", {}, `${cat} (${items.length})`),
      el("div", { class: "chips" }, items.map((name) => {
        const chip = el("button", {
          class: "chip" + (onList.has(name.toLowerCase()) ? " added" : ""),
          onclick: async () => {
            if (chip.classList.contains("added")) return;
            if (await addItem(name, "", cat)) chip.classList.add("added");
          },
        }, name);
        return chip;
      })))));
  $("#catalog-dialog").showModal();
});
$("#catalog-close").addEventListener("click", () => $("#catalog-dialog").close());

// ---------- Push-Benachrichtigungen ----------
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function currentSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function updatePushStatus() {
  const status = $("#push-status");
  const btn = $("#enable-push");
  if (isIOS && !isStandalone) {
    status.textContent = "Auf dem iPhone funktionieren Benachrichtigungen nur, wenn die App über „Zum Home-Bildschirm“ installiert ist und von dort geöffnet wird.";
    btn.classList.add("hidden");
    return;
  }
  if (!("PushManager" in window) || !("Notification" in window)) {
    status.textContent = "Dieser Browser unterstützt keine Benachrichtigungen. (iPhone: iOS 16.4 oder neuer nötig.)";
    btn.classList.add("hidden");
    return;
  }
  if (Notification.permission === "denied") {
    status.textContent = "Benachrichtigungen sind blockiert. Bitte in den Handy-Einstellungen für diese App erlauben.";
    btn.classList.add("hidden");
    return;
  }
  const sub = await currentSubscription();
  if (sub && Notification.permission === "granted") {
    status.textContent = "Eingeschaltet. Du bekommst eine Nachricht, wenn dein Partner etwas einträgt.";
    btn.classList.add("hidden");
    await saveSubscription(sub); // sicherstellen, dass das Gerät gespeichert ist
  } else {
    status.textContent = "Noch aus.";
    btn.classList.remove("hidden");
  }
}
async function saveSubscription(sub) {
  await db.from("push_subscriptions").upsert({ endpoint: sub.endpoint, subscription: sub.toJSON(), user_id: state.user.id });
}
$("#enable-push").addEventListener("click", async () => {
  if (!VAPID_PUBLIC_KEY) { toast("VAPID-Schlüssel fehlt in config.js."); return; }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { updatePushStatus(); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ??
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) });
    await saveSubscription(sub);
    toast("Benachrichtigungen eingeschaltet.");
  } catch (err) {
    console.error(err);
    toast("Einschalten hat nicht geklappt.");
  }
  updatePushStatus();
});
$("#test-push").addEventListener("click", async () => {
  await notify("Test", "Hallo! Benachrichtigungen funktionieren.", "settings");
  toast("Test gesendet.");
});
async function unsubscribePush() {
  const sub = await currentSubscription();
  if (sub) {
    await db.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
}
