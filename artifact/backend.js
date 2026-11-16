/* Studovna jako artifact v Claude: žádný server ani API klíč.
   Tenhle soubor nahrazuje server/*.js – data ukládá do úložiště artifactu (jen pro
   přihlášeného uživatele) a AI volá přes účet toho, kdo má stránku otevřenou. */
"use strict";

window.Backend = (() => {
  let db, sample, col;
  let limits = {};
  let index = { subjects: [], topics: [] };
  const topics = new Map();   // id -> téma včetně zdrojů
  const running = new Map();  // id -> průběh zpracování
  const chatting = new Set();

  class UserError extends Error {}
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
  const newId = (n = 10) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  const bytes = (s) => new TextEncoder().encode(s).length;
  const need = (v, msg = "Nenalezeno.") => { if (!v) throw new UserError(msg); return v; };

  const MAX_SOURCE_CHARS = 150000; // materiály jednoho tématu (limit dotazu na AI i velikosti dokumentu)
  const DOC_LIMIT = 240 * 1024;

  // ---------- úložiště ----------
  const queues = new Map();
  const pending = new Map();
  // Do jednoho dokumentu smí běžet jen jeden zápis; další se sloučí a vezme až nejnovější stav.
  function write(docId, getData) {
    if (pending.has(docId)) return pending.get(docId);
    const p = (queues.get(docId) || Promise.resolve()).catch(() => {}).then(() => {
      pending.delete(docId);
      return col.doc(docId).set(clone(getData()));
    });
    pending.set(docId, p);
    queues.set(docId, p);
    return p.catch((err) => { throw new UserError(storeError(err)); });
  }

  function storeError(err) {
    if (err?.code === "quota_exceeded") return "Úložiště je plné. Smaž stará témata.";
    if (err?.code === "invalid_argument") return "Téma je moc velké na uložení. Rozděl ho do víc témat.";
    if (err?.code === "resource_exhausted") return "Moc zápisů najednou, zkus to za chvilku.";
    return "Uložení se nepovedlo. Zkontroluj připojení a zkus to znovu.";
  }

  const withTimeout = (promise, ms, message) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new UserError(message)), ms)),
  ]);

  const dueCount = (t, now = Date.now()) => t.flashcards.filter((c) => (c.due || 0) <= now).length;

  function summary(t) {
    const last = t.attempts[t.attempts.length - 1];
    return {
      id: t.id, subjectId: t.subjectId, title: t.title, createdAt: t.createdAt, testDate: t.testDate || null,
      error: t.error || null, cards: t.flashcards.length, dueAt: t.flashcards.map((c) => c.due || 0),
      questions: t.quiz.length, hasNotes: Boolean(t.notes),
      lastScore: last ? Math.round((last.score / last.total) * 100) : null,
    };
  }

  const saveIndex = () => write("index", () => index);

  function saveTopic(t) {
    const i = index.topics.findIndex((x) => x.id === t.id);
    if (i >= 0) index.topics[i] = summary(t); else index.topics.push(summary(t));
    const core = () => {
      const { sources, ...rest } = t;
      // Dlouhá konverzace nesmí přerůst limit dokumentu: nejstarší zprávy odpadnou.
      while (rest.chat.length > 2 && bytes(JSON.stringify(rest)) > DOC_LIMIT) rest.chat = rest.chat.slice(2);
      t.chat = rest.chat;
      return rest;
    };
    return Promise.all([write("t_" + t.id, core), saveIndex()]);
  }
  const saveSources = (t) => write("s_" + t.id, () => ({ sources: t.sources }));

  async function getTopic(id) {
    if (topics.has(id)) return topics.get(id);
    const [core, src] = await withTimeout(Promise.all([col.doc("t_" + id).get(), col.doc("s_" + id).get()]), 15000, "Načtení tématu trvá moc dlouho. Zkus to znovu.");
    if (!core.exists) throw new UserError("Téma neexistuje.");
    const t = { notes: "", flashcards: [], quiz: [], attempts: [], chat: [], ...clone(core.data()), sources: src.exists ? clone(src.data()).sources || [] : [] };
    topics.set(id, t);
    return t;
  }

  function forClient(t) {
    const progress = running.get(t.id);
    return {
      ...clone({ ...t, sources: undefined }),
      status: progress ? "processing" : t.sources.length || t.notes ? "ready" : "error",
      progress: progress ? { ...progress } : null,
      sources: t.sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, chars: s.text.length, preview: s.text.slice(0, 6000) })),
      due: dueCount(t),
    };
  }

  function stateForClient() {
    const now = Date.now();
    return {
      profiles: [{ id: "me", name: "", color: "#7c5cff" }],
      subjects: index.subjects.map((s) => ({ ...s, profileId: "me" })),
      topics: index.topics.map((t) => ({
        ...t, status: running.has(t.id) ? "processing" : "ready",
        due: (t.dueAt || []).filter((d) => d <= now).length,
      })),
    };
  }

  // ---------- AI ----------
  function aiError(err) {
    if (err instanceof UserError) return err.message;
    const messages = {
      not_granted: "Stránka nemá povolení používat Claude. Obnov ji a v dotazu to povol.",
      sampling_disabled: "Claude není pro tenhle účet dostupný.",
      rate_limited: "Limit využití Claude je vyčerpaný nebo běží moc dotazů najednou. Zkus to později.",
      session_expired: "Přihlášení vypršelo. Přihlas se do Claude znovu a obnov stránku.",
      prompt_too_large: "Materiály jsou moc dlouhé. Rozděl je do víc témat.",
      image_rejected: "Obrázek se nepodařilo zpracovat. Zkus jiný soubor (JPG nebo PNG).",
      images_unavailable: "V tomhle zobrazení nejde posílat obrázky. Vlož text nebo textové PDF.",
      refused: "AI tenhle požadavek odmítla. Zkus ho přeformulovat.",
      empty_completion: "AI nic nevrátila. Zkus to znovu nebo požadavek zjednoduš.",
      cancelled: "Zrušeno.",
    };
    if (err?.code && messages[err.code]) return messages[err.code];
    if (err?.code) return "Spojení s AI selhalo. Zkus to znovu.";
    console.error(err);
    return "Něco se pokazilo: " + (err?.message || "neznámá chyba");
  }

  async function ask(input, options = {}) {
    if (!sample) throw new UserError("AI tu není dostupná. Otevři stránku přihlášený v Claude.");
    const size = typeof input === "string" ? bytes(input) : input.reduce((n, m) => n + bytes(m.content), 0);
    if (limits.maxPromptBytes && size > limits.maxPromptBytes) throw new UserError("Materiály jsou moc dlouhé. Rozděl je do víc témat.");
    const out = await sample(input, options.tools ? options : { cache: false, ...options });
    return out;
  }

  const LANG_RULE = "Write in the language of the materials (Czech unless they are clearly in another language; for foreign-language subjects keep the studied language for the vocabulary/examples and explain in Czech).";
  const TUTOR = `You are an expert tutor preparing a school student for a test, working only from the student's own uploaded materials. Cover everything in the materials that could be tested; do not invent facts beyond them, though you may correct clear errors and fill a gap that is needed for the rest to make sense. ${LANG_RULE}`;
  const NOTES_FORMAT = "Notes format: Markdown. Use ## and ### headings, short bullet points, numbered steps for procedures, and tables for comparisons. Mark the terms, definitions, dates, and formulas most likely to be tested with ==double equals highlights== (sparingly, so they stand out). Write formulas in LaTeX: $...$ inline, $$...$$ on a separate line. No top-level # heading.";
  const QUESTION_RULES = `Question types:
- "choice": 4 options, exactly one correct. Wrong options must be plausible. Vary the position of the correct option.
- "truefalse": a statement that is either true or false.
- "open": a question answered in one to three sentences or a short calculation, with a model answer.
Every question has an explanation that says briefly why the right answer is right, so the student learns from a mistake.`;

  const materialsBlock = (sources) => sources.map((s) => `<material name=${JSON.stringify(s.name)}>\n${s.text}\n</material>`).join("\n\n");
  const genPrompt = (sources, task, extra) =>
    `${TUTOR}\n\nThe student's materials:\n\n${materialsBlock(sources)}\n\n---\n\n${task}${extra ? `\n\nThe student's extra instructions: ${extra}` : ""}`;

  async function generateNotes(sources, extra) {
    const { text, truncated } = await ask(genPrompt(sources,
      `Write study notes (výpisky) from the materials: everything needed for the test, organized so it is easy to learn, far shorter than the source but with nothing testable left out. End with a short "Shrnutí" section of the handful of points to remember, and add a memory aid where one genuinely helps.\n\n${NOTES_FORMAT}\n\nOutput format: the first line is "TITLE: " followed by a short topic title (at most 6 words) naming what the materials cover. Then a blank line, then the notes. Nothing else, no preface and no closing remark.`,
      extra));
    if (truncated) throw new UserError("Výpisky vyšly moc dlouhé. Rozděl materiál do víc témat.");
    const match = text.match(/^\s*TITLE:\s*(.+)\n/);
    return { title: match ? match[1].trim().replace(/^["„]|["“]$/g, "") : "", markdown: (match ? text.slice(match[0].length) : text).trim() };
  }

  const makeCard = (c) => ({ id: newId(6), front: str(c.front, 5000), back: str(c.back, 5000), box: 0, due: 0 });

  // Kartičky a otázky se nechávají psát jako prostý text (ne JSON), aby se nerozbily vzorce se zpětnými lomítky.
  function parseFields(block, labels) {
    const out = {};
    let key = null;
    for (const line of block.split("\n")) {
      const m = line.match(labels);
      if (m) { key = m[1].toUpperCase(); out[key] = m[2]; }
      else if (key) out[key] += "\n" + line;
    }
    for (const k of Object.keys(out)) out[k] = out[k].trim();
    return out;
  }

  async function generateFlashcards(sources, extra) {
    const { text } = await ask(genPrompt(sources,
      `Create flashcards covering all the testable knowledge in the materials: terms and definitions, facts, dates, formulas, causes and effects, procedures. One fact per card. The front is a specific question or prompt; the back is the shortest complete answer. Make as many cards as the content needs (usually 15 to 40). Inline LaTeX ($...$) is allowed for formulas.\n\nOutput format, one card after another separated by a blank line, and nothing else:\nQ: the front\nA: the back`,
      extra));
    const cards = text.split(/\n(?=Q:)/).map((b) => parseFields(b, /^(Q|A):\s*(.*)$/i)).filter((f) => f.Q && f.A).map((f) => makeCard({ front: f.Q, back: f.A }));
    if (!cards.length) throw new UserError("AI vrátila kartičky v nečitelné podobě. Zkus to znovu.");
    return cards;
  }

  function makeQuestion(q) {
    const base = { id: newId(6), type: q.type, question: str(q.question, 5000), explanation: str(q.explanation, 5000) };
    if (!base.question) return null;
    if (q.type === "truefalse") return { ...base, options: ["Pravda", "Nepravda"], correct: Number(q.correct_index) === 1 ? 1 : 0 };
    if (q.type === "choice") {
      const options = (Array.isArray(q.options) ? q.options : []).map((o) => str(o, 2000)).filter(Boolean);
      if (options.length >= 2) {
        const ci = Number(q.correct_index);
        return { ...base, options, correct: Number.isInteger(ci) && ci >= 0 && ci < options.length ? ci : 0 };
      }
    }
    const answer = str(q.answer, 5000);
    return answer ? { ...base, type: "open", answer } : null;
  }

  const QUIZ_FORMAT = `Output format, one question block after another separated by a blank line, and nothing else:

[choice]
Q: the question
A) option
B) option
C) option
D) option
CORRECT: the letter of the correct option
WHY: explanation

[truefalse]
Q: the statement
CORRECT: true or false
WHY: explanation

[open]
Q: the question
ANSWER: the model answer
WHY: explanation`;

  function parseQuiz(text) {
    const parts = text.split(/^\[(choice|truefalse|open)\][ \t]*$/im);
    const out = [];
    for (let i = 1; i < parts.length; i += 2) {
      const type = parts[i].toLowerCase();
      const body = parts[i + 1] || "";
      const f = parseFields(body, /^(Q|CORRECT|WHY|ANSWER):\s*(.*)$/i);
      const q = { type, question: f.Q, explanation: f.WHY, answer: f.ANSWER };
      if (type === "choice") {
        const opts = [...body.matchAll(/^([A-H])\)\s*(.+)$/gm)];
        q.options = opts.map((m) => m[2]);
        q.correct_index = opts.findIndex((m) => m[1] === (f.CORRECT || "").trim().charAt(0).toUpperCase());
        // otázka nesmí „spolknout“ řádky s možnostmi
        q.question = (f.Q || "").split(/\n[A-H]\)\s/)[0];
        if (q.correct_index < 0) continue;
      }
      if (type === "truefalse") q.correct_index = /^(true|pravda|ano)/i.test(f.CORRECT || "") ? 0 : 1;
      const made = makeQuestion(q);
      if (made) out.push(made);
    }
    return out;
  }

  async function generateQuiz(sources, extra) {
    const { text } = await ask(genPrompt(sources,
      `Create a practice test that checks real understanding of the materials, the way a teacher would test it: mostly "choice" questions, some "truefalse", and a few "open" ones. Mix easy recall with questions that require applying or connecting the knowledge. Usually 12 to 20 questions, more for long materials.\n\n${QUESTION_RULES}\n\n${QUIZ_FORMAT}`,
      extra));
    const quiz = parseQuiz(text);
    if (!quiz.length) throw new UserError("AI vrátila test v nečitelné podobě. Zkus to znovu.");
    return quiz;
  }

  async function gradeOpenAnswer(question, answer) {
    const { text } = await ask(`You grade a student's answer to a practice test question. Judge the substance, not the wording or spelling: "correct" if the key points of the model answer are there, "partial" if some are missing or partly wrong, "wrong" otherwise.\n\nOutput format: the first line is "VERDICT: " followed by correct, partial or wrong. Then one to three sentences of feedback addressed to the student in the language of the question (Czech by default): what was right, what was missing, and the correct answer if they missed it. Nothing else.\n\nQuestion: ${question.question}\n\nModel answer: ${question.answer}\n\nStudent's answer: ${answer}`);
    const m = text.match(/VERDICT:\s*(correct|partial|wrong)/i);
    return { verdict: m ? m[1].toLowerCase() : "wrong", feedback: text.replace(/^.*VERDICT:.*\n?/i, "").trim() };
  }

  const TRANSCRIBE = "You convert a student's uploaded study material (photos of handwritten or printed notes, slides, textbook or PDF pages) into clean text so it can be studied later without the original file.\n\nTranscribe everything in the attached image(s) faithfully and completely, in the original language, in page order. Do not summarize, skip, or add knowledge that is not in the material. Fix obvious OCR-level slips only when you are sure. Keep the structure with Markdown headings and lists. Write formulas in LaTeX ($...$ inline, $$...$$ on their own line). For diagrams, charts, maps, and pictures, write a short description of what they show in square brackets, including every label and value. If a part is illegible, mark it [nečitelné]. Output only the transcription, with no preface.";

  async function transcribe(file) {
    const per = Math.max(1, Math.min(limits.images?.maxCount || 1, 4));
    const parts = [];
    for (let i = 0; i < file.blobs.length; i += per) {
      const { text } = await ask(`${TRANSCRIBE}\n\nFile name: ${file.name}`, { images: file.blobs.slice(i, i + per) });
      parts.push(text.trim());
    }
    const text = parts.join("\n\n").trim();
    if (!text) throw new UserError(`Ze souboru „${file.name}“ se nepodařilo přečíst žádný text.`);
    return text;
  }

  // ---------- příjem souborů ----------
  async function readPdf(file) {
    if (!window.pdfjsLib) throw new UserError("Čtečka PDF se nenačetla. Obnov stránku, nebo vlož text ručně.");
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.blob.arrayBuffer()) }).promise;
    } catch {
      throw new UserError(`PDF „${file.name}“ se nepodařilo otevřít.`);
    }
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      let text = "";
      for (const item of content.items) text += item.str + (item.hasEOL ? "\n" : " ");
      pages.push(text.replace(/[ \t]+/g, " ").trim());
    }
    const text = pages.join("\n\n").trim();
    if (text.length >= pdf.numPages * 150) return { text };

    // Naskenované PDF bez textové vrstvy: stránky se vykreslí a přečte je AI jako obrázky.
    if (!limits.images) throw new UserError(`PDF „${file.name}“ je naskenované a obrázky tu AI číst nemůže. Vlož text ručně.`);
    if (pdf.numPages > 30) throw new UserError(`Naskenované PDF „${file.name}“ má přes 30 stran. Rozděl ho na menší části.`);
    const blobs = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1400 / base.width) });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      blobs.push(await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85)));
    }
    return { blobs };
  }

  async function intake(body) {
    const ready = [];
    const todo = [];
    const pasted = String(body.text || "").trim();
    if (pasted) ready.push({ id: newId(6), name: "Vložený text", kind: "text", text: pasted });

    for (const f of body.files || []) {
      const name = str(f.name, 120) || "soubor";
      const ext = name.toLowerCase().split(".").pop();
      if (f.type === "application/pdf" || ext === "pdf") {
        const out = await readPdf({ ...f, name });
        if (out.text) ready.push({ id: newId(6), name, kind: "pdf", text: out.text });
        else todo.push({ name, kind: "pdf", blobs: out.blobs });
      } else if (f.type.startsWith("image/")) {
        if (!limits.images) throw new UserError("V tomhle zobrazení nejde posílat AI obrázky. Vlož text nebo textové PDF.");
        todo.push({ name, kind: "image", blobs: [f.blob] });
      } else if (ext === "docx") {
        if (!window.mammoth) throw new UserError("Čtečka Wordu se nenačetla. Obnov stránku, nebo ulož soubor jako PDF.");
        const { value } = await mammoth.extractRawText({ arrayBuffer: await f.blob.arrayBuffer() });
        if (value.trim()) ready.push({ id: newId(6), name, kind: "docx", text: value.trim() });
      } else if (f.type.startsWith("text/") || ["txt", "md", "markdown", "csv", "tex"].includes(ext)) {
        const text = (await f.blob.text()).trim();
        if (text) ready.push({ id: newId(6), name, kind: "text", text });
      } else {
        throw new UserError(`Soubor „${name}“ neumím přečíst. Podporuji PDF, fotky, Word (.docx) a text.`);
      }
    }
    if (!ready.length && !todo.length) throw new UserError("Nahraj soubor nebo vlož text.");
    return { ready, todo };
  }

  const PARTS = ["notes", "flashcards", "quiz"];
  const sourceChars = (t) => t.sources.reduce((n, s) => n + s.text.length, 0);

  async function processTopic(t, { todo = [], parts = PARTS, extra = "" }, send) {
    const progress = { read: todo.length ? "run" : "done", notes: "wait", flashcards: "wait", quiz: "wait" };
    for (const p of PARTS) if (!parts.includes(p)) progress[p] = "skip";
    running.set(t.id, progress);
    const step = (key, state) => { progress[key] = state; send({ type: "progress", progress: { ...progress } }); };
    const errors = [];
    t.error = null;
    send({ type: "progress", progress: { ...progress } });

    try {
      // 1) fotky a naskenované stránky přepíše AI (po jednom souboru, ať se nevyčerpají souběžné dotazy)
      for (const f of todo) {
        try { t.sources.push({ id: newId(6), name: f.name, kind: f.kind, text: await transcribe(f) }); }
        catch (err) { errors.push(aiError(err)); }
      }
      if (!t.sources.length) throw new UserError(errors[0] || "Z materiálů se nepodařilo nic přečíst.");
      if (sourceChars(t) > MAX_SOURCE_CHARS) throw new UserError(`Materiály jsou moc dlouhé (${sourceChars(t).toLocaleString("cs-CZ")} znaků, limit je ${MAX_SOURCE_CHARS.toLocaleString("cs-CZ")}). Rozděl je do víc témat.`);
      await saveSources(t);
      await saveTopic(t); // téma existuje hned, i kdyby se stránka během generování zavřela
      step("read", "done");

      // 2) výpisky, kartičky a test souběžně
      const jobs = {
        notes: async () => { const out = await generateNotes(t.sources, extra); t.notes = out.markdown; if (!t.title) t.title = out.title.slice(0, 120); },
        flashcards: async () => { t.flashcards = await generateFlashcards(t.sources, extra); },
        quiz: async () => { t.quiz = await generateQuiz(t.sources, extra); },
      };
      await Promise.all(parts.map(async (part) => {
        step(part, "run");
        try { await jobs[part](); step(part, "done"); }
        catch (err) { errors.push(aiError(err)); step(part, "error"); }
      }));
    } catch (err) {
      errors.unshift(aiError(err));
    }

    if (!t.title) t.title = "Nové téma";
    t.error = errors.length ? [...new Set(errors)].join(" ") : null;
    running.delete(t.id);
    try { await saveTopic(t); } catch (err) { t.error = [t.error, aiError(err)].filter(Boolean).join(" "); }
    send({ type: "done", topic: forClient(t) });
  }

  // ---------- chat ----------
  const CHAT_SYSTEM = `You are the AI tutor inside a study app. A school student has uploaded their own notes for one topic and is preparing for a test. The app generated study notes (výpisky), flashcards, and a practice test from those materials; the student sees them next to this chat.

Explaining: when the student asks about something, explain it from the very beginning, assuming they do not understand it yet. Start with the plain-language idea, then build up step by step to what the materials say, defining each term the first time it appears and using a concrete everyday example or analogy. Tie the explanation back to how it could be asked on the test. Ground your answers in the student's materials; you may add general knowledge when it helps understanding, and say so when you go beyond what the materials contain, because the teacher's version is what will be tested. If the materials are wrong about something, tell the student. Keep answers as long as understanding needs and no longer; the student can always ask you to go deeper. When it would help, finish with one short question that checks whether they got it.

Notes format: Markdown with ## and ### headings; ==text== renders as a highlight; LaTeX formulas go in $...$ or $$...$$.

Style: reply in the language the student writes in (Czech by default), in a friendly, direct tone, like a good older classmate. Use Markdown, and LaTeX in $...$ for formulas.`;

  const EDITING = `Editing: you can change the notes, flashcards, and test with your tools, and you should do so whenever the student asks (shorten or expand the notes, highlight things, rewrite a section more simply, add, fix or delete flashcards, make the test harder, add questions on a subtopic, and so on). Make the change right away rather than describing what you would do; ask first only when the request is truly ambiguous. For small or local changes to the notes use edit_notes, and use replace_notes only for a rewrite of most of the text. After a change, tell the student in a sentence what you changed. The current state of everything is given below.

${QUESTION_RULES}
In tool input, a question is {type, question, options, correct_index, answer, explanation}: for "choice" give options and the 0-based correct_index; for "truefalse" correct_index is 0 if the statement is true and 1 if false; for "open" give the model answer in "answer".`;

  const NO_EDITING = "You cannot edit the notes, flashcards, or test in this view; if the student asks for a change, give them the new text in your reply so they can paste it in by hand.";

  const cardSchema = { type: "object", properties: { front: { type: "string" }, back: { type: "string" } }, required: ["front", "back"] };
  const questionProps = { type: { type: "string", enum: ["choice", "truefalse", "open"] }, question: { type: "string" }, options: { type: "array", items: { type: "string" } }, correct_index: { type: "integer" }, answer: { type: "string" }, explanation: { type: "string" } };
  const withId = (schema) => ({ ...schema, properties: { id: { type: "string" }, ...schema.properties }, required: ["id", ...schema.required] });
  const questionSchema = { type: "object", properties: questionProps, required: ["type", "question", "explanation"] };
  const list = (v) => (Array.isArray(v) ? v : []);

  function chatTools(t, on) {
    const did = (label) => { on.action(label); return label; };
    return [
      {
        name: "edit_notes",
        description: "Make targeted edits to the study notes by exact string replacement. Each `find` must match the current notes text exactly (including Markdown) and be long enough to be unique; only its first occurrence is replaced. Use for highlighting (wrap text in ==...==), fixing or rewording a passage, inserting or deleting a section. Returns how many edits applied.",
        inputSchema: { type: "object", properties: { edits: { type: "array", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] } } }, required: ["edits"] },
        execute(input) {
          const edits = list(input.edits).filter((e) => e && typeof e.find === "string" && e.find);
          if (!edits.length) throw new Error("No edits given.");
          const missed = [];
          for (const e of edits) {
            if (t.notes.includes(e.find)) t.notes = t.notes.replace(e.find, () => String(e.replace ?? ""));
            else missed.push(e.find.slice(0, 80));
          }
          if (missed.length < edits.length) did("Výpisky upraveny");
          return missed.length ? `Applied ${edits.length - missed.length} of ${edits.length} edits. Not found (text must match the notes exactly): ${JSON.stringify(missed)}` : `Applied all ${edits.length} edits.`;
        },
      },
      {
        name: "replace_notes",
        description: "Replace the entire study notes with new Markdown. Use when most of the text changes (shortening everything, restructuring). Returns a confirmation.",
        inputSchema: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
        execute(input) {
          const markdown = String(input.markdown || "").trim();
          if (!markdown) throw new Error("Empty notes.");
          t.notes = markdown;
          did("Výpisky přepsány");
          return "Notes replaced.";
        },
      },
      {
        name: "change_flashcards",
        description: "Change the flashcard deck: `add` new cards, `update` existing cards by id, `delete` cards by id. Set `replace_all` to true to discard the whole deck first and keep only the cards in `add` (resets learning progress; only when the student wants the deck redone). Returns what was changed and the ids of added cards.",
        inputSchema: { type: "object", properties: { add: { type: "array", items: cardSchema }, update: { type: "array", items: withId(cardSchema) }, delete: { type: "array", items: { type: "string" } }, replace_all: { type: "boolean" } } },
        execute(input) {
          const add = list(input.add).filter((c) => c && str(c.front, 5000) && str(c.back, 5000)).map(makeCard);
          const out = [];
          if (input.replace_all === true) {
            if (!add.length) throw new Error("replace_all needs cards in `add`.");
            t.flashcards = [];
            out.push("Deck cleared.");
          }
          const del = list(input.delete).map(String);
          if (del.length) { const before = t.flashcards.length; t.flashcards = t.flashcards.filter((c) => !del.includes(c.id)); out.push(`Deleted ${before - t.flashcards.length}.`); }
          let updated = 0;
          for (const c of list(input.update)) {
            const card = t.flashcards.find((x) => x.id === String(c?.id));
            if (card && str(c.front, 5000) && str(c.back, 5000)) { card.front = str(c.front, 5000); card.back = str(c.back, 5000); updated++; }
          }
          if (list(input.update).length) out.push(`Updated ${updated} of ${list(input.update).length}.`);
          if (add.length) { t.flashcards.push(...add); out.push(`Added ${add.length} cards with ids ${add.map((c) => c.id).join(", ")}.`); }
          if (!out.length) throw new Error("Nothing to change.");
          did(input.replace_all === true ? "Kartičky vytvořeny znovu" : "Kartičky upraveny");
          return out.join(" ");
        },
      },
      {
        name: "change_quiz",
        description: "Change the practice test: `add` new questions, `update` existing questions by id (give the complete new question), `delete` questions by id. Set `replace_all` to true to discard the whole test first and keep only the questions in `add`. Returns what was changed and the ids of added questions.",
        inputSchema: { type: "object", properties: { add: { type: "array", items: questionSchema }, update: { type: "array", items: withId(questionSchema) }, delete: { type: "array", items: { type: "string" } }, replace_all: { type: "boolean" } } },
        execute(input) {
          const add = list(input.add).map((q) => q && makeQuestion(q)).filter(Boolean);
          const out = [];
          if (input.replace_all === true) {
            if (!add.length) throw new Error("replace_all needs questions in `add`.");
            t.quiz = [];
            out.push("Test cleared.");
          }
          const del = list(input.delete).map(String);
          if (del.length) { const before = t.quiz.length; t.quiz = t.quiz.filter((q) => !del.includes(q.id)); out.push(`Deleted ${before - t.quiz.length}.`); }
          let updated = 0;
          for (const q of list(input.update)) {
            const i = t.quiz.findIndex((x) => x.id === String(q?.id));
            const made = i >= 0 && makeQuestion(q);
            if (made) { t.quiz[i] = { ...made, id: t.quiz[i].id }; updated++; }
          }
          if (list(input.update).length) out.push(`Updated ${updated} of ${list(input.update).length}.`);
          if (add.length) { t.quiz.push(...add); out.push(`Added ${add.length} questions with ids ${add.map((q) => q.id).join(", ")}.`); }
          if (!out.length) throw new Error("Nothing to change.");
          did(input.replace_all === true ? "Test vytvořen znovu" : "Test upraven");
          return out.join(" ");
        },
      },
    ];
  }

  function stateBlock(t) {
    const cards = t.flashcards.map(({ id, front, back }) => ({ id, front, back }));
    const quiz = t.quiz.map((q) => q.type === "open"
      ? { id: q.id, type: q.type, question: q.question, answer: q.answer, explanation: q.explanation }
      : { id: q.id, type: q.type, question: q.question, options: q.options, correct_index: q.correct, explanation: q.explanation });
    return `Topic: ${t.title}\n\n<notes>\n${t.notes || "(empty)"}\n</notes>\n\n<flashcards>\n${JSON.stringify(cards)}\n</flashcards>\n\n<quiz>\n${JSON.stringify(quiz)}\n</quiz>`;
  }

  async function chat(t, userText, send) {
    const canEdit = Boolean(limits.tools);
    const actions = [];
    const on = { action: (label) => { if (!actions.includes(label)) actions.push(label); send({ type: "action", label }); } };
    let tools = canEdit ? chatTools(t, on) : undefined;
    if (tools && limits.tools.maxCount < tools.length) tools = tools.slice(0, limits.tools.maxCount);
    // Po každém zásahu nástroje se změna hned ukáže na stránce.
    for (const tool of tools || []) {
      const run = tool.execute;
      tool.execute = (input) => { const result = run(input || {}); send({ type: "topic", topic: forClient(t) }); return result; };
    }

    const history = t.chat.slice(-24).map((m) => ({ role: m.role, content: m.text || (m.actions?.length ? `(${m.actions.join(", ")})` : "(bez textu)") }));
    while (history.length && history[0].role !== "user") history.shift();
    // Stránka nemá vlastní systémový prompt, takže zadání i materiály jdou jako první zpráva.
    const brief = `${CHAT_SYSTEM}\n\n${canEdit ? EDITING : NO_EDITING}\n\nThe student's original materials:\n\n${materialsBlock(t.sources)}\n\nCurrent state of the topic:\n\n${stateBlock(t)}\n\nThe conversation with the student follows.`;
    const input = [{ role: "user", content: brief }, { role: "assistant", content: "Rozumím, jsem připravený." }, ...history, { role: "user", content: userText }];

    let text = "";
    const options = { onText: (u) => { text = u.text; send({ type: "reset", text }); } };
    if (tools) options.tools = tools; else options.cache = false;
    try {
      const out = await ask(input, options);
      text = out.text;
    } catch (err) {
      // Co nástroje stihly změnit, zůstává; uloží se i při chybě.
      if (actions.length) await saveTopic(t).catch(() => {});
      throw Object.assign(err, { partial: err?.code === "refused" ? "" : text });
    }
    t.chat.push({ role: "user", text: userText }, { role: "assistant", text: text.trim(), actions });
    await saveTopic(t);
  }

  // ---------- „HTTP“ rozhraní pro app.js ----------
  const DAY = 86400000;
  const INTERVALS = [0, 1, 3, 7, 16, 35, 90];
  const notBusy = (t) => { if (running.has(t.id)) throw new UserError("Téma se právě zpracovává, chvilku vydrž."); };

  async function api(method, url, body = {}) {
    const [, a, id, b, sub] = url.split("/"); // "/topics/ID/sources/SID"
    const key = `${method} ${a}${id ? "/:id" : ""}${b ? "/" + b : ""}`;
    switch (key) {
      case "GET state": return stateForClient();
      case "POST subjects": {
        const name = str(body.name, 60);
        if (!name) throw new UserError("Zadej název předmětu.");
        const subject = { id: newId(), name, emoji: str(body.emoji, 8) || "📘", color: str(body.color, 20) || "#7c5cff" };
        index.subjects.push(subject);
        await saveIndex();
        return subject;
      }
      case "PATCH subjects/:id": {
        const s = need(index.subjects.find((x) => x.id === id));
        s.name = str(body.name, 60) || s.name;
        s.emoji = str(body.emoji, 8) || s.emoji;
        s.color = str(body.color, 20) || s.color;
        await saveIndex();
        return s;
      }
      case "DELETE subjects/:id": {
        const gone = index.topics.filter((t) => t.subjectId === id).map((t) => t.id);
        index.topics = index.topics.filter((t) => t.subjectId !== id);
        index.subjects = index.subjects.filter((s) => s.id !== id);
        await saveIndex();
        for (const tid of gone) { topics.delete(tid); col.doc("t_" + tid).delete().catch(() => {}); col.doc("s_" + tid).delete().catch(() => {}); }
        return { ok: true };
      }
      case "GET topics/:id": return forClient(await getTopic(id));
      case "PATCH topics/:id": {
        const t = await getTopic(id);
        if (body.title !== undefined) t.title = str(body.title, 120) || t.title;
        if (body.testDate !== undefined) t.testDate = str(body.testDate, 10) || null;
        if (typeof body.notes === "string") t.notes = body.notes;
        if (Array.isArray(body.flashcards)) {
          t.flashcards = body.flashcards.filter((c) => str(c.front, 5000) && str(c.back, 5000)).map((c) => {
            const old = t.flashcards.find((x) => x.id === c.id);
            return { id: old?.id || newId(6), front: str(c.front, 5000), back: str(c.back, 5000), box: old?.box || 0, due: old?.due || 0 };
          });
        }
        if (Array.isArray(body.deleteQuestions)) t.quiz = t.quiz.filter((q) => !body.deleteQuestions.includes(q.id));
        await saveTopic(t);
        return forClient(t);
      }
      case "DELETE topics/:id": {
        index.topics = index.topics.filter((t) => t.id !== id);
        topics.delete(id);
        await saveIndex();
        col.doc("t_" + id).delete().catch(() => {});
        col.doc("s_" + id).delete().catch(() => {});
        return { ok: true };
      }
      case "DELETE topics/:id/sources": {
        const t = await getTopic(id);
        t.sources = t.sources.filter((s) => s.id !== sub);
        await saveSources(t);
        return forClient(t);
      }
      case "DELETE topics/:id/chat": {
        const t = await getTopic(id);
        t.chat = [];
        await saveTopic(t);
        return { ok: true };
      }
      case "POST topics/:id/review": {
        const t = await getTopic(id);
        const card = need(t.flashcards.find((c) => c.id === body.cardId), "Kartička neexistuje.");
        card.box = body.known ? Math.min((card.box || 0) + 1, INTERVALS.length - 1) : 0;
        card.due = body.known ? Date.now() + INTERVALS[card.box] * DAY : 0;
        saveTopic(t).catch((err) => console.error(err));
        return { card: { ...card }, due: dueCount(t) };
      }
      case "POST topics/:id/grade": {
        const t = await getTopic(id);
        const q = need(t.quiz.find((x) => x.id === body.questionId && x.type === "open"), "Otázka neexistuje.");
        const answer = str(body.answer, 4000);
        if (!answer) return { verdict: "wrong", feedback: "Bez odpovědi. Správně: " + q.answer };
        try { return await gradeOpenAnswer(q, answer); } catch (err) { throw new UserError(aiError(err)); }
      }
      case "POST topics/:id/attempts": {
        const t = await getTopic(id);
        t.attempts.push({ at: Date.now(), score: Number(body.score), total: Number(body.total), wrong: (body.wrong || []).slice(0, 200).map(String) });
        t.attempts = t.attempts.slice(-30);
        await saveTopic(t);
        return forClient(t);
      }
    }
    throw new UserError("Neznámá akce.");
  }

  async function stream(url, body, send) {
    const [, , id, action] = url.split("/");
    if (!id) { // POST /topics
      need(index.subjects.find((s) => s.id === body.subjectId), "Předmět neexistuje.");
      const { ready, todo } = await intake(body);
      const t = { id: newId(), subjectId: body.subjectId, title: str(body.title, 120), testDate: str(body.testDate, 10) || null, createdAt: Date.now(), error: null, sources: ready, notes: "", flashcards: [], quiz: [], attempts: [], chat: [] };
      topics.set(t.id, t);
      running.set(t.id, {});
      index.topics.push(summary(t));
      send({ type: "created", id: t.id });
      return processTopic(t, { todo, extra: str(body.instructions, 2000) }, send);
    }
    const t = await getTopic(id);
    notBusy(t);
    if (action === "sources") {
      const { ready, todo } = await intake(body);
      t.sources.push(...ready);
      return processTopic(t, { todo, parts: body.regenerate ? PARTS : [] }, send);
    }
    if (action === "generate") {
      if (!t.sources.length) throw new UserError("Téma nemá žádné materiály.");
      return processTopic(t, { parts: PARTS.filter((p) => (body.parts || PARTS).includes(p)), extra: str(body.instructions, 2000) }, send);
    }
    if (action === "chat") {
      const text = str(body.message, 8000);
      if (!text) throw new UserError("Napiš zprávu.");
      if (chatting.has(id)) throw new UserError("AI ještě odpovídá na předchozí zprávu.");
      chatting.add(id);
      try {
        await chat(t, text, send);
        send({ type: "done", topic: forClient(t) });
      } catch (err) {
        if (typeof err.partial === "string") send({ type: "reset", text: err.partial });
        send({ type: "error", message: aiError(err), topic: forClient(t) });
      } finally {
        chatting.delete(id);
      }
      return;
    }
    throw new UserError("Neznámá akce.");
  }

  async function boot() {
    if (!window.claude?.use) throw new Error("Tahle stránka funguje jen otevřená v Claude (claude.ai).");
    const [d, user, s] = await Promise.all(["db", "user", "sample"].map((n) => window.claude.use(n)));
    if (!d || !user) throw new Error("Nepodařilo se připojit k úložišti. Otevři stránku přihlášený v Claude a zkus to znovu.");
    const uid = await user.id();
    if (!uid) throw new Error("Nepodařilo se zjistit, kdo je přihlášený. Přihlas se do Claude a obnov stránku.");
    db = d;
    sample = s;
    col = db.collection("data/users/" + uid);
    limits = sample ? await sample.limits().catch(() => ({})) : {};
    const snap = await withTimeout(col.doc("index").get(), 15000, "Načítání dat trvá moc dlouho. Zkus to znovu.");
    if (snap.exists) index = { subjects: [], topics: [], ...clone(snap.data()) };
    if (window.pdfjsLib && window.pdfjsWorker) pdfjsLib.GlobalWorkerOptions.workerSrc = "about:blank"; // běží v hlavním vlákně
    return { needsPassword: false, aiReady: Boolean(sample), model: "", local: true };
  }

  const wrap = (fn) => async (...args) => {
    try { return await fn(...args); }
    catch (err) { throw err instanceof UserError ? err : new Error(err?.code ? aiError(err) : err?.message || "Něco se pokazilo."); }
  };
  return { boot, api: wrap(api), stream: wrap(stream) };
})();
