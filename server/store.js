// Jednoduché úložiště v jednom JSON souboru. Pro pár uživatelů bohatě stačí.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const DB_FILE = path.join(DATA_DIR, "db.json");

let db = { profiles: [], subjects: [], topics: [] };
let writing = Promise.resolve();
let dirty = false;

export const newId = (len = 10) => crypto.randomBytes(8).toString("hex").slice(0, len);

export async function load() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    db = { ...db, ...JSON.parse(await fs.readFile(DB_FILE, "utf8")) };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  // Po restartu serveru už rozpracované generování nikdo nedokončí.
  for (const t of db.topics) {
    if (t.status === "processing") {
      t.status = t.sources?.length ? "ready" : "error";
      t.error = "Zpracování přerušil restart serveru. Spusť generování znovu.";
      t.progress = null;
    }
  }
  await save();
}

// Zápisy jdou za sebou a atomicky (tmp + rename), ať se soubor nikdy nerozbije.
export function save() {
  dirty = true;
  writing = writing.then(async () => {
    if (!dirty) return;
    dirty = false;
    const tmp = DB_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(db));
    await fs.rename(tmp, DB_FILE);
  }).catch((err) => console.error("Uložení dat selhalo:", err));
  return writing;
}

export const data = () => db;

export const getTopic = (id) => db.topics.find((t) => t.id === id);
export const getSubject = (id) => db.subjects.find((s) => s.id === id);
export const getProfile = (id) => db.profiles.find((p) => p.id === id);

export function dueCount(topic, now = Date.now()) {
  return (topic.flashcards || []).filter((c) => (c.due || 0) <= now).length;
}

export function topicSummary(t) {
  const last = t.attempts?.[t.attempts.length - 1];
  return {
    id: t.id,
    subjectId: t.subjectId,
    title: t.title,
    status: t.status,
    error: t.error || null,
    createdAt: t.createdAt,
    testDate: t.testDate || null,
    cards: t.flashcards?.length || 0,
    due: dueCount(t),
    questions: t.quiz?.length || 0,
    hasNotes: Boolean(t.notes),
    lastScore: last ? Math.round((last.score / last.total) * 100) : null,
  };
}

// Co se posílá klientovi: všechno kromě plných textů materiálů (ty si stáhne zvlášť).
export function topicForClient(t) {
  return {
    ...t,
    sources: (t.sources || []).map((s) => ({ id: s.id, name: s.name, kind: s.kind, chars: s.text.length, preview: s.text.slice(0, 6000) })),
    due: dueCount(t),
  };
}
