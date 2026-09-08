/**
 * لایه‌ی Express واقعی
 * -------------------
 * برخلاف server.js قبلی (که فقط یک پل Node<->Fetch بود)، این فایل یک اپ
 * واقعی Express با روتینگ صریحه. منطق تجاری (index.js) دست‌نخورده باقی
 * مونده و اینجا صدا زده می‌شه — یعنی صفر ریسک برای رفتار فعلی سایت.
 *
 * از این به بعد، هر قابلیت جدید رو می‌شه به‌شکل یک app.get/app.post تمیز
 * همین‌جا (یا در فایل‌های routes/ جدا) اضافه کرد، بدون این‌که لازم باشه
 * زنجیره‌ی if(path===...) داخل index.js رو دست بزنید.
 *
 * فاز بعدی (اختیاری، تدریجی): تبدیل تک‌تک زیرمسیرهای /api/* داخل
 * handleApi به روت‌های مجزای Express، هر بار چندتا و با تست.
 */

import express from "express";
import compression from "compression";

import worker, {
  handleApi,
  handleClassroomSocket,
  landingPage,
  notFoundPage,
  studentPage,
  infoLinkPage,
  workSheetPage,
  studentClassPage,
  teacherPage,
  teacherServiceWorkerScript,
} from "../index.js";

function html(body, status = 200, extraHeaders = {}) {
  return { body, status, headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders } };
}

function sendResult(res, result) {
  res.status(result.status || 200);
  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.send(result.body);
}

async function sendFetchResponse(res, response) {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "content-length") return;
    res.setHeader(key, value);
  });
  const buf = Buffer.from(await response.arrayBuffer());
  res.send(buf);
}

export function createApp(env) {
  const app = express();

  // فشرده‌سازی gzip/brotli خودکار برای همه‌ی پاسخ‌ها (جایگزین کد دستی قبلی)
  app.use(compression());

  app.disable("x-powered-by");

  /* ------------------------- صفحات اصلی: روت‌های واقعی Express ------------------------- */

  app.get("/", (req, res) => {
    sendResult(res, html(landingPage()));
  });

  app.get(["/teacher", "/teacher/"], (req, res) => {
    sendResult(res, html(teacherPage(), 200, { "cache-control": "no-store" }));
  });

  app.get("/sw.js", (req, res) => {
    res.setHeader("content-type", "application/javascript; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.send(teacherServiceWorkerScript());
  });

  app.get("/s/*path", async (req, res, next) => {
    try {
      const id = decodeURIComponent(req.path.slice(3));
      await sendFetchResponse(res, await studentPage(env, id));
    } catch (err) {
      next(err);
    }
  });

  app.get("/info/*path", async (req, res, next) => {
    try {
      const id = decodeURIComponent(req.path.slice(6));
      await sendFetchResponse(res, await infoLinkPage(env, id));
    } catch (err) {
      next(err);
    }
  });

  app.get("/w/*path", async (req, res, next) => {
    try {
      const id = decodeURIComponent(req.path.slice(3));
      await sendFetchResponse(res, await workSheetPage(env, id));
    } catch (err) {
      next(err);
    }
  });

  app.get("/class/*path", async (req, res, next) => {
    try {
      const id = decodeURIComponent(req.path.slice(7));
      await sendFetchResponse(res, await studentClassPage(env, id));
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------- API: فعلاً از طریق handleApi موجود (بدون تغییر منطق) ------------------------- */

  app.all("/api/*path", async (req, res, next) => {
    try {
      const fetchReq = await expressReqToFetchRequest(req);
      const url = new URL(fetchReq.url);
      const response = await handleApi(fetchReq, env, url, url.pathname);
      await sendFetchResponse(res, response);
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------- fallback: هر مسیر ناشناخته از طریق worker.fetch قدیمی ------------------------- */
  /* این خط تضمین می‌کنه اگه مسیری رو جا انداختیم، همون رفتار قبلی (۴۰۴ یا هر چیز دیگه) حفظ بشه. */

  app.use(async (req, res, next) => {
    try {
      const fetchReq = await expressReqToFetchRequest(req);
      const response = await worker.fetch(fetchReq, env);
      await sendFetchResponse(res, response);
    } catch (err) {
      next(err);
    }
  });

  app.use((err, req, res, next) => {
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  });

  return app;
}

async function expressReqToFetchRequest(req) {
  const host = req.headers.host || "localhost";
  const url = `http://${host}${req.originalUrl}`;
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

export { handleClassroomSocket };
