// Všechno volání Claude API: přepis materiálů, generování výpisků/kartiček/testu,
// chat s nástroji pro úpravy a hodnocení otevřených odpovědí.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { newId } from "./store.js";

export const MODEL = process.env.MODEL || "claude-opus-5-5";
const EFFORT = process.env.EFFORT || "medium";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
// Když model požadavek odmítne (např. bezpečnostní filtr u biologie/chemie),
// API ho samo zkusí na záložním modelu. Vypnutí: AI_FALLBACKS=0.
let useFallbacks = process.env.AI_FALLBACKS !== "0";

let client = null;
export function aiReady() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
function getClient() {
  if (!aiReady()) throw new UserError("Na serveru chybí ANTHROPIC_API_KEY. Doplň ho do souboru .env a restartuj server.");
  client ??= new Anthropic({ maxRetries: 3 });
  return client;
}

export class UserError extends Error {}

export function friendlyError(err) {
  if (err instanceof UserError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "Neplatný API klíč (ANTHROPIC_API_KEY).";
  if (err instanceof Anthropic.PermissionDeniedError) return "API klíč nemá k tomuto modelu přístup.";
  if (err instanceof Anthropic.RateLimitError) return "Příliš mnoho požadavků najednou. Zkus to za chvíli.";
  if (err instanceof Anthropic.BadRequestError) return "AI požadavek odmítla (možná je materiál moc dlouhý): " + err.message;
  if (err instanceof Anthropic.APIConnectionError) return "Nepodařilo se spojit s AI. Zkontroluj připojení serveru k internetu.";
  if (err instanceof Anthropic.APIError) return `Chyba AI služby (${err.status ?? "?"}). Zkus to znovu.`;
  console.error(err);
  return "Něco se pokazilo: " + (err?.message || "neznámá chyba");
}

// Jedno streamované volání. Vrací hotovou zprávu; text průběžně posílá do onText.
async function run(params, { onText, schema } = {}) {
  const c = getClient();
  const attempt = (withFallbacks) => {
    const output_config = { effort: EFFORT, ...params.output_config };
    if (schema) output_config.format = withFallbacks ? betaZodOutputFormat(schema) : zodOutputFormat(schema);
    const body = { model: MODEL, max_tokens: 64000, ...params, output_config };
    const stream = withFallbacks
      ? c.beta.messages.stream({ ...body, betas: [FALLBACK_BETA], fallbacks: "default" })
      : c.messages.stream(body);
    if (onText) stream.on("text", onText);
    return stream.finalMessage();
  };

  let message;
  if (useFallbacks) {
    try {
      message = await attempt(true);
    } catch (err) {
      // Účet nebo model bez podpory záložních modelů: zkusit bez nich a zapamatovat si to.
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      message = await attempt(false);
      useFallbacks = false;
      console.warn("Záložní modely nejsou dostupné, pokračuji bez nich:", err.message);
    }
  } else {
    message = await attempt(false);
  }

  if (message.stop_reason === "refusal") {
    throw new UserError("AI tento požadavek odmítla zpracovat. Zkus ho přeformulovat nebo materiál rozdělit.");
  }
  return message;
}

const textOf = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("");

async function runJson(params, schema) {
  const message = await run(params, { schema });
  if (message.stop_reason === "max_tokens") throw new UserError("Výstup byl příliš dlouhý. Rozděl materiál do víc témat.");
  try {
    return schema.parse(JSON.parse(textOf(message)));
  } catch {
    throw new UserError("AI vrátila nečitelný výstup. Zkus to znovu.");
  }
}

// ---------- Přepis nahraných souborů (PDF, fotky zápisů) na text ----------

const TRANSCRIBE_SYSTEM = `You convert a student's uploaded study material (PDF pages or photos of handwritten/printed notes, slides, textbook pages) into clean text so it can be studied later without the original file.

Transcribe everything faithfully and completely, in the original language. Do not summarize, skip, or add knowledge that is not in the material. Fix obvious OCR-level slips only when you are sure. Keep the structure with Markdown headings and lists. Write formulas in LaTeX ($...$ inline, $$...$$ on their own line). For diagrams, charts, maps, and pictures, write a short description of what they show in square brackets, including every label and value. If a part is illegible, mark it [nečitelné]. Output only the transcription, with no preface.`;

export async function transcribe(file) {
  const isPdf = file.type === "application/pdf";
  const block = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data } }
    : { type: "image", source: { type: "base64", media_type: file.type, data: file.data } };
  const message = await run({
    system: TRANSCRIBE_SYSTEM,
    messages: [{ role: "user", content: [block, { type: "text", text: `Transcribe this material (file name: ${file.name}).` }] }],
  });
  const text = textOf(message).trim();
  if (!text) throw new UserError(`Ze souboru „${file.name}“ se nepodařilo přečíst žádný text.`);
  return text;
}

// ---------- Generování ----------

const LANG_RULE = `Write in the language of the materials (Czech unless they are clearly in another language; for foreign-language subjects keep the studied language for the vocabulary/examples and explain in Czech).`;

const NOTES_FORMAT = `Notes format: Markdown. Use ## and ### headings, short bullet points, numbered steps for procedures, and tables for comparisons. Mark the terms, definitions, dates, and formulas most likely to be tested with ==double equals highlights== (sparingly, so they stand out). Write formulas in LaTeX: $...$ inline, $$...$$ on a separate line. No top-level # heading and no preface.`;

const QUESTION_RULES = `Question types:
- "choice": 4 options in "options", exactly one correct, "correct_index" is its 0-based position. Wrong options must be plausible. Vary the position of the correct option.
- "truefalse": a statement in "question"; "options" is empty; "correct_index" is 0 if the statement is true, 1 if false.
- "open": a question answered in one to three sentences or a short calculation; "options" is empty, "correct_index" is -1, and "answer" holds the model answer.
For "choice" and "truefalse" leave "answer" as an empty string. "explanation" always says briefly why the right answer is right, so the student learns from a mistake.`;

const materialsBlock = (sources) =>
  sources.map((s) => `<material name=${JSON.stringify(s.name)}>\n${s.text}\n</material>`).join("\n\n");

function genRequest(sources, task, extra) {
  return {
    system: [
      { type: "text", text: `You are an expert tutor preparing a school student for a test, working only from the student's own uploaded materials. Cover everything in the materials that could be tested; do not invent facts beyond them, though you may correct clear errors and fill a gap that is needed for the rest to make sense. ${LANG_RULE}` },
      // Stejné materiály se čtou třikrát za sebou (výpisky, kartičky, test) a pak v chatu, proto cache.
      { type: "text", text: `The student's materials:\n\n${materialsBlock(sources)}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: task + (extra ? `\n\nThe student's extra instructions: ${extra}` : "") }],
  };
}

const NotesSchema = z.object({ title: z.string(), markdown: z.string() });
const CardsSchema = z.object({ cards: z.array(z.object({ front: z.string(), back: z.string() })) });
const QuestionSchema = z.object({
  type: z.enum(["choice", "truefalse", "open"]),
  question: z.string(),
  options: z.array(z.string()),
  correct_index: z.number(),
  answer: z.string(),
  explanation: z.string(),
});
const QuizSchema = z.object({ questions: z.array(QuestionSchema) });

export async function generateNotes(sources, extra) {
  return runJson(genRequest(sources,
    `Write study notes (výpisky) from the materials: everything needed for the test, organized so it is easy to learn, far shorter than the source but with nothing testable left out. End with a short "Shrnutí" section of the handful of points to remember, and add a memory aid where one genuinely helps.\n\n${NOTES_FORMAT}\n\nAlso return "title": a short topic title (at most 6 words) naming what the materials cover.`,
    extra), NotesSchema);
}

export async function generateFlashcards(sources, extra) {
  const out = await runJson(genRequest(sources,
    `Create flashcards covering all the testable knowledge in the materials: terms and definitions, facts, dates, formulas, causes and effects, procedures. One fact per card. "front" is a specific question or prompt; "back" is the shortest complete answer. Make as many cards as the content needs (usually 15 to 40). Inline LaTeX ($...$) is allowed for formulas.`,
    extra), CardsSchema);
  return out.cards.map(makeCard);
}

export async function generateQuiz(sources, extra) {
  const out = await runJson(genRequest(sources,
    `Create a practice test that checks real understanding of the materials, the way a teacher would test it: mostly "choice" questions, some "truefalse", and a few "open" ones. Mix easy recall with questions that require applying or connecting the knowledge. Usually 12 to 20 questions, more for long materials.\n\n${QUESTION_RULES}`,
    extra), QuizSchema);
  return out.questions.map(makeQuestion);
}

export const makeCard = (c) => ({ id: newId(6), front: String(c.front).trim(), back: String(c.back).trim(), box: 0, due: 0 });

export function makeQuestion(q) {
  const base = { id: newId(6), type: q.type, question: String(q.question).trim(), explanation: String(q.explanation || "").trim() };
  if (q.type === "truefalse") {
    return { ...base, options: ["Pravda", "Nepravda"], correct: q.correct_index === 1 ? 1 : 0 };
  }
  if (q.type === "choice") {
    const options = (q.options || []).map((o) => String(o).trim()).filter(Boolean);
    if (options.length >= 2) {
      const correct = Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index < options.length ? q.correct_index : 0;
      return { ...base, options, correct };
    }
  }
  return { ...base, type: "open", answer: String(q.answer || "").trim() };
}

// ---------- Hodnocení otevřené odpovědi ----------

const GradeSchema = z.object({ verdict: z.enum(["correct", "partial", "wrong"]), feedback: z.string() });

export async function gradeOpenAnswer(question, studentAnswer) {
  return runJson({
    system: `You grade a student's answer to a practice test question. Judge the substance, not the wording or spelling: "correct" if the key points of the model answer are there, "partial" if some are missing or partly wrong, "wrong" otherwise. "feedback" is one to three sentences addressed to the student in the language of the question (Czech by default): what was right, what was missing, and the correct answer if they missed it.`,
    messages: [{ role: "user", content: `Question: ${question.question}\n\nModel answer: ${question.answer}\n\nStudent's answer: ${studentAnswer}` }],
    output_config: { effort: "low" },
    max_tokens: 4000,
  }, GradeSchema);
}

// ---------- Chat „Zeptej se AI“ s nástroji pro úpravy ----------

const CHAT_SYSTEM = `You are the AI tutor inside a study app. A school student has uploaded their own notes for one topic and is preparing for a test. The app generated study notes (výpisky), flashcards, and a practice test from those materials; the student sees them next to this chat.

Explaining: when the student asks about something, explain it from the very beginning, assuming they do not understand it yet. Start with the plain-language idea, then build up step by step to what the materials say, defining each term the first time it appears and using a concrete everyday example or analogy. Tie the explanation back to how it could be asked on the test. Ground your answers in the student's materials; you may add general knowledge when it helps understanding, and say so when you go beyond what the materials contain, because the teacher's version is what will be tested. If the materials are wrong about something, tell the student. Keep answers as long as understanding needs and no longer; the student can always ask you to go deeper. When it would help, finish with one short question that checks whether they got it.

Editing: you can change the notes, flashcards, and test with your tools, and you should do so whenever the student asks (shorten or expand the notes, highlight things, rewrite a section more simply, add, fix or delete flashcards, make the test harder, add questions on a subtopic, and so on). Make the change right away rather than describing what you would do; ask first only when the request is truly ambiguous. For small or local changes to the notes use edit_notes, and use replace_notes only for a rewrite of most of the text. After a change, tell the student in a sentence what you changed. The current state of everything is given below and is always up to date.

Notes format: Markdown with ## and ### headings; ==text== renders as a highlight; LaTeX formulas go in $...$ or $$...$$.

${QUESTION_RULES}

Style: reply in the language the student writes in (Czech by default), in a friendly, direct tone, like a good older classmate. Use Markdown, and LaTeX in $...$ for formulas.`;

const cardIn = z.object({ front: z.string().min(1), back: z.string().min(1) });
const cardProps = { front: { type: "string", description: "Question or prompt" }, back: { type: "string", description: "Answer" } };
const questionProps = {
  type: { type: "string", enum: ["choice", "truefalse", "open"] },
  question: { type: "string" },
  options: { type: "array", items: { type: "string" } },
  correct_index: { type: "integer" },
  answer: { type: "string" },
  explanation: { type: "string" },
};
const questionJson = { type: "object", properties: questionProps, required: Object.keys(questionProps) };
const cardJson = { type: "object", properties: cardProps, required: ["front", "back"] };
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties) });
const idsJson = { type: "array", items: { type: "string" } };

// Každý nástroj: popis pro model, schéma, validace vstupu (zod) a provedení nad tématem.
const TOOLS = [
  {
    name: "edit_notes",
    description: "Make targeted edits to the study notes by exact string replacement. Each `find` must match the current notes text exactly (including Markdown) and should be long enough to be unique; only its first occurrence is replaced. Use for highlighting (wrap text in ==...==), fixing or rewording a passage, inserting or deleting a section.",
    input_schema: obj({ edits: { type: "array", items: obj({ find: { type: "string" }, replace: { type: "string" } }) } }),
    zod: z.object({ edits: z.array(z.object({ find: z.string().min(1), replace: z.string() })).min(1) }),
    label: "Výpisky upraveny",
    exec(topic, { edits }) {
      let notes = topic.notes || "";
      const missed = [];
      for (const e of edits) {
        if (notes.includes(e.find)) notes = notes.replace(e.find, () => e.replace);
        else missed.push(e.find.slice(0, 80));
      }
      topic.notes = notes;
      return missed.length
        ? `Applied ${edits.length - missed.length} of ${edits.length} edits. Not found (text must match the notes exactly): ${JSON.stringify(missed)}`
        : `Applied all ${edits.length} edits.`;
    },
  },
  {
    name: "replace_notes",
    description: "Replace the entire study notes with new Markdown. Use when most of the text changes (e.g. shortening everything, restructuring).",
    input_schema: obj({ markdown: { type: "string" } }),
    zod: z.object({ markdown: z.string().min(1) }),
    label: "Výpisky přepsány",
    exec(topic, { markdown }) {
      topic.notes = markdown;
      return "Notes replaced.";
    },
  },
  {
    name: "add_flashcards",
    description: "Add new flashcards to the deck.",
    input_schema: obj({ cards: { type: "array", items: cardJson } }),
    zod: z.object({ cards: z.array(cardIn).min(1) }),
    label: "Kartičky přidány",
    exec(topic, { cards }) {
      const added = cards.map(makeCard);
      topic.flashcards.push(...added);
      return `Added ${added.length} cards with ids ${added.map((c) => c.id).join(", ")}.`;
    },
  },
  {
    name: "update_flashcards",
    description: "Change the text of existing flashcards, identified by id.",
    input_schema: obj({ cards: { type: "array", items: { type: "object", properties: { id: { type: "string" }, ...cardProps }, required: ["id", "front", "back"] } } }),
    zod: z.object({ cards: z.array(cardIn.extend({ id: z.string() })).min(1) }),
    label: "Kartičky upraveny",
    exec(topic, { cards }) {
      const missing = [];
      for (const c of cards) {
        const card = topic.flashcards.find((x) => x.id === c.id);
        if (card) Object.assign(card, { front: c.front.trim(), back: c.back.trim() });
        else missing.push(c.id);
      }
      return missing.length ? `Updated ${cards.length - missing.length}. Unknown ids: ${missing.join(", ")}` : `Updated ${cards.length} cards.`;
    },
  },
  {
    name: "delete_flashcards",
    description: "Delete flashcards by id.",
    input_schema: obj({ ids: idsJson }),
    zod: z.object({ ids: z.array(z.string()).min(1) }),
    label: "Kartičky smazány",
    exec(topic, { ids }) {
      const before = topic.flashcards.length;
      topic.flashcards = topic.flashcards.filter((c) => !ids.includes(c.id));
      return `Deleted ${before - topic.flashcards.length} cards.`;
    },
  },
  {
    name: "replace_flashcards",
    description: "Replace the whole flashcard deck with a new one (learning progress is reset). Use only when the student wants the deck redone.",
    input_schema: obj({ cards: { type: "array", items: cardJson } }),
    zod: z.object({ cards: z.array(cardIn).min(1) }),
    label: "Kartičky vytvořeny znovu",
    exec(topic, { cards }) {
      topic.flashcards = cards.map(makeCard);
      return `Deck replaced with ${cards.length} cards.`;
    },
  },
  {
    name: "add_quiz_questions",
    description: "Add questions to the practice test.",
    input_schema: obj({ questions: { type: "array", items: questionJson } }),
    zod: z.object({ questions: z.array(QuestionSchema).min(1) }),
    label: "Otázky přidány do testu",
    exec(topic, { questions }) {
      const added = questions.map(makeQuestion);
      topic.quiz.push(...added);
      return `Added ${added.length} questions with ids ${added.map((q) => q.id).join(", ")}.`;
    },
  },
  {
    name: "update_quiz_questions",
    description: "Rewrite existing test questions, identified by id. Provide the complete new question.",
    input_schema: obj({ questions: { type: "array", items: { type: "object", properties: { id: { type: "string" }, ...questionProps }, required: ["id", ...Object.keys(questionProps)] } } }),
    zod: z.object({ questions: z.array(QuestionSchema.extend({ id: z.string() })).min(1) }),
    label: "Otázky v testu upraveny",
    exec(topic, { questions }) {
      const missing = [];
      for (const q of questions) {
        const i = topic.quiz.findIndex((x) => x.id === q.id);
        if (i >= 0) topic.quiz[i] = { ...makeQuestion(q), id: q.id };
        else missing.push(q.id);
      }
      return missing.length ? `Updated ${questions.length - missing.length}. Unknown ids: ${missing.join(", ")}` : `Updated ${questions.length} questions.`;
    },
  },
  {
    name: "delete_quiz_questions",
    description: "Delete test questions by id.",
    input_schema: obj({ ids: idsJson }),
    zod: z.object({ ids: z.array(z.string()).min(1) }),
    label: "Otázky z testu smazány",
    exec(topic, { ids }) {
      const before = topic.quiz.length;
      topic.quiz = topic.quiz.filter((q) => !ids.includes(q.id));
      return `Deleted ${before - topic.quiz.length} questions.`;
    },
  },
  {
    name: "replace_quiz",
    description: "Replace the whole practice test with a new set of questions. Use when the student wants a new or differently pitched test.",
    input_schema: obj({ questions: { type: "array", items: questionJson } }),
    zod: z.object({ questions: z.array(QuestionSchema).min(1) }),
    label: "Test vytvořen znovu",
    exec(topic, { questions }) {
      topic.quiz = questions.map(makeQuestion);
      return `Test replaced with ${questions.length} questions.`;
    },
  },
];

const apiTools = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema, eager_input_streaming: true }));

function stateBlock(topic) {
  const cards = topic.flashcards.map(({ id, front, back }) => ({ id, front, back }));
  const quiz = topic.quiz.map((q) =>
    q.type === "open"
      ? { id: q.id, type: q.type, question: q.question, answer: q.answer, explanation: q.explanation }
      : { id: q.id, type: q.type, question: q.question, options: q.options, correct_index: q.correct, explanation: q.explanation });
  return `Topic: ${topic.title}\n\n<notes>\n${topic.notes || "(empty)"}\n</notes>\n\n<flashcards>\n${JSON.stringify(cards)}\n</flashcards>\n\n<quiz>\n${JSON.stringify(quiz)}\n</quiz>`;
}

/**
 * Jedno kolo chatu. Upravuje `topic` na místě přes nástroje.
 * on.text(delta), on.action(label), on.changed() po každé úpravě.
 * Vrací { text, actions }.
 */
export async function chat(topic, userText, on) {
  const history = (topic.chat || []).slice(-30).map((m) => ({
    role: m.role,
    content: m.text || (m.actions?.length ? `(${m.actions.join(", ")})` : "(bez textu)"),
  }));
  // Historie musí začínat zprávou uživatele.
  while (history.length && history[0].role !== "user") history.shift();
  const messages = [...history, { role: "user", content: userText }];

  let fullText = "";
  const actions = [];
  let jsonRetries = 0;

  for (let turn = 0; turn < 10; turn++) {
    const system = [
      { type: "text", text: CHAT_SYSTEM },
      { type: "text", text: `The student's original materials:\n\n${materialsBlock(topic.sources)}`, cache_control: { type: "ephemeral" } },
      { type: "text", text: `Current state of the topic:\n\n${stateBlock(topic)}` },
    ];

    let sentThisTurn = "";
    let message;
    try {
      message = await run({ system, messages, tools: apiTools }, {
        onText: (delta) => {
          sentThisTurn += delta;
          on.text(delta);
        },
      });
      jsonRetries = 0;
    } catch (err) {
      // Nečitelný vstup nástroje (ne chyba API): zkusit kolo znovu.
      if (err instanceof Anthropic.APIError || err instanceof UserError || jsonRetries++ >= 2) throw err;
      if (sentThisTurn) on.reset?.(fullText);
      continue;
    }

    if (sentThisTurn) fullText += (fullText && !fullText.endsWith("\n") ? "\n\n" : "") + sentThisTurn;
    if (sentThisTurn && message.stop_reason === "tool_use") on.text("\n\n");

    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: message.content });
    const results = [];
    for (const use of toolUses) {
      const tool = TOOLS.find((t) => t.name === use.name);
      const parsed = tool?.zod.safeParse(use.input);
      if (!tool || !parsed.success) {
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: tool ? `Invalid input: ${parsed.error.message}` : "Unknown tool" });
        continue;
      }
      const content = tool.exec(topic, parsed.data);
      if (!actions.includes(tool.label)) actions.push(tool.label);
      on.action(tool.label);
      results.push({ type: "tool_result", tool_use_id: use.id, content });
    }
    on.changed();
    messages.push({ role: "user", content: results });
  }

  return { text: fullText.trim(), actions };
}
