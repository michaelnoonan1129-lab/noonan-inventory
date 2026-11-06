(function () {
"use strict";
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lsGet = k => { try { return localStorage.getItem("nwi_" + k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem("nwi_" + k) : localStorage.setItem("nwi_" + k, v); } catch (e) {} };
const LOCS = ["Livonia", "Brighton"];

let token = lsGet("token");
let me = null, items = [], moves = [], names = {};
let loc = lsGet("loc") || "Both";
let action = "take", draft = [], method = "manual", photos = [], busy = false;

/* ---------- API ---------- */
async function api(route, body) {
  const opts = { method: body === undefined ? "GET" : "POST", headers: {} };
  if (token) opts.headers.authorization = "Bearer " + token;
  if (body !== undefined) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  let r;
  try { r = await fetch("/api/" + route, opts); }
  catch (e) { throw new Error("No connection. Check your signal and try again."); }
  let data = {};
  try { data = await r.json(); } catch (e) {}
  if (r.status === 401 && route !== "login" && route !== "setup") { signOut(true); }
  if (!r.ok) { const err = new Error(data.error || "Something went wrong. Try again."); err.status = r.status; throw err; }
  return data;
}

/* ---------- UI basics ---------- */
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 3200); }
function banner(msg) { const b = $("#statusBanner"); b.hidden = !msg; b.textContent = msg || ""; }
function openModal(html) { $("#sheet").innerHTML = html; $("#modal").hidden = false; const f = $("#sheet").querySelector("input,select,textarea,button"); if (f) f.focus(); }
function closeModal() { $("#modal").hidden = true; $("#sheet").innerHTML = ""; }
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });

function setView(v) {
  $$(".view").forEach(s => s.hidden = s.id !== "view-" + v);
  $$("nav.tabs button[data-view]").forEach(b => { if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  if (location.hash.slice(1) !== v) history.replaceState(null, "", "#" + v);
  $("main").scrollTop = 0;
  if (v === "reports" && token) setTimeout(loadReport, 0);
}
$$("nav.tabs button[data-view]").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
const VIEWS = ["log", "stock", "activity", "reports"];
setView(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "log");

function paintLoc() { $$("#locSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.loc === loc)); }
$$("#locSeg button").forEach(b => b.addEventListener("click", () => { loc = b.dataset.loc; lsSet("loc", loc); paintLoc(); renderAll(); if (!$("#view-reports").hidden) loadReport(); }));
paintLoc();

function paintAction() {
  $$("#actionSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.action === action));
  $("#submitBtn").textContent = { take: "Log it out", return: "Log it back in", receive: "Add to stock" }[action];
}
$$("#actionSeg button").forEach(b => b.addEventListener("click", () => { action = b.dataset.action; paintAction(); }));
paintAction();

/* ---------- helpers ---------- */
const isAdmin = () => me && me.role === "admin";
const locFor = () => loc === "Both" ? "Livonia" : loc;
const inLoc = it => loc === "Both" || it.location === loc;
const visibleItems = () => items.filter(inLoc).sort((a, b) => a.name.localeCompare(b.name));
const itemById = id => items.find(i => i.id === id);
const fmtQty = n => { n = Number(n) || 0; return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""); };
const isLow = it => it.min > 0 && it.qty <= it.min;
const who = id => (me && id === me.id) ? "You" : (names[id] || "Someone");
function when(ts) {
  const d = new Date(ts), now = new Date();
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return "Today " + t;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday " + t;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t;
}

/* ---------- sign in ---------- */
async function showLogin(msg) {
  $("#app").hidden = true; $("#login").hidden = false;
  const card = $("#loginCard");
  card.innerHTML = '<p class="hint">Loading…</p>';
  let data;
  try { data = await api("names"); }
  catch (e) { card.innerHTML = `<h2>Can't connect</h2><p class="hint">${esc(e.message)}</p><button class="btn primary" id="retry">Try again</button>`; $("#retry").onclick = () => showLogin(); return; }
  if (data.needsSetup) return showSetup();
  card.innerHTML = `<h2>Who's logging?</h2>${msg ? `<p class="err">${esc(msg)}</p>` : ""}
    <div class="names">${data.crew.map(c => `<button data-id="${esc(c.id)}">${esc(c.name)}</button>`).join("")}</div>
    <p class="hint">Not on the list? Ask a manager to add you.</p>`;
  card.querySelectorAll(".names button").forEach(b => b.onclick = () => askPin(b.dataset.id, b.textContent));
}

function pinPad(title, onDone, extraHtml = "") {
  const card = $("#loginCard");
  let pin = "";
  card.innerHTML = `<h2>${esc(title)}</h2>${extraHtml}
    <div class="pindots" aria-live="polite">${"<span></span>".repeat(4)}</div>
    <p class="err" id="pinErr"></p>
    <div class="pinpad">${[1,2,3,4,5,6,7,8,9].map(n => `<button data-k="${n}">${n}</button>`).join("")}
      <button data-k="back" aria-label="Delete">⌫</button><button data-k="0">0</button><button data-k="ok" aria-label="Done">OK</button></div>
    <button class="x" id="pinCancel">Back</button>`;
  const paint = () => {
    const dots = card.querySelector(".pindots");
    dots.innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<span class="${i < pin.length ? "on" : ""}"></span>`).join("");
  };
  const submit = async () => {
    if (pin.length < 4) return;
    card.querySelectorAll(".pinpad button").forEach(b => b.disabled = true);
    try { await onDone(pin); }
    catch (e) { pin = ""; paint(); const er = card.querySelector("#pinErr"); if (er) er.textContent = e.message; card.querySelectorAll(".pinpad button").forEach(b => b.disabled = false); }
  };
  card.querySelectorAll(".pinpad button").forEach(b => b.onclick = () => {
    const k = b.dataset.k;
    if (k === "back") pin = pin.slice(0, -1);
    else if (k === "ok") return submit();
    else if (pin.length < 6) pin += k;
    paint();
  });
  $("#pinCancel").onclick = () => showLogin();
  paint();
}

function askPin(id, name) {
  pinPad("Hi " + name + ". Enter your PIN.", async pin => {
    const r = await api("login", { id, pin });
    token = r.token; lsSet("token", token); me = r.me;
    startApp();
  });
}

function showSetup() {
  const card = $("#loginCard");
  card.innerHTML = `<h2>First-time setup</h2>
    <p class="hint">Create the first manager account. You'll add your crew after this.</p>
    <div class="field"><label for="sName">Your name</label><input type="text" id="sName" autocomplete="name" placeholder="Mike Noonan"></div>
    <div class="field"><label for="sPin">Pick a PIN (4 to 6 digits)</label><input type="password" inputmode="numeric" id="sPin" maxlength="6" autocomplete="new-password"></div>
    <p class="err" id="sErr"></p>
    <button class="btn primary" id="sGo">Create account</button>`;
  $("#sGo").onclick = async () => {
    try {
      const r = await api("setup", { name: $("#sName").value, pin: $("#sPin").value });
      token = r.token; lsSet("token", token); me = r.me; startApp();
    } catch (e) { $("#sErr").textContent = e.message; }
  };
}

function signOut(expired) {
  token = null; lsSet("token", null); me = null; items = []; moves = [];
  clearInterval(poll._t);
  showLogin(expired ? "You were signed out. Sign in again." : "");
}

/* ---------- data ---------- */
async function refresh() {
  if (!token) return;
  try {
    const s = await api("state");
    me = s.me; items = s.items; moves = s.moves;
    names = {}; s.crew.forEach(c => names[c.id] = c.name);
    banner("");
    $$(".admin-only").forEach(el => el.hidden = !isAdmin());
    renderAll();
    if (rData) renderReport();
  } catch (e) { if (e.status !== 401) banner(e.message); }
}
function poll() {
  clearInterval(poll._t);
  poll._t = setInterval(() => { if (document.visibilityState === "visible" && !busy) refresh(); }, 20000);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && token) refresh(); });

function startApp() {
  $("#login").hidden = true; $("#app").hidden = false;
  refresh(); poll();
}

/* ---------- rendering ---------- */
function renderAll() { renderStock(); renderActivity(); renderDraft(); }

function renderStock() {
  const all = visibleItems();
  $("#stItems").textContent = all.length;
  $("#stLow").textContent = all.filter(isLow).length;
  const today = new Date().toDateString();
  $("#stToday").textContent = moves.filter(m => !m.voided && m.action === "take" && new Date(m.at).toDateString() === today && (loc === "Both" || m.location === loc)).length;
  const q = $("#search").value.trim().toLowerCase();
  const lowOnly = $("#lowOnly").getAttribute("aria-pressed") === "true";
  const list = all.filter(it => (!q || (it.name + " " + it.category).toLowerCase().includes(q)) && (!lowOnly || isLow(it)));
  if (!items.length) {
    $("#stockList").innerHTML = `<div class="empty">No stock yet. ${isAdmin() ? "Tap <b>Paste a list</b> to load your shelves in one go, or <b>Add item</b> for one at a time." : "Ask a manager to load the stock list."}</div>`;
    return;
  }
  if (!list.length) { $("#stockList").innerHTML = '<div class="empty">Nothing matches.</div>'; return; }
  $("#stockList").innerHTML = list.map(it => `
    <button class="item ${isLow(it) ? "is-low" : ""}" data-id="${esc(it.id)}">
      <span class="nm">${esc(it.name)}${isLow(it) ? '<span class="pill low">Low</span>' : ""}${it.isNew ? '<span class="pill new">New</span>' : ""}</span>
      <span class="q num">${esc(fmtQty(it.qty))}<small>${esc(it.unit || "ea")}</small></span>
      <span class="sub">${esc([it.category, loc === "Both" ? it.location : "", it.min ? ("min " + fmtQty(it.min)) : ""].filter(Boolean).join(" · "))}</span>
    </button>`).join("");
}
$("#search").addEventListener("input", renderStock);
$("#lowOnly").addEventListener("click", e => { const b = e.currentTarget; b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true"); b.classList.toggle("primary"); renderStock(); });
$("#stockList").addEventListener("click", e => { const b = e.target.closest(".item"); if (b) editItem(b.dataset.id); });

const VERB = { take: "took", return: "brought back", receive: "restocked", count: "counted" };
function renderActivity() {
  const q = $("#actSearch").value.trim().toLowerCase();
  const list = moves.filter(m => loc === "Both" || m.location === loc).filter(m => !q || (who(m.by) + " " + m.job + " " + (m.lines || []).map(l => l.name).join(" ")).toLowerCase().includes(q));
  if (!list.length) { $("#actList").innerHTML = '<div class="empty">' + (moves.length ? "Nothing matches." : "Nothing logged yet. Pulls, returns and restocks show up here.") + "</div>"; return; }
  $("#actList").innerHTML = list.map(m => {
    const lines = (m.lines || []).map(l => m.action === "count"
      ? `${esc(l.name)}: ${esc(fmtQty(l.from))} → ${esc(fmtQty(l.qty))} ${esc(l.unit || "")}`
      : `${esc(fmtQty(l.qty))} ${esc(l.unit || "")} ${esc(l.name)}`).join(", ");
    const canUndo = !m.voided && m.action !== "count" && me && (m.by === me.id || isAdmin());
    return `<div class="move ${m.voided ? "voided" : ""}">
      <div class="row"><span class="tag ${esc(m.action)}">${esc(VERB[m.action] || m.action)}</span><span class="who">${esc(who(m.by))}</span>${m.voided ? '<span class="tag">Undone</span>' : ""}</div>
      <div class="what">${lines}</div>
      <div class="row when"><span class="grow">${esc(when(m.at))}${m.job ? " · " + esc(m.job) : ""}${loc === "Both" && m.location ? " · " + esc(m.location) : ""}${m.method && m.method !== "manual" ? " · by " + esc(m.method) : ""}</span>${canUndo ? `<button class="x" data-undo="${esc(m.id)}">Undo</button>` : ""}</div>
    </div>`;
  }).join("");
}
$("#actSearch").addEventListener("input", renderActivity);
$("#actList").addEventListener("click", e => { const b = e.target.closest("[data-undo]"); if (b) undoMove(b.dataset.undo); });

/* ---------- draft ---------- */
function itemOptions(sel) {
  return `<option value="" ${!sel ? "selected" : ""}>New item (not in stock list)</option>` +
    visibleItems().map(it => `<option value="${esc(it.id)}" ${it.id === sel ? "selected" : ""}>${esc(it.name)}${loc === "Both" ? " (" + esc(it.location) + ")" : ""}</option>`).join("");
}
function renderDraft() {
  const card = $("#draftCard");
  if (!draft.length) { card.hidden = true; return; }
  card.hidden = false;
  $("#draftLines").innerHTML = draft.map((l, i) => {
    const it = l.itemId && itemById(l.itemId);
    const cls = !l.itemId ? "new" : (l.confidence || "high");
    return `<div class="draft-line ${cls}" data-i="${i}">
      <div class="field">
        <select data-f="itemId" aria-label="Item">${itemOptions(l.itemId)}</select>
        ${!l.itemId ? `<input type="text" data-f="name" value="${esc(l.name)}" placeholder="Name for the new item" aria-label="New item name" style="margin-top:6px">` : ""}
      </div>
      <div class="qtybox">
        <button data-step="-1" aria-label="Less">−</button>
        <input type="number" inputmode="decimal" min="0" step="any" data-f="qty" value="${esc(l.qty)}" aria-label="Quantity" class="num">
        <button data-step="1" aria-label="More">+</button>
      </div>
      <div class="meta"><span>${esc(it ? (it.unit || "ea") + " · " + fmtQty(it.qty) + " on hand" : (l.unit || "ea") + " · will be added to stock")}${l.confidence === "low" ? " · double-check this one" : ""}</span><button class="x" data-rm="${i}">Remove</button></div>
    </div>`;
  }).join("");
}
$("#draftLines").addEventListener("change", e => {
  const row = e.target.closest(".draft-line"); if (!row) return;
  const l = draft[+row.dataset.i], f = e.target.dataset.f;
  if (f === "itemId") { l.itemId = e.target.value || null; const it = itemById(l.itemId); if (it) { l.name = it.name; l.unit = it.unit; } l.confidence = "high"; renderDraft(); }
  else if (f === "qty") l.qty = Math.max(0, Number(e.target.value) || 0);
  else if (f === "name") l.name = e.target.value.trim();
});
$("#draftLines").addEventListener("click", e => {
  const s = e.target.closest("[data-step]"), r = e.target.closest("[data-rm]");
  if (s) { const row = s.closest(".draft-line"); const l = draft[+row.dataset.i]; l.qty = Math.max(0, (Number(l.qty) || 0) + Number(s.dataset.step)); row.querySelector('[data-f="qty"]').value = l.qty; }
  if (r) { draft.splice(+r.dataset.rm, 1); renderDraft(); }
});
$("#addLineBtn").addEventListener("click", () => { draft.push({ itemId: null, name: "", qty: 1, unit: "ea", confidence: "high" }); renderDraft(); });
$("#clearDraft").addEventListener("click", resetLog);
function resetLog() { draft = []; photos = []; method = "manual"; $("#thumbs").innerHTML = ""; $("#said").value = ""; $("#draftNote").textContent = ""; renderDraft(); }

/* ---------- photo + voice ---------- */
async function shrink(file) {
  let src;
  try { src = await createImageBitmap(file); }
  catch (_) { src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); }); }
  const w = src.width, h = src.height, scale = Math.min(1, 1400 / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8);
}
async function runMatch(text, images) {
  if (busy) return; busy = true;
  $("#working").hidden = false; $("#readBtn").disabled = true;
  try {
    const out = await api("match", { text, images: images || [], action, location: loc === "Both" ? null : loc });
    if (!out.lines.length) { toast("Couldn't pick out any items. Try again or add by hand."); return; }
    draft = draft.concat(out.lines);
    $("#draftNote").textContent = out.note || "Green is a sure match. Yellow and orange need a look.";
    renderDraft();
    $("#draftCard").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { toast(e.message); }
  finally { busy = false; $("#working").hidden = true; $("#readBtn").disabled = false; }
}
$("#photoIn").addEventListener("change", async e => {
  const files = Array.from(e.target.files || []).slice(0, 4); e.target.value = "";
  if (!files.length) return;
  method = "photo";
  let shots;
  try { shots = await Promise.all(files.map(shrink)); }
  catch (err) { toast("Couldn't open that photo. Try taking it again."); return; }
  photos = photos.concat(shots);
  $("#thumbs").innerHTML = photos.map(s => `<img alt="Photo of material" src="${s}">`).join("");
  runMatch($("#said").value.trim().slice(0, 1500), shots);
});
$("#readBtn").addEventListener("click", () => {
  const t = $("#said").value.trim();
  if (!t) { $("#said").focus(); toast("Say or type what you're taking first."); return; }
  if (method !== "photo") method = "voice";
  runMatch(t.slice(0, 1500), null);
});

// Built-in speech to text where the phone supports it; otherwise the keyboard mic still works.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const btn = $("#talkBtn"); btn.hidden = false; $("#saidLabel").textContent = "Or type it (the keyboard mic works too)";
  let rec = null, base = "";
  const stop = () => { if (rec) { try { rec.stop(); } catch (e) {} } };
  btn.addEventListener("click", () => {
    if (rec) return stop();
    try { rec = new SR(); } catch (e) { btn.hidden = true; return; }
    rec.lang = "en-US"; rec.interimResults = true; rec.continuous = true;
    base = $("#said").value.trim(); if (base) base += " ";
    rec.onresult = ev => { let t = ""; for (const r of ev.results) t += r[0].transcript; $("#said").value = base + t; };
    rec.onerror = ev => { if (ev.error === "not-allowed" || ev.error === "service-not-allowed") toast("Allow the microphone for this app in your phone settings, or use the keyboard mic."); };
    rec.onend = () => {
      rec = null; btn.setAttribute("aria-pressed", "false"); $("#talkLabel").textContent = "Tap to talk";
      const t = $("#said").value.trim();
      if (t && t !== base.trim()) { if (method !== "photo") method = "voice"; runMatch(t.slice(0, 1500), null); }
    };
    try { rec.start(); btn.setAttribute("aria-pressed", "true"); $("#talkLabel").textContent = "Listening… tap when done"; }
    catch (e) { rec = null; toast("Couldn't start the mic. Use the keyboard mic instead."); }
  });
}

/* ---------- writes ---------- */
$("#submitBtn").addEventListener("click", async () => {
  const lines = draft.filter(l => (Number(l.qty) || 0) > 0 && (l.itemId || l.name));
  if (!lines.length) { toast("Add at least one item with a quantity."); return; }
  if (lines.some(l => !l.itemId && !l.name)) { toast("Give each new item a name."); return; }
  const btn = $("#submitBtn"); btn.disabled = true;
  try {
    const first = lines.find(l => l.itemId && itemById(l.itemId));
    const where = loc !== "Both" ? loc : (first ? itemById(first.itemId).location : "Livonia");
    await api("log", { action, job: $("#job").value.trim(), method, location: where, lines: lines.map(l => ({ itemId: l.itemId, name: l.name, qty: Number(l.qty), unit: l.unit })) });
    toast({ take: "Logged out.", return: "Logged back in.", receive: "Added to stock." }[action] + " " + lines.length + " line" + (lines.length > 1 ? "s" : ""));
    resetLog();
    refresh();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
});

function undoMove(id) {
  openModal(`<h2>Undo this entry?</h2><p class="hint">This puts the quantities back the way they were and marks the entry as undone.</p>
    <div class="row"><button class="btn primary" id="yesUndo">Undo it</button><button class="btn" id="noUndo">Keep it</button></div>`);
  $("#noUndo").onclick = closeModal;
  $("#yesUndo").onclick = async () => {
    $("#yesUndo").disabled = true;
    try { await api("undo", { id }); closeModal(); toast("Undone."); refresh(); }
    catch (e) { closeModal(); toast(e.message); }
  };
}

/* ---------- items ---------- */
function editItem(id) {
  const it = id ? itemById(id) : null;
  const v = it || { name: "", unit: "ea", category: "", location: locFor(), qty: 0, min: 0 };
  openModal(`<h2>${it ? "Edit item" : "Add item"}</h2>
  <div class="field"><label for="fName">Name</label><input type="text" id="fName" value="${esc(v.name)}" placeholder="e.g. 20A single-pole breaker"></div>
  <div class="grid2">
    <div class="field"><label for="fQty">${it ? "On hand (recount)" : "On hand"}</label><input type="number" inputmode="decimal" step="any" id="fQty" class="num" value="${esc(fmtQty(v.qty))}"></div>
    <div class="field"><label for="fUnit">Unit</label><input type="text" id="fUnit" value="${esc(v.unit || "ea")}" placeholder="ea, ft, box"></div>
    <div class="field"><label for="fMin">Reorder at</label><input type="number" inputmode="decimal" step="any" id="fMin" class="num" value="${esc(fmtQty(v.min))}"></div>
    <div class="field"><label for="fLoc">Warehouse</label><select id="fLoc">${LOCS.map(l => `<option ${l === v.location ? "selected" : ""}>${l}</option>`).join("")}</select></div>
  </div>
  <div class="field"><label for="fCat">Category</label><input type="text" id="fCat" value="${esc(v.category || "")}" placeholder="Breakers, Wire, Generac, EV, Boxes…"></div>
  <div class="row"><button class="btn primary" id="fSave">Save</button><button class="btn" id="fCancel">Cancel</button>${it && isAdmin() ? '<span class="grow"></span><button class="btn danger" id="fDel">Delete</button>' : ""}</div>`);
  $("#fCancel").onclick = closeModal;
  if ($("#fDel")) $("#fDel").onclick = async () => {
    const b = $("#fDel");
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to delete"; return; }
    try { await api("item_delete", { id }); closeModal(); toast("Deleted."); refresh(); } catch (e) { toast(e.message); }
  };
  $("#fSave").onclick = async () => {
    const name = $("#fName").value.trim(); if (!name) { $("#fName").focus(); return; }
    $("#fSave").disabled = true;
    try {
      await api("item", { id: id || null, name, unit: $("#fUnit").value.trim() || "ea", category: $("#fCat").value.trim(), location: $("#fLoc").value, min: Number($("#fMin").value) || 0, qty: Number($("#fQty").value) || 0 });
      closeModal(); toast("Saved."); refresh();
    } catch (e) { $("#fSave").disabled = false; toast(e.message); }
  };
}
$("#newItemBtn").addEventListener("click", () => editItem(null));

$("#bulkBtn").addEventListener("click", () => {
  openModal(`<h2>Paste a list</h2>
  <p class="hint">One item per line: name, quantity, unit, reorder-at. Only the name is required. Copy straight from a spreadsheet or type it.</p>
  <textarea id="bulkTxt" style="min-height:180px" placeholder="20A single-pole breaker, 48, ea, 12
12/2 NM-B Romex, 1000, ft, 250
Generac 24kW Guardian, 3, ea, 1
200A main panel, 4, ea, 2"></textarea>
  <div class="field"><label for="bulkLoc">Warehouse</label><select id="bulkLoc">${LOCS.map(l => `<option ${l === locFor() ? "selected" : ""}>${l}</option>`).join("")}</select></div>
  <div class="row"><button class="btn primary" id="bulkGo">Add items</button><button class="btn" id="bulkCancel">Cancel</button></div>`);
  $("#bulkCancel").onclick = closeModal;
  $("#bulkGo").onclick = async () => {
    const rows = $("#bulkTxt").value.split(/\r?\n/).map(r => r.split(/\t|,/).map(s => s.trim())).filter(r => r[0])
      .map(r => ({ name: r[0], qty: Number(r[1]) || 0, unit: r[2] || "ea", min: Number(r[3]) || 0 }));
    if (!rows.length) return;
    $("#bulkGo").disabled = true;
    try {
      const r = await api("bulk", { location: $("#bulkLoc").value, rows });
      closeModal(); toast(`Added ${r.added} item${r.added === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} already listed` : ""}.`); refresh();
    } catch (e) { $("#bulkGo").disabled = false; toast(e.message); }
  };
});

/* ---------- Me menu: PIN, crew, sign out ---------- */
$("#menuBtn").addEventListener("click", () => {
  if (!me) return;
  openModal(`<h2>${esc(me.name)}</h2><p class="hint">${isAdmin() ? "Manager" : "Crew"}</p>
    <div class="wrap" style="gap:8px">
      ${isAdmin() ? '<button class="btn" id="mCrew">Manage crew and PINs</button>' : ""}
      <button class="btn" id="mPin">Change my PIN</button>
      <button class="btn danger" id="mOut">Sign out</button>
      <button class="btn" id="mClose">Close</button>
    </div>`);
  $("#mClose").onclick = closeModal;
  $("#mOut").onclick = () => { closeModal(); signOut(false); };
  $("#mPin").onclick = () => {
    openModal(`<h2>Change my PIN</h2>
      <div class="field"><label for="nPin">New PIN (4 to 6 digits)</label><input type="password" inputmode="numeric" maxlength="6" id="nPin" autocomplete="new-password"></div>
      <div class="row"><button class="btn primary" id="nGo">Save</button><button class="btn" id="nCancel">Cancel</button></div>`);
    $("#nCancel").onclick = closeModal;
    $("#nGo").onclick = async () => {
      try { const r = await api("pin_change", { pin: $("#nPin").value }); token = r.token; lsSet("token", token); closeModal(); toast("PIN changed."); }
      catch (e) { toast(e.message); }
    };
  };
  if ($("#mCrew")) $("#mCrew").onclick = crewManager;
});

async function crewManager() {
  let list;
  try { list = (await api("crew")).crew; } catch (e) { toast(e.message); return; }
  openModal(`<h2>Crew</h2><p class="hint">Managers can paste lists, delete items, undo anyone's entry and manage the crew.</p>
    <div class="list">${list.map(c => `<div class="crew-row"><span class="grow"><b>${esc(c.name)}</b><br><span class="hint">${c.role === "admin" ? "Manager" : "Crew"}${c.active ? "" : " · access off"}${c.locked ? " · locked out" : ""}</span></span><button class="btn sm" data-edit="${esc(c.id)}">Edit</button></div>`).join("")}</div>
    <div class="row"><button class="btn primary" id="cAdd">+ Add person</button><button class="btn" id="cClose">Done</button></div>`);
  $("#cClose").onclick = closeModal;
  $("#cAdd").onclick = () => crewForm(null);
  $$("[data-edit]").forEach(b => b.onclick = () => crewForm(list.find(c => c.id === b.dataset.edit)));
}
function crewForm(c) {
  openModal(`<h2>${c ? "Edit " + esc(c.name) : "Add person"}</h2>
    <div class="field"><label for="cName">Name as it shows on the sign-in screen</label><input type="text" id="cName" value="${esc(c ? c.name : "")}" placeholder="Matt J."></div>
    <div class="field"><label for="cPin">${c ? "New PIN (leave blank to keep)" : "PIN (4 to 6 digits)"}</label><input type="password" inputmode="numeric" maxlength="6" id="cPin" autocomplete="new-password"></div>
    <div class="field"><label for="cRole">Access</label><select id="cRole"><option value="crew" ${!c || c.role !== "admin" ? "selected" : ""}>Crew: logs material, adds and edits items</option><option value="admin" ${c && c.role === "admin" ? "selected" : ""}>Manager: everything, plus crew and deletes</option></select></div>
    ${c ? `<label class="row"><input type="checkbox" id="cActive" ${c.active ? "checked" : ""}> Can sign in</label>` : ""}
    <div class="row"><button class="btn primary" id="cSave">Save</button><button class="btn" id="cBack">Back</button></div>`);
  $("#cBack").onclick = crewManager;
  $("#cSave").onclick = async () => {
    try {
      await api("crew_save", { id: c ? c.id : null, name: $("#cName").value, pin: $("#cPin").value || null, role: $("#cRole").value, active: c ? $("#cActive").checked : true });
      toast("Saved."); crewManager(); refresh();
    } catch (e) { toast(e.message); }
  };
}

/* ---------- reports ---------- */
const thisMonth = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
let rMonth = thisMonth(), rData = null, rLoading = 0;
const monthName = (m, short) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1).toLocaleDateString([], short ? { month: "short" } : { month: "long", year: "numeric" }); };
const shiftMonth = (m, n) => { const [y, mo] = m.split("-").map(Number); const d = new Date(y, mo - 1 + n, 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };

async function loadReport() {
  const my = ++rLoading;
  $("#mLabel").textContent = monthName(rMonth);
  $("#mNext").disabled = rMonth >= thisMonth();
  $("#rBody").innerHTML = '<tr><td colspan="5" class="empty">Loading…</td></tr>';
  try {
    const d = await api("report", { month: rMonth, location: loc === "Both" ? null : loc });
    if (my !== rLoading) return;
    rData = d; renderReport();
  } catch (e) { if (my === rLoading) $("#rBody").innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message)}</td></tr>`; }
}
function reportRows() {
  const q = $("#rSearch").value.trim().toLowerCase();
  return (rData ? rData.items : []).filter(r => !q || (r.name || "").toLowerCase().includes(q));
}
function renderReport() {
  if (!rData) return;
  const rows = reportRows();
  $("#rPulls").textContent = rData.people.reduce((a, p) => a + p.pulls, 0);
  $("#rItems").textContent = rData.items.filter(r => r.taken > 0).length;
  $("#rJobs").textContent = rData.jobs.filter(j => j.job !== "(no job)").length;
  $("#rBody").innerHTML = rows.length ? rows.map(r => `<tr data-id="${esc(r.id)}">
      <td>${esc(r.name)}<br><span class="hint">${esc(r.unit || "ea")}${r.pulls ? " · " + r.pulls + " pull" + (r.pulls > 1 ? "s" : "") : ""}</span></td>
      <td>${esc(fmtQty(r.taken))}</td><td>${esc(fmtQty(r.returned))}</td><td><b>${esc(fmtQty(r.used))}</b></td><td>${esc(fmtQty(r.received))}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">${rData.items.length ? "No items match." : "Nothing logged in " + esc(monthName(rMonth)) + "."}</td></tr>`;
  $("#rJobList").innerHTML = rData.jobs.length ? rData.jobs.map(j => `<li><span>${esc(j.job)}</span><span>${j.pulls} pull${j.pulls > 1 ? "s" : ""}</span></li>`).join("") : '<li class="hint">No pulls yet.</li>';
  $("#rPeopleList").innerHTML = rData.people.length ? rData.people.map(p => `<li><span>${esc(who(p.id))}</span><span>${p.pulls} pull${p.pulls > 1 ? "s" : ""}</span></li>`).join("") : '<li class="hint">No pulls yet.</li>';
}
$("#mPrev").addEventListener("click", () => { rMonth = shiftMonth(rMonth, -1); loadReport(); });
$("#mNext").addEventListener("click", () => { if (rMonth < thisMonth()) { rMonth = shiftMonth(rMonth, 1); loadReport(); } });
$("#rSearch").addEventListener("input", renderReport);
$("#rBody").addEventListener("click", e => { const tr = e.target.closest("tr[data-id]"); if (tr) itemHistory(tr.dataset.id); });

async function itemHistory(id) {
  const r = rData && rData.items.find(x => x.id === id);
  const it = itemById(id);
  const name = (it && it.name) || (r && r.name) || "Item", unit = (it && it.unit) || (r && r.unit) || "ea";
  openModal(`<h2>${esc(name)}</h2><p class="hint">Used per month (${esc(unit)}), last 12 months</p><div class="working"><div class="spin"></div><span>Loading…</span></div>`);
  let d;
  try { d = await api("report_item", { itemId: id }); } catch (e) { $("#sheet").innerHTML = `<h2>${esc(name)}</h2><p class="err">${esc(e.message)}</p><button class="btn" id="hClose">Close</button>`; $("#hClose").onclick = closeModal; return; }
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(thisMonth(), i - 11));
  const byM = Object.fromEntries(d.months.map(m => [m.month, m.used]));
  const vals = months.map(m => Math.max(0, byM[m] || 0));
  const max = Math.max(1, ...vals);
  const total = vals.reduce((a, v) => a + v, 0);
  const active = vals.filter(v => v > 0).length;
  $("#sheet").innerHTML = `<h2>${esc(name)}</h2>
    <p class="hint">Used per month (${esc(unit)}), last 12 months</p>
    <div class="stats">
      <div class="stat"><b class="num">${esc(fmtQty(total))}</b><span>12-month total</span></div>
      <div class="stat"><b class="num">${esc(fmtQty(Math.round(total / 12 * 10) / 10))}</b><span>avg per month</span></div>
      <div class="stat"><b class="num">${esc(fmtQty(it ? it.qty : 0))}</b><span>on hand now</span></div>
    </div>
    <div class="bars">${vals.map((v, i) => `<div title="${esc(monthName(months[i]))}: ${esc(fmtQty(v))}"><span class="v">${v ? esc(fmtQty(v)) : ""}</span><span class="b" style="height:${Math.round(v / max * 100)}%"></span></div>`).join("")}</div>
    <div class="barlabels">${months.map(m => `<span>${esc(monthName(m, true))}</span>`).join("")}</div>
    ${active < 3 ? '<p class="hint">Only a little history so far. This fills in as crews keep logging.</p>' : ""}
    <h2 style="font-size:18px">Top jobs for this item</h2>
    <ul class="minilist">${d.jobs.length ? d.jobs.map(j => `<li><span>${esc(j.job)}</span><span>${esc(fmtQty(j.qty))} ${esc(unit)}</span></li>`).join("") : '<li class="hint">None yet.</li>'}</ul>
    <button class="btn" id="hClose">Close</button>`;
  $("#hClose").onclick = closeModal;
}

$("#rCsv").addEventListener("click", () => {
  if (!rData) return;
  const cell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [["Item", "Unit", "Out", "Back", "Used", "Restocked", "Pulls"].join(",")]
    .concat(reportRows().map(r => [r.name, r.unit, r.taken, r.returned, r.used, r.received, r.pulls].map(cell).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `noonan-inventory-${rMonth}${loc === "Both" ? "" : "-" + loc.toLowerCase()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

/* ---------- go ---------- */
if (token) startApp(); else showLogin();
})();
