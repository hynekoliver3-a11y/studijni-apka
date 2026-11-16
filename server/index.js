import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";

try {
  process.loadEnvFile();
} catch {
  /* bez .env souboru se berou proměnné z prostředí */
}

const store = await import("./store.js");
const ai = await import("./ai.js");
const { newId } = store;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const PASSWORD = process.env.APP_PASSWORD || "";
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json({ limit: "80mb" }));

// ---------- statické soubory ----------
app.use(express.static(path.join(root, "public")));
const vendor = {
  "marked.js": "marked/lib/marked.umd.js",
  "purify.js": "dompurify/dist/purify.min.js",
  "katex.js": "katex/dist/katex.min.js",
  "katex.css": "katex/dist/katex.min.css",
};
for (const [name, file] of Object.entries(vendor)) {
  app.get("/vendor/" + name, (req, res) => res.sendFile(path.join(root, "node_modules", file)));
}
app.use("/vendor/fonts", express.static(path.join(root, "node_modules/katex/dist/fonts"), { maxAge: "30d" }));

// ---------- přístup ----------
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest();
const passwordOk = (given) => !PASSWORD || crypto.timingSafeEqual(hash(given || ""), hash(PASSWORD));

app.get("/api/config", (req, res) => {
  res.json({ needsPassword: Boolean(PASSWORD), aiReady: ai.aiReady(), model: ai.MODEL });
});
app.post("/api/login", (req, res) => {
  if (!passwordOk(req.body?.password)) return res.status(401).json({ error: "Špatné heslo." });
  res.json({ ok: true });
});
app.use("/api", (req, res, next) => {
  if (!passwordOk(req.get("x-app-password"))) return res.status(401).json({ error: "Přihlas se heslem." });
  next();
});

// ---------- pomocné ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const need = (value, message = "Nenalezeno.") => {
  if (!value) throw new HttpError(404, message);
  return value;
};
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const topicOf = (req) => need(store.getTopic(req.params.id), "Téma neexistuje.");

function openStream(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  const alive = () => !res.writableEnded && !res.destroyed;
  // AI umí přemýšlet i minutu bez výstupu; ping drží spojení přes proxy naživu.
  const ping = setInterval(() => alive() && res.write(": ping\n\n"), 15000);
  return {
    send: (event) => alive() && res.write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => {
      clearInterval(ping);
      if (alive()) res.end();
    },
  };
}

// ---------- profily a předměty ----------
app.get("/api/state", (req, res) => {
  const db = store.data();
  res.json({ profiles: db.profiles, subjects: db.subjects, topics: db.topics.map(store.topicSummary) });
});

app.post("/api/profiles", async (req, res) => {
  const name = str(req.body.name, 40);
  if (!name) throw new HttpError(400, "Zadej jméno.");
  const profile = { id: newId(), name, color: str(req.body.color, 20) || "#7c5cff" };
  store.data().profiles.push(profile);
  await store.save();
  res.json(profile);
});

app.delete("/api/profiles/:id", async (req, res) => {
  const db = store.data();
  const subjectIds = db.subjects.filter((s) => s.profileId === req.params.id).map((s) => s.id);
  db.topics = db.topics.filter((t) => !subjectIds.includes(t.subjectId));
  db.subjects = db.subjects.filter((s) => s.profileId !== req.params.id);
  db.profiles = db.profiles.filter((p) => p.id !== req.params.id);
  await store.save();
  res.json({ ok: true });
});

app.post("/api/subjects", async (req, res) => {
  need(store.getProfile(req.body.profileId), "Profil neexistuje.");
  const name = str(req.body.name, 60);
  if (!name) throw new HttpError(400, "Zadej název předmětu.");
  const subject = { id: newId(), profileId: req.body.profileId, name, emoji: str(req.body.emoji, 8) || "📘", color: str(req.body.color, 20) || "#7c5cff" };
  store.data().subjects.push(subject);
  await store.save();
  res.json(subject);
});

app.patch("/api/subjects/:id", async (req, res) => {
  const subject = need(store.getSubject(req.params.id));
  if (req.body.name !== undefined) subject.name = str(req.body.name, 60) || subject.name;
  if (req.body.emoji !== undefined) subject.emoji = str(req.body.emoji, 8) || subject.emoji;
  if (req.body.color !== undefined) subject.color = str(req.body.color, 20) || subject.color;
  await store.save();
  res.json(subject);
});

app.delete("/api/subjects/:id", async (req, res) => {
  const db = store.data();
  db.topics = db.topics.filter((t) => t.subjectId !== req.params.id);
  db.subjects = db.subjects.filter((s) => s.id !== req.params.id);
  await store.save();
  res.json({ ok: true });
});

// ---------- zpracování materiálů ----------
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// Vstup z klienta -> { ready: [hotové textové zdroje], pending: [soubory k přepisu AI] }
async function intake(body) {
  const ready = [];
  const pending = [];
  const pasted = String(body.text || "").trim();
  if (pasted) ready.push({ id: newId(6), name: "Vložený text", kind: "text", text: pasted });

  for (const f of Array.isArray(body.files) ? body.files : []) {
    const name = str(f.name, 120) || "soubor";
    const type = String(f.type || "");
    const data = String(f.data || "");
    if (!data) continue;
    const ext = name.toLowerCase().split(".").pop();
    if (type === "application/pdf" || ext === "pdf") pending.push({ name, type: "application/pdf", data, kind: "pdf" });
    else if (IMAGE_TYPES.includes(type)) pending.push({ name, type, data, kind: "image" });
    else if (ext === "docx") {
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data, "base64") });
      if (value.trim()) ready.push({ id: newId(6), name, kind: "docx", text: value.trim() });
    } else if (type.startsWith("text/") || ["txt", "md", "markdown", "csv", "rtf", "tex"].includes(ext)) {
      const text = Buffer.from(data, "base64").toString("utf8").trim();
      if (text) ready.push({ id: newId(6), name, kind: "text", text });
    } else {
      throw new HttpError(400, `Soubor „${name}“ neumím přečíst. Podporuji PDF, fotky, Word (.docx) a text.`);
    }
  }
  if (!ready.length && !pending.length) throw new HttpError(400, "Nahraj soubor nebo vlož text.");
  return { ready, pending };
}

const PARTS = ["notes", "flashcards", "quiz"];

// Běží na pozadí i když klient zavře stránku; průběh se ukládá do topic.progress.
async function process_(topic, { pending = [], parts = PARTS, extra = "" }, send = () => {}) {
  topic.status = "processing";
  topic.error = null;
  topic.progress = { read: pending.length ? "run" : "done", notes: "wait", flashcards: "wait", quiz: "wait" };
  for (const p of PARTS) if (!parts.includes(p)) topic.progress[p] = "skip";
  const step = (key, state) => {
    topic.progress[key] = state;
    send({ type: "progress", progress: topic.progress });
  };
  const errors = [];
  await store.save();
  send({ type: "progress", progress: topic.progress });

  try {
    // 1) přepis PDF a fotek
    const read = await Promise.allSettled(pending.map(async (f) => ({ id: newId(6), name: f.name, kind: f.kind, text: await ai.transcribe(f) })));
    for (const r of read) {
      if (r.status === "fulfilled") topic.sources.push(r.value);
      else errors.push(ai.friendlyError(r.reason));
    }
    if (!topic.sources.length) throw new ai.UserError(errors[0] || "Z materiálů se nepodařilo nic přečíst.");
    step("read", "done");

    // 2) výpisky, kartičky a test souběžně
    const jobs = {
      notes: async () => {
        const out = await ai.generateNotes(topic.sources, extra);
        topic.notes = out.markdown;
        if (!topic.title) topic.title = out.title.slice(0, 120);
      },
      flashcards: async () => {
        topic.flashcards = await ai.generateFlashcards(topic.sources, extra);
      },
      quiz: async () => {
        topic.quiz = await ai.generateQuiz(topic.sources, extra);
      },
    };
    await Promise.all(parts.map(async (part) => {
      step(part, "run");
      try {
        await jobs[part]();
        step(part, "done");
      } catch (err) {
        errors.push(ai.friendlyError(err));
        step(part, "error");
      }
      await store.save();
    }));
    topic.status = "ready";
  } catch (err) {
    errors.unshift(ai.friendlyError(err));
    topic.status = topic.sources.length ? "ready" : "error";
  }

  if (!topic.title) topic.title = "Nové téma";
  topic.error = errors.length ? [...new Set(errors)].join(" ") : null;
  topic.progress = null;
  await store.save();
  send({ type: "done", topic: store.topicForClient(topic) });
}

// ---------- témata ----------
app.post("/api/topics", async (req, res) => {
  need(store.getSubject(req.body.subjectId), "Předmět neexistuje.");
  const { ready, pending } = await intake(req.body);
  const topic = {
    id: newId(),
    subjectId: req.body.subjectId,
    title: str(req.body.title, 120),
    testDate: str(req.body.testDate, 10) || null,
    createdAt: Date.now(),
    status: "processing",
    sources: ready,
    notes: "",
    flashcards: [],
    quiz: [],
    attempts: [],
    chat: [],
  };
  store.data().topics.push(topic);
  const stream = openStream(res);
  stream.send({ type: "created", id: topic.id });
  await process_(topic, { pending, extra: str(req.body.instructions, 2000) }, stream.send);
  stream.end();
});

app.get("/api/topics/:id", (req, res) => res.json(store.topicForClient(topicOf(req))));

app.patch("/api/topics/:id", async (req, res) => {
  const topic = topicOf(req);
  const b = req.body;
  if (b.title !== undefined) topic.title = str(b.title, 120) || topic.title;
  if (b.testDate !== undefined) topic.testDate = str(b.testDate, 10) || null;
  if (typeof b.notes === "string") topic.notes = b.notes;
  if (Array.isArray(b.flashcards)) {
    topic.flashcards = b.flashcards
      .filter((c) => str(c.front, 5000) && str(c.back, 5000))
      .map((c) => {
        const old = topic.flashcards.find((x) => x.id === c.id);
        return { id: old?.id || newId(6), front: str(c.front, 5000), back: str(c.back, 5000), box: old?.box || 0, due: old?.due || 0 };
      });
  }
  if (Array.isArray(b.deleteQuestions)) topic.quiz = topic.quiz.filter((q) => !b.deleteQuestions.includes(q.id));
  await store.save();
  res.json(store.topicForClient(topic));
});

app.delete("/api/topics/:id", async (req, res) => {
  const db = store.data();
  db.topics = db.topics.filter((t) => t.id !== req.params.id);
  await store.save();
  res.json({ ok: true });
});

const busy = (topic) => {
  if (topic.status === "processing") throw new HttpError(409, "Téma se právě zpracovává, chvilku vydrž.");
};

// přidání materiálu (a volitelně nové vygenerování všeho)
app.post("/api/topics/:id/sources", async (req, res) => {
  const topic = topicOf(req);
  busy(topic);
  const { ready, pending } = await intake(req.body);
  topic.sources.push(...ready);
  const stream = openStream(res);
  await process_(topic, { pending, parts: req.body.regenerate ? PARTS : [] }, stream.send);
  stream.end();
});

app.delete("/api/topics/:id/sources/:sourceId", async (req, res) => {
  const topic = topicOf(req);
  topic.sources = topic.sources.filter((s) => s.id !== req.params.sourceId);
  await store.save();
  res.json(store.topicForClient(topic));
});

app.post("/api/topics/:id/generate", async (req, res) => {
  const topic = topicOf(req);
  busy(topic);
  if (!topic.sources.length) throw new HttpError(400, "Téma nemá žádné materiály.");
  const parts = PARTS.filter((p) => (req.body.parts || PARTS).includes(p));
  const stream = openStream(res);
  await process_(topic, { parts, extra: str(req.body.instructions, 2000) }, stream.send);
  stream.end();
});

// ---------- chat ----------
const chatting = new Set();

app.post("/api/topics/:id/chat", async (req, res) => {
  const topic = topicOf(req);
  busy(topic);
  const text = str(req.body.message, 8000);
  if (!text) throw new HttpError(400, "Napiš zprávu.");
  if (chatting.has(topic.id)) throw new HttpError(409, "AI ještě odpovídá na předchozí zprávu.");
  chatting.add(topic.id);
  const stream = openStream(res);
  try {
    const out = await ai.chat(topic, text, {
      text: (delta) => stream.send({ type: "text", delta }),
      reset: (text) => stream.send({ type: "reset", text }),
      action: (label) => stream.send({ type: "action", label }),
      changed: () => {
        store.save();
        stream.send({ type: "topic", topic: store.topicForClient(topic) });
      },
    });
    topic.chat.push({ role: "user", text }, { role: "assistant", text: out.text, actions: out.actions });
    await store.save();
    stream.send({ type: "done", topic: store.topicForClient(topic) });
  } catch (err) {
    await store.save();
    stream.send({ type: "error", message: ai.friendlyError(err), topic: store.topicForClient(topic) });
  } finally {
    chatting.delete(topic.id);
    stream.end();
  }
});

app.delete("/api/topics/:id/chat", async (req, res) => {
  const topic = topicOf(req);
  topic.chat = [];
  await store.save();
  res.json({ ok: true });
});

// ---------- procvičování ----------
const DAY = 86400000;
const INTERVALS = [0, 1, 3, 7, 16, 35, 90]; // dny podle „krabičky“ (Leitner)

app.post("/api/topics/:id/review", async (req, res) => {
  const topic = topicOf(req);
  const card = need(topic.flashcards.find((c) => c.id === req.body.cardId), "Kartička neexistuje.");
  card.box = req.body.known ? Math.min((card.box || 0) + 1, INTERVALS.length - 1) : 0;
  card.due = req.body.known ? Date.now() + INTERVALS[card.box] * DAY : 0;
  await store.save();
  res.json({ card, due: store.dueCount(topic) });
});

app.post("/api/topics/:id/grade", async (req, res) => {
  const topic = topicOf(req);
  const question = need(topic.quiz.find((q) => q.id === req.body.questionId && q.type === "open"), "Otázka neexistuje.");
  const answer = str(req.body.answer, 4000);
  if (!answer) return res.json({ verdict: "wrong", feedback: "Bez odpovědi. Správně: " + question.answer });
  try {
    res.json(await ai.gradeOpenAnswer(question, answer));
  } catch (err) {
    throw new HttpError(502, ai.friendlyError(err));
  }
});

app.post("/api/topics/:id/attempts", async (req, res) => {
  const topic = topicOf(req);
  const total = Number(req.body.total);
  const score = Number(req.body.score);
  if (!(total > 0) || !(score >= 0)) throw new HttpError(400, "Neplatný výsledek.");
  topic.attempts.push({ at: Date.now(), score, total, wrong: (req.body.wrong || []).slice(0, 200).map(String) });
  topic.attempts = topic.attempts.slice(-30);
  await store.save();
  res.json(store.topicForClient(topic));
});

// ---------- chyby ----------
app.use("/api", (req, res) => res.status(404).json({ error: "Neznámá adresa." }));
app.use((err, req, res, next) => {
  if (res.headersSent) return res.end();
  const status = err.status || (err.type === "entity.too.large" ? 413 : 500);
  if (status >= 500) console.error(err);
  const message = status === 413 ? "Soubory jsou dohromady moc velké (limit ~55 MB)." : status >= 500 ? "Chyba serveru." : err.message;
  res.status(status).json({ error: message });
});

await store.load();
app.listen(PORT, () => {
  console.log(`Studovna běží na http://localhost:${PORT}`);
  if (!ai.aiReady()) console.log("POZOR: chybí ANTHROPIC_API_KEY, AI funkce nepoběží.");
  if (!PASSWORD) console.log("Tip: nastav APP_PASSWORD, pokud apku pustíš na internet.");
});
