// Noonan Warehouse Inventory: server logic.
// Runs as a Vercel serverless function (api/[route].js) and in the local dev server (dev-server.js).
import pg from "pg";
import crypto from "node:crypto";

const LOCATIONS = ["Livonia", "Brighton"];
const ACTIONS = ["take", "return", "receive"];
const TOKEN_DAYS = 365;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

/* ---------------- database ---------------- */
const connStr = process.env.DATABASE_URL || process.env.POSTGRES_URL;
let pool;
function getPool() {
  if (!connStr) throw httpError(500, "The database isn't connected yet. Follow step 3 of the setup guide.");
  if (!pool) {
    const local = /localhost|127\.0\.0\.1|\/tmp/.test(connStr);
    pool = new pg.Pool({ connectionString: connStr, max: 3, ssl: local ? false : { rejectUnauthorized: false } });
  }
  return pool;
}
const q = (text, params) => getPool().query(text, params);

let migrated;
function migrate() {
  if (!migrated) {
    migrated = q(`
      create table if not exists crew (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        name_key text not null unique,
        pin_hash text not null,
        role text not null default 'crew',
        active boolean not null default true,
        failed int not null default 0,
        locked_until timestamptz,
        token_version int not null default 1,
        created_at timestamptz not null default now()
      );
      create table if not exists items (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        unit text not null default 'ea',
        category text not null default '',
        location text not null default 'Livonia',
        qty numeric not null default 0,
        min numeric not null default 0,
        is_new boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists moves (
        id uuid primary key default gen_random_uuid(),
        at timestamptz not null default now(),
        crew_id uuid references crew(id),
        action text not null,
        job text not null default '',
        method text not null default 'manual',
        location text not null default '',
        lines jsonb not null,
        voided boolean not null default false,
        voided_by uuid,
        voided_at timestamptz
      );
      create index if not exists moves_at_idx on moves (at desc);
    `).catch(e => { migrated = null; throw e; });
  }
  return migrated;
}

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* ---------------- helpers ---------------- */
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const str = (v, max = 120) => String(v ?? "").trim().slice(0, max);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const nameKey = n => str(n, 60).toLowerCase().replace(/\s+/g, " ");
const loc = v => (LOCATIONS.includes(v) ? v : "Livonia");

function secret() {
  return process.env.APP_SECRET || crypto.createHash("sha256").update("noonan-inv:" + (connStr || "")).digest("hex");
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return body + "." + mac;
}
function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const good = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(pin, salt, 32).toString("hex");
  return salt + ":" + h;
}
function checkPin(pin, stored) {
  const [salt, h] = String(stored).split(":");
  if (!salt || !h) return false;
  const got = crypto.scryptSync(pin, salt, 32);
  const want = Buffer.from(h, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function validPin(pin) {
  if (!/^\d{4,6}$/.test(String(pin || ""))) throw httpError(400, "PIN must be 4 to 6 digits.");
  return String(pin);
}
function tokenFor(c) {
  return sign({ uid: c.id, v: c.token_version, exp: Date.now() + TOKEN_DAYS * 864e5 });
}
const publicUser = c => ({ id: c.id, name: c.name, role: c.role });

async function auth(req, needAdmin = false) {
  const h = req.headers["authorization"] || "";
  const p = verify(h.replace(/^Bearer\s+/i, ""));
  if (!p) throw httpError(401, "Please sign in.");
  const { rows } = await q("select * from crew where id=$1", [p.uid]);
  const c = rows[0];
  if (!c || !c.active || c.token_version !== p.v) throw httpError(401, "Please sign in again.");
  if (needAdmin && c.role !== "admin") throw httpError(403, "Only managers can do that.");
  return c;
}

const itemRow = r => ({ id: r.id, name: r.name, unit: r.unit, category: r.category, location: r.location, qty: Number(r.qty), min: Number(r.min), isNew: r.is_new });
const moveRow = r => ({ id: r.id, at: new Date(r.at).getTime(), by: r.crew_id, action: r.action, job: r.job, method: r.method, location: r.location, lines: r.lines, voided: r.voided });

/* ---------------- Claude matching ---------------- */
function buildPrompt({ action, text, isPhoto, catalog }) {
  const verb = { take: "taking out of", return: "bringing back to", receive: "adding to" }[action] || "taking out of";
  const list = catalog.length
    ? catalog.map(it => `${it.id} | ${it.name} | ${it.unit}${it.category ? " | " + it.category : ""}`).join("\n")
    : "(The stock list is empty. Name each item clearly.)";
  return `You help a residential electrical contractor (Noonan Electric, Michigan) log warehouse inventory. A crew member is ${verb} the warehouse.
${isPhoto ? "Look at the attached photo(s) of the material." + (text ? `\nThey also said: "${text}"` : "") : `Here is what they said (it may be voice dictation, so expect odd spelling):\n"${text}"`}

Match everything to this stock list (id | name | unit | category):
${list}

Rules:
- Use the stock list's id and unit whenever an item reasonably matches. Know trade shorthand: "12-2" or "12/2" is 12/2 NM-B (Romex), "20 amp breaker" is a 20A single-pole breaker, "MC" is MC cable, "EMT" is conduit, "Gen" often means Generac, plus whips, j-boxes, wire nuts and so on.
- Convert quantities to the stock list's unit (if the unit is "ft" and they took a 250 ft roll, qty is 250; if the unit is "box", count boxes).
- ${isPhoto ? "Count carefully. Use printed counts on boxes and reels when visible." : "'A couple' means 2, 'a few' means 3."}
- If something is not on the list, set itemId to null and give a short, specific shop-style name and a sensible unit.
- confidence: "high" if sure of item and count, "medium" if fairly sure, "low" if guessing.
- note: one short sentence if something needs a human check, else "".

Reply with ONLY this JSON, no other text:
{"lines":[{"itemId":"id or null","name":"item name","qty":1,"unit":"ea","confidence":"high"}],"note":""}`;
}

async function askClaude(prompt, images) {
  if (process.env.MOCK_CLAUDE) {
    return JSON.stringify({ lines: [{ itemId: null, name: "Test item from mock", qty: 2, unit: "ea", confidence: "medium" }], note: "Mock reply" });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw httpError(500, "Photo and voice matching isn't set up yet. Add the Anthropic key (setup guide step 4).");
  const content = [];
  for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } });
  content.push({ type: "text", text: prompt });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 1500, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("Anthropic error", r.status, t.slice(0, 500));
    if (r.status === 401) throw httpError(502, "The Anthropic key isn't valid. Check it in Vercel settings.");
    if (r.status === 429) throw httpError(429, "Too many requests. Wait a minute and try again.");
    if (r.status === 400 && /credit|billing/i.test(t)) throw httpError(502, "The Anthropic account is out of credit. Add credit at console.anthropic.com.");
    throw httpError(502, "Claude couldn't read that. Try again or add lines by hand.");
  }
  const data = await r.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

function parseJSON(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < 0) throw httpError(502, "Couldn't pick out any items. Try again or add by hand.");
  return JSON.parse(text.slice(s, e + 1));
}

/* ---------------- routes ---------------- */
const routes = {
  // Who can sign in (names only), and whether first-time setup is needed.
  async names() {
    const { rows } = await q("select id, name from crew where active order by name");
    const { rows: [{ n }] } = await q("select count(*)::int n from crew");
    return { crew: rows, needsSetup: n === 0 };
  },

  // First run only: create the first manager account.
  async setup(req, b) {
    const name = str(b.name, 60);
    if (!name) throw httpError(400, "Enter your name.");
    const pin = validPin(b.pin);
    return tx(async c => {
      await c.query("lock table crew in exclusive mode");
      const { rows: [{ n }] } = await c.query("select count(*)::int n from crew");
      if (n > 0) throw httpError(409, "Setup is already done. Sign in instead.");
      const { rows } = await c.query("insert into crew(name,name_key,pin_hash,role) values($1,$2,$3,'admin') returning *", [name, nameKey(name), hashPin(pin)]);
      return { token: tokenFor(rows[0]), me: publicUser(rows[0]) };
    });
  },

  async login(req, b) {
    const pin = String(b.pin || "");
    const { rows } = await q("select * from crew where id=$1 and active", [str(b.id, 60)]);
    const c = rows[0];
    if (!c) throw httpError(401, "Pick your name from the list.");
    if (c.locked_until && new Date(c.locked_until) > new Date()) throw httpError(429, `Too many wrong PINs. Try again in ${LOCK_MINUTES} minutes or ask a manager to reset it.`);
    if (!checkPin(pin, c.pin_hash)) {
      const fails = c.failed + 1;
      await q("update crew set failed=$2, locked_until=$3 where id=$1", [c.id, fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 6e4) : null]);
      throw httpError(401, fails >= MAX_FAILS ? `Too many wrong PINs. Locked for ${LOCK_MINUTES} minutes.` : "Wrong PIN. Try again.");
    }
    await q("update crew set failed=0, locked_until=null where id=$1", [c.id]);
    return { token: tokenFor(c), me: publicUser(c) };
  },

  async state(req) {
    const me = await auth(req);
    const [items, moves, crew] = await Promise.all([
      q("select * from items order by name"),
      q("select * from moves order by at desc limit 300"),
      q("select id, name from crew"),
    ]);
    return { me: publicUser(me), items: items.rows.map(itemRow), moves: moves.rows.map(moveRow), crew: crew.rows };
  },

  async match(req, b) {
    const me = await auth(req);
    const text = str(b.text, 1500);
    const images = (Array.isArray(b.images) ? b.images : []).slice(0, 4).map(s => String(s).replace(/^data:image\/\w+;base64,/, ""));
    if (!text && !images.length) throw httpError(400, "Take a photo or say what you're taking first.");
    const where = LOCATIONS.includes(b.location) ? b.location : null;
    const { rows } = await q("select id,name,unit,category from items" + (where ? " where location=$1" : "") + " order by name limit 600", where ? [where] : []);
    const out = parseJSON(await askClaude(buildPrompt({ action: b.action, text, isPhoto: images.length > 0, catalog: rows }), images));
    const ids = new Map(rows.map(r => [r.id, r]));
    const lines = (out.lines || []).filter(l => l && (l.name || l.itemId)).map(l => {
      const it = l.itemId && ids.get(String(l.itemId));
      return {
        itemId: it ? it.id : null,
        name: it ? it.name : str(l.name, 80),
        qty: Math.max(0, num(l.qty) || 1),
        unit: it ? it.unit : str(l.unit || "ea", 12),
        confidence: ["high", "medium", "low"].includes(l.confidence) ? l.confidence : "medium",
      };
    });
    void me;
    return { lines, note: str(out.note, 200) };
  },

  async log(req, b) {
    const me = await auth(req);
    const action = ACTIONS.includes(b.action) ? b.action : null;
    if (!action) throw httpError(400, "Pick taking out, bringing back or restocking.");
    const raw = (Array.isArray(b.lines) ? b.lines : []).slice(0, 60).filter(l => num(l.qty) > 0);
    if (!raw.length) throw httpError(400, "Add at least one item with a quantity.");
    const location = loc(b.location);
    return tx(async c => {
      const lines = [];
      for (const l of raw) {
        const qty = num(l.qty);
        const delta = action === "take" ? -qty : qty;
        let row;
        if (l.itemId) {
          ({ rows: [row] } = await c.query("update items set qty = qty + $2, updated_at=now() where id=$1 returning *", [str(l.itemId, 60), delta]));
        }
        if (!row) {
          const name = str(l.name, 80);
          if (!name) throw httpError(400, "Give each new item a name.");
          ({ rows: [row] } = await c.query("insert into items(name,unit,location,qty,is_new) values($1,$2,$3,$4,true) returning *", [name, str(l.unit || "ea", 12), location, delta]));
        }
        lines.push({ itemId: row.id, name: row.name, qty, unit: row.unit });
      }
      const { rows: [m] } = await c.query(
        "insert into moves(crew_id,action,job,method,location,lines) values($1,$2,$3,$4,$5,$6) returning *",
        [me.id, action, str(b.job, 120), ["photo", "voice", "manual"].includes(b.method) ? b.method : "manual", location, JSON.stringify(lines)]);
      return { move: moveRow(m) };
    });
  },

  async undo(req, b) {
    const me = await auth(req);
    return tx(async c => {
      const { rows: [m] } = await c.query("select * from moves where id=$1 for update", [str(b.id, 60)]);
      if (!m) throw httpError(404, "That entry is gone.");
      if (m.voided) throw httpError(409, "Already undone.");
      if (m.action === "count") throw httpError(400, "Recounts can't be undone. Recount again instead.");
      if (m.crew_id !== me.id && me.role !== "admin") throw httpError(403, "Only the person who logged it or a manager can undo it.");
      for (const l of m.lines) {
        const back = m.action === "take" ? num(l.qty) : -num(l.qty);
        await c.query("update items set qty = qty + $2, updated_at=now() where id=$1", [l.itemId, back]);
      }
      await c.query("update moves set voided=true, voided_by=$2, voided_at=now() where id=$1", [m.id, me.id]);
      return { ok: true };
    });
  },

  // Add or edit one item. A changed on-hand number is logged as a recount.
  async item(req, b) {
    const me = await auth(req);
    const name = str(b.name, 80);
    if (!name) throw httpError(400, "Enter a name.");
    const f = [name, str(b.unit || "ea", 12), str(b.category, 40), loc(b.location), Math.max(0, num(b.min))];
    const qty = num(b.qty);
    return tx(async c => {
      if (!b.id) {
        const { rows: [r] } = await c.query("insert into items(name,unit,category,location,min,qty) values($1,$2,$3,$4,$5,$6) returning *", [...f, qty]);
        return { item: itemRow(r) };
      }
      const { rows: [old] } = await c.query("select * from items where id=$1 for update", [str(b.id, 60)]);
      if (!old) throw httpError(404, "That item was deleted.");
      const { rows: [r] } = await c.query("update items set name=$2,unit=$3,category=$4,location=$5,min=$6,qty=$7,is_new=false,updated_at=now() where id=$1 returning *", [old.id, ...f, qty]);
      if (Number(old.qty) !== qty) {
        await c.query("insert into moves(crew_id,action,method,location,lines) values($1,'count','manual',$2,$3)",
          [me.id, r.location, JSON.stringify([{ itemId: r.id, name: r.name, qty, from: Number(old.qty), unit: r.unit }])]);
      }
      return { item: itemRow(r) };
    });
  },

  async item_delete(req, b) {
    await auth(req, true);
    await q("delete from items where id=$1", [str(b.id, 60)]);
    return { ok: true };
  },

  async bulk(req, b) {
    await auth(req, true);
    const location = loc(b.location);
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 1000);
    const { rows: existing } = await q("select lower(name) n from items where location=$1", [location]);
    const have = new Set(existing.map(r => r.n));
    let added = 0, skipped = 0;
    await tx(async c => {
      for (const r of rows) {
        const name = str(r.name, 80);
        if (!name) continue;
        if (have.has(name.toLowerCase())) { skipped++; continue; }
        have.add(name.toLowerCase());
        await c.query("insert into items(name,qty,unit,min,location) values($1,$2,$3,$4,$5)", [name, num(r.qty), str(r.unit || "ea", 12), Math.max(0, num(r.min)), location]);
        added++;
      }
    });
    return { added, skipped };
  },

  async crew(req) {
    await auth(req, true);
    const { rows } = await q("select id,name,role,active,(locked_until > now()) locked from crew order by active desc, name");
    return { crew: rows };
  },

  // Managers add people, reset PINs, change roles, or turn access off.
  async crew_save(req, b) {
    const me = await auth(req, true);
    const name = str(b.name, 60);
    if (!name) throw httpError(400, "Enter a name.");
    const role = b.role === "admin" ? "admin" : "crew";
    const active = b.active !== false;
    try {
      if (!b.id) {
        const pin = validPin(b.pin);
        const { rows: [r] } = await q("insert into crew(name,name_key,pin_hash,role) values($1,$2,$3,$4) returning id", [name, nameKey(name), hashPin(pin), role]);
        return { id: r.id };
      }
      if (b.id === me.id && (role !== "admin" || !active)) throw httpError(400, "You can't remove your own manager access.");
      const pinSql = b.pin ? ", pin_hash=$6, failed=0, locked_until=null, token_version=token_version+1" : "";
      const params = [b.id, name, nameKey(name), role, active];
      if (b.pin) params.push(hashPin(validPin(b.pin)));
      await q(`update crew set name=$2, name_key=$3, role=$4, active=$5${pinSql}${!active ? ", token_version=token_version+1" : ""} where id=$1`, params);
      return { id: b.id };
    } catch (e) {
      if (e.code === "23505") throw httpError(409, "Someone already has that name. Add a last initial.");
      throw e;
    }
  },

  async pin_change(req, b) {
    const me = await auth(req);
    const pin = validPin(b.pin);
    const { rows: [r] } = await q("update crew set pin_hash=$2, token_version=token_version+1 where id=$1 returning *", [me.id, hashPin(pin)]);
    return { token: tokenFor(r) };
  },
};

const GET_ROUTES = new Set(["names", "state", "crew"]);

/* ---------------- entry point ---------------- */
export async function handle(req, res, route) {
  const send = (status, obj) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(obj));
  };
  try {
    const fn = Object.prototype.hasOwnProperty.call(routes, route) ? routes[route] : null;
    if (!fn) return send(404, { error: "Not found" });
    const wantGet = GET_ROUTES.has(route);
    if ((req.method === "GET") !== wantGet) return send(405, { error: "Wrong method" });
    let body = {};
    if (!wantGet) {
      if (req.body && typeof req.body === "object") body = req.body;
      else if (typeof req.body === "string") body = JSON.parse(req.body || "{}");
      else {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        const raw = Buffer.concat(chunks).toString();
        body = raw ? JSON.parse(raw) : {};
      }
    }
    await migrate();
    send(200, await fn(req, body));
  } catch (e) {
    if (e.status) return send(e.status, { error: e.message });
    if (e instanceof SyntaxError) return send(400, { error: "Bad request." });
    console.error(e);
    send(500, { error: "Something went wrong on the server. Try again." });
  }
}
