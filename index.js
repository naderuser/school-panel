/**
 * لایه‌ی سازگاری Node.js (برای Render.com یا هر هاست Node دیگر)
 * -------------------------------------------------------------
 * این فایل، منطق اصلی پنل (index.js — که همان worker.js/index.js شماست
 * و بدون هیچ تغییری کپی شده) را روی یک سرور Node.js معمولی اجرا می‌کند.
 *
 * کاری که این فایل انجام می‌دهد:
 *  ۱) یک KV شبیه‌سازی‌شده (EXAM_KV) می‌سازد که روی یک فایل JSON روی دیسک
 *     کار می‌کند اما دقیقاً همان متدهای get/put/delete/list کلادفلر را دارد،
 *     پس نیازی به تغییر index.js نیست.
 *  ۲) کلاس آنلاین (ClassRoom) که در نسخه‌ی کلادفلر یک Durable Object بود
 *     را با یک نمونه‌ی درون‌حافظه‌ای + کتابخانه‌ی «ws» جایگزین می‌کند.
 *  ۳) با http.createServer یک سرور HTTP بالا می‌آورد.
 *
 * ⚠️ نکته‌ی مهم درباره‌ی ذخیره‌سازی (KV):
 * این فایل از Upstash Redis (یک دیتابیس رایگان و همیشه‌دائمی، با REST API
 * ساده) به‌عنوان جایگزین Cloudflare KV استفاده می‌کند. کافی است دو متغیر
 * محیطی UPSTASH_REDIS_REST_URL و UPSTASH_REDIS_REST_TOKEN را (از داشبورد
 * رایگان Upstash) تنظیم کنید — دیگر با ری‌استارت/خواب سرور هیچ داده‌ای
 * پاک نمی‌شود.
 * اگر این دو متغیر تنظیم نشوند، به‌صورت خودکار به یک فایل JSON محلی
 * (data/kv.json) برمی‌گردد — فقط برای تست روی سیستم خودتان مناسب است،
 * چون روی هاست‌های رایگان با هر ری‌استارت پاک می‌شود.
 *
 * ⚠️ نکته درباره‌ی کلاس آنلاین:
 * چون این‌جا فقط یک نمونه‌ی سرور Node همیشه در حال اجراست (برخلاف
 * Cloudflare/Deno که ممکن است چند نمونه/ناحیه داشته باشند)، محدودیتی که
 * در نسخه‌ی Deno درباره‌ی چند-ناحیه‌ای بودن وجود داشت، این‌جا اصلاً
 * مطرح نیست — همه‌ی اتصالات همیشه به همان یک نمونه می‌رسند.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import worker, { ClassRoom as ClassRoomLogic } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------- شبیه‌ساز KV کلادفلر: Upstash Redis یا فایل محلی ------------------------- */

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

let EXAM_KV;

if (REDIS_URL && REDIS_TOKEN) {
  // ------- حالت دائمی: Upstash Redis (توصیه‌شده برای دیپلوی واقعی) -------
  const { Redis } = await import("@upstash/redis");
  // automaticDeserialization: false چون index.js خودش مقادیر را با
  // JSON.stringify/JSON.parse مدیریت می‌کند؛ نباید دوباره سمت کتابخانه
  // انجام شود، وگرنه مقدار برگشتی با آنچه Cloudflare KV برمی‌گرداند فرق می‌کند.
  const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN, automaticDeserialization: false });

  EXAM_KV = {
    async get(key) {
      const v = await redis.get(key);
      return v == null ? null : String(v);
    },
    async put(key, value) {
      await redis.set(key, value);
    },
    async delete(key) {
      await redis.del(key);
    },
    async list({ prefix = "" } = {}) {
      // KEYS با الگوی prefix* — برای حجم داده‌ی یک پنل مدرسه کاملاً کافی است.
      const found = await redis.keys(prefix + "*");
      return { keys: found.map((name) => ({ name })), list_complete: true, cursor: null };
    },
  };

  console.log("💾 حالت ذخیره‌سازی: Upstash Redis (دائمی — با ری‌استارت سرور پاک نمی‌شود)");
} else {
  // ------- حالت پشتیبان: فایل JSON محلی (فقط برای تست روی سیستم خودتان) -------
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
  const KV_FILE = path.join(DATA_DIR, "kv.json");

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  let store = {};
  if (fs.existsSync(KV_FILE)) {
    try {
      store = JSON.parse(fs.readFileSync(KV_FILE, "utf8"));
    } catch {
      console.error("⚠️  فایل kv.json خراب بود؛ با یک دیتابیس خالی شروع می‌شود.");
      store = {};
    }
  }

  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      fs.writeFile(KV_FILE, JSON.stringify(store), (err) => {
        if (err) console.error("⚠️  ذخیره‌ی kv.json ناموفق بود:", err.message);
      });
    }, 200);
  }

  EXAM_KV = {
    async get(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    async put(key, value) {
      store[key] = value;
      scheduleSave();
    },
    async delete(key) {
      delete store[key];
      scheduleSave();
    },
    async list({ prefix = "" } = {}) {
      const keys = Object.keys(store)
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: null };
    },
  };

  console.log("⚠️  حالت ذخیره‌سازی: فایل محلی (غیردائمی روی هاست‌های رایگان).");
  console.log("   برای ذخیره‌سازی دائمی و رایگان، UPSTASH_REDIS_REST_URL و UPSTASH_REDIS_REST_TOKEN را تنظیم کنید.");
}

/* ------------------------- جایگزین Durable Object برای کلاس آنلاین ------------------------- */

let classRoomInstance = null;
function getClassRoom(env) {
  if (!classRoomInstance) {
    classRoomInstance = new ClassRoomLogic({}, env);
  }
  return classRoomInstance;
}

const env = {
  EXAM_KV,
  // به index.js اجازه می‌دهیم بفهمد کلاس آنلاین فعال است؛
  // خود اتصال WebSocket را پایین‌تر مستقیماً مدیریت می‌کنیم.
  CLASSROOM: { __nodeAdapter: true },
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  GROQ_MODEL: process.env.GROQ_MODEL || "",
  CLOUDFLARE_AI_MODEL: process.env.CLOUDFLARE_AI_MODEL || "",
  // env.AI مخصوص Cloudflare Workers AI است و روی Node معادلی ندارد؛
  // آن گزینه‌ی هوش مصنوعی خاص کار نمی‌کند اما بقیه (Groq/Gemini) سالم‌اند.
  AI: null,
};

function parseCookieHeader(c) {
  const out = {};
  (c || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/* ------------------------- تبدیل درخواست/پاسخ Node <-> Fetch API ------------------------- */

async function nodeReqToFetchRequest(req) {
  const host = req.headers.host || "localhost";
  const url = `http://${host}${req.url}`;
  const method = req.method || "GET";

  let body;
  if (method !== "GET" && method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length) body = Buffer.concat(chunks);
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }

  return new Request(url, { method, headers, body });
}

async function sendFetchResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

/* ------------------------- سرور HTTP اصلی ------------------------- */

const server = http.createServer(async (req, res) => {
  try {
    const request = await nodeReqToFetchRequest(req);
    const response = await worker.fetch(request, env);
    await sendFetchResponse(res, response);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
  }
});

/* ------------------------- مدیریت WebSocket کلاس آنلاین ------------------------- */

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    socket.destroy();
    return;
  }

  if (url.pathname !== "/api/classroom/ws") {
    socket.destroy();
    return;
  }

  const role = url.searchParams.get("role") === "teacher" ? "teacher" : "student";

  try {
    if (role === "teacher") {
      const cookies = parseCookieHeader(req.headers.cookie || "");
      const stored = await EXAM_KV.get("teacher_pass");
      if (!stored || !cookies.t_auth || cookies.t_auth !== stored) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    } else {
      const id = url.searchParams.get("id") || "";
      const rec = id ? await EXAM_KV.get("student:" + id) : null;
      if (!rec) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
    }
  } catch {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = getClassRoom(env);
    const name = (url.searchParams.get("name") || (role === "teacher" ? "معلم" : "دانش‌آموز")).slice(0, 60);
    const id = url.searchParams.get("id") || "";
    const session = { role, id, name };

    room.sessions.set(ws, session);

    ws.send(
      JSON.stringify({
        type: "init",
        role,
        strokes: room.strokes,
        boardBg: room.boardBg,
        boardBgW: room.boardBgW,
        boardBgH: room.boardBgH,
        chat: room.chat.slice(-50),
        participants: room.participantList(),
      })
    );

    room.broadcast({ type: "presence", event: "join", role, name, participants: room.participantList() }, ws);

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      room.handleMessage(ws, session, msg);
    });

    const onClose = () => {
      if (!room.sessions.has(ws)) return;
      room.sessions.delete(ws);
      room.broadcast({ type: "presence", event: "leave", role: session.role, name: session.name, participants: room.participantList() });
    };
    ws.on("close", onClose);
    ws.on("error", onClose);
  });
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log("پنل روی Node.js در حال اجراست ✅  (پورت: " + server.address().port + ")");
});
