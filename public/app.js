/* Studovna – frontend bez build kroku. Stav v objektu S, překreslování přes render(). */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* soukromé okno */ } },
};

const S = {
  config: null,
  profiles: [], subjects: [], topics: [],
  profileId: store.get("profile"),
  topic: null,        // plně načtené aktuální téma
  streaming: null,    // id tématu, jehož zpracování právě sledujeme přes stream
  notesEdit: false,
  study: null,
  quiz: null,
  chatOpen: false,
  sending: false,
};

const COLORS = ["#7c5cff", "#ff5c8a", "#ff8a3d", "#f2b900", "#17a673", "#12a5c9", "#3d7bff", "#8a8fa3"];
const EMOJIS = ["📘", "🧮", "🧪", "🧬", "🌍", "📜", "⚛️", "💻", "🇬🇧", "🇩🇪", "✍️", "🎨", "🎵", "⚖️", "💰", "🏃", "🧠", "🔭", "📐", "🗣️"];

// ---------- markdown + vzorce ----------
function md(text, inline = false) {
  const math = [];
  const stash = (tex, display) => { math.push({ tex, display }); return `@@M${math.length - 1}@@`; };
  let src = String(text ?? "")
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, t) => stash(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, t) => stash(t, true))
    .replace(/\\\((.+?)\\\)/g, (m, t) => stash(t, false))
    .replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (m, t) => stash(t, false))
    .replace(/==(?=\S)([^\n]+?)(?<=\S)==/g, "<mark>$1</mark>");
  let html = inline ? marked.parseInline(src, { gfm: true, breaks: true }) : marked.parse(src, { gfm: true, breaks: true });
  html = DOMPurify.sanitize(html);
  return html.replace(/@@M(\d+)@@/g, (m, i) => {
    const { tex, display } = math[i];
    try { return katex.renderToString(tex, { displayMode: display, throwOnError: false }); }
    catch { return esc(tex); }
  });
}

// ---------- API ----------
const headers = () => ({ "Content-Type": "application/json", "x-app-password": store.get("password") || "" });

async function api(method, url, body) {
  let res;
  try {
    res = await fetch("/api" + url, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("Server neodpovídá. Zkontroluj připojení.");
  }
  if (res.status === 401) { store.set("password", null); renderLogin(); throw new Error("Přihlas se heslem."); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "Něco se pokazilo.");
  return out;
}

// POST, na který server odpovídá proudem událostí (průběh generování, text chatu).
async function stream(url, body, onEvent) {
  let res;
  try {
    res = await fetch("/api" + url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  } catch {
    throw new Error("Server neodpovídá. Zkontroluj připojení.");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Něco se pokazilo.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (chunk.startsWith("data: ")) onEvent(JSON.parse(chunk.slice(6)));
    }
  }
}

async function refresh() {
  Object.assign(S, await api("GET", "/state"));
}

// ---------- drobnosti UI ----------
function toast(text, bad = false) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 2600);
}
const fail = (err) => toast(err.message || String(err), true);

function modal(html, onMount) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `<div class="modal card" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  overlay.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  $("#modals").append(overlay);
  onMount?.(overlay, close);
  (overlay.querySelector("[autofocus]") || overlay.querySelector("input, textarea, button"))?.focus();
  return close;
}

function confirmBox(text, yes = "Smazat") {
  return new Promise((resolve) => {
    modal(`<h2>${esc(text)}</h2><div class="modal-foot"><button class="btn" data-close>Zrušit</button><button class="btn bad" data-yes>${esc(yes)}</button></div>`, (el, close) => {
      el.querySelector("[data-yes]").onclick = () => { resolve(true); close(); };
    });
  });
}

// fields: [{name, label, value, type: text|textarea|date, placeholder, hint, optional}]
function formBox(title, fields, submit = "Uložit") {
  return new Promise((resolve) => {
    const inputs = fields.map((f) => `
      <label class="field"><span>${esc(f.label)} ${f.hint ? `<em>${esc(f.hint)}</em>` : ""}</span>
      ${f.type === "textarea"
        ? `<textarea class="input" name="${f.name}" placeholder="${esc(f.placeholder || "")}" rows="${f.rows || 4}">${esc(f.value || "")}</textarea>`
        : `<input class="input" type="${f.type || "text"}" name="${f.name}" value="${esc(f.value || "")}" placeholder="${esc(f.placeholder || "")}" ${f.optional ? "" : "required"}>`}
      </label>`).join("");
    modal(`<form><h2>${esc(title)}</h2>${inputs}<div class="modal-foot"><button type="button" class="btn" data-close>Zrušit</button><button class="btn primary">${esc(submit)}</button></div></form>`, (el, close) => {
      el.querySelector("form").onsubmit = (e) => {
        e.preventDefault();
        resolve(Object.fromEntries(new FormData(e.target)));
        close();
      };
    });
  });
}

const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
const profile = () => S.profiles.find((p) => p.id === S.profileId);
const initial = (name) => esc((name || "?").trim()[0].toUpperCase());
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function testChip(date) {
  if (!date) return "";
  const days = Math.ceil((new Date(date + "T00:00") - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days < 0) return "";
  const label = days === 0 ? "Test dnes!" : days === 1 ? "Test zítra" : `Test za ${plural(days, "den", "dny", "dní")}`;
  return `<span class="chip ${days <= 2 ? "bad" : days <= 6 ? "warn" : ""}">📅 ${label}</span>`;
}

// ---------- směrování ----------
const route = () => { const [view, id, tab] = location.hash.replace(/^#\/?/, "").split("/"); return { view, id, tab }; };
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
addEventListener("hashchange", () => { S.study = null; S.quiz = null; S.notesEdit = false; S.chatOpen = false; render(); });

function topbar(crumbs = "") {
  const p = profile();
  return `<header class="topbar">
    <a class="logo" href="#/"><i>🎓</i><span>Studovna</span></a>
    <nav class="crumbs">${crumbs}</nav>
    <span class="spacer"></span>
    <button class="icon-btn" data-act="theme" title="Světlý / tmavý režim">🌓</button>
    ${p ? `<button class="avatar" style="background:${esc(p.color)}" data-act="switch-profile" title="Přepnout profil (${esc(p.name)})">${initial(p.name)}</button>` : ""}
  </header>`;
}
const aiBanner = () => S.config.aiReady ? "" : `<div class="banner bad">AI není připojená: na serveru chybí <b>ANTHROPIC_API_KEY</b>. Doplň ho do souboru <code>.env</code> a restartuj server.</div>`;

async function render() {
  const app = $("#app");
  hideSelBar();
  if (!profile()) return renderProfiles();
  const r = route();
  if (r.view === "t" && r.id) return renderTopicRoute(r);
  if (r.view === "s" && r.id) {
    const subject = S.subjects.find((s) => s.id === r.id && s.profileId === S.profileId);
    if (subject) return (app.innerHTML = viewSubject(subject));
  }
  app.innerHTML = viewHome();
}

// ---------- přihlášení a profily ----------
function renderLogin() {
  $("#app").innerHTML = `<div class="center-screen"><form class="center-card card" style="padding:32px" id="login">
    <div style="font-size:3rem">🎓</div><h1>Studovna</h1><p class="muted" style="margin-bottom:22px">Zadej heslo k aplikaci.</p>
    <input class="input" type="password" name="password" placeholder="Heslo" autofocus required>
    <button class="btn primary lg" style="width:100%;margin-top:14px">Vstoupit</button></form></div>`;
  $("#login").onsubmit = async (e) => {
    e.preventDefault();
    const password = new FormData(e.target).get("password");
    try {
      const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      if (!res.ok) throw new Error("Špatné heslo.");
      store.set("password", password);
      await start();
    } catch (err) { fail(err); }
  };
}

function renderProfiles() {
  $("#app").innerHTML = `<div class="center-screen"><div class="center-card">
    <div style="font-size:3.4rem">🎓</div><h1>Kdo se bude učit?</h1>
    <p class="muted">Každý má své předměty, kartičky a výsledky.</p>
    <div class="profiles">
      ${S.profiles.map((p) => `<button class="profile" data-act="pick-profile" data-id="${p.id}"><span class="avatar big" style="background:${esc(p.color)}">${initial(p.name)}</span>${esc(p.name)}</button>`).join("")}
      <button class="profile" data-act="new-profile"><span class="avatar big add">+</span>Nový profil</button>
    </div>
    ${S.profiles.length ? `<button class="btn ghost sm danger" data-act="delete-profile">Smazat profil…</button>` : ""}
  </div></div>`;
}

// ---------- domů a předmět ----------
function viewHome() {
  const subjects = S.subjects.filter((s) => s.profileId === S.profileId);
  const ids = subjects.map((s) => s.id);
  const mine = S.topics.filter((t) => ids.includes(t.subjectId));
  const due = mine.reduce((n, t) => n + t.due, 0);
  const cards = subjects.map((s) => {
    const topics = mine.filter((t) => t.subjectId === s.id);
    const d = topics.reduce((n, t) => n + t.due, 0);
    return `<a class="card subject" style="--c:${esc(s.color)}" href="#/s/${s.id}">
      <div class="emoji">${esc(s.emoji)}</div><h3>${esc(s.name)}</h3>
      <div class="chips" style="margin-top:10px"><span class="chip">${plural(topics.length, "téma", "témata", "témat")}</span>${d ? `<span class="chip accent">🃏 ${d} k opakování</span>` : ""}</div>
      <div class="card-menu"><button class="icon-btn" data-act="edit-subject" data-id="${s.id}" title="Upravit">✏️</button></div></a>`;
  }).join("");
  return `${topbar()}<main class="page">${aiBanner()}
    <div class="hero"><div class="grow"><h1>Ahoj, ${esc(profile().name)} 👋</h1>
      <p>${mine.length ? (due ? `Dnes na tebe čeká ${plural(due, "kartička", "kartičky", "kartiček")} k opakování.` : "Všechno zopakováno. Můžeš přidat nové téma.") : "Začni tím, že si založíš předmět a nahraješ první zápisy."}</p></div>
      <button class="btn primary" data-act="new-subject">+ Nový předmět</button></div>
    ${subjects.length ? `<div class="grid">${cards}<button class="add-card" data-act="new-subject">+ Přidat předmět</button></div>`
      : `<div class="card empty"><div class="big">📚</div><h3>Zatím tu nic není</h3><p>Založ si první předmět, třeba Dějepis nebo Matematiku.</p><button class="btn primary lg" data-act="new-subject">+ Založit předmět</button></div>`}
  </main>`;
}

function viewSubject(s) {
  const topics = S.topics.filter((t) => t.subjectId === s.id).sort((a, b) => b.createdAt - a.createdAt);
  const list = topics.map((t) => `<a class="card topic" style="--c:${esc(s.color)}" href="#/t/${t.id}">
      <div class="grow"><h3>${esc(t.title || "Nové téma")}</h3><div class="chips">
        ${t.status === "processing" ? `<span class="chip accent"><span class="spinner" style="width:12px;height:12px;border-width:2px"></span> Zpracovávám…</span>` : ""}
        ${t.status === "error" ? `<span class="chip bad">Chyba zpracování</span>` : ""}
        ${testChip(t.testDate)}
        ${t.cards ? `<span class="chip ${t.due ? "accent" : ""}">🃏 ${t.cards}${t.due ? ` · ${t.due} k opakování` : ""}</span>` : ""}
        ${t.questions ? `<span class="chip">✅ ${plural(t.questions, "otázka", "otázky", "otázek")}</span>` : ""}
        ${t.lastScore != null ? `<span class="chip ${t.lastScore >= 80 ? "ok" : t.lastScore >= 50 ? "warn" : "bad"}">Poslední test ${t.lastScore} %</span>` : ""}
      </div></div><span class="muted">›</span></a>`).join("");
  return `${topbar(`<span>›</span><a href="#/s/${s.id}">${esc(s.emoji)} ${esc(s.name)}</a>`)}<main class="page">${aiBanner()}
    <div class="hero"><div class="grow"><h1>${esc(s.emoji)} ${esc(s.name)}</h1><p>${plural(topics.length, "téma", "témata", "témat")}</p></div>
      <button class="btn primary" data-act="new-topic" data-id="${s.id}">+ Nové téma</button></div>
    ${topics.length ? `<div class="topics">${list}</div>`
      : `<div class="card empty"><div class="big">📄</div><h3>Nahraj první zápisy</h3><p>Vyfoť sešit, nahraj PDF nebo vlož text. Udělám z toho výpisky, kartičky a test.</p><button class="btn primary lg" data-act="new-topic" data-id="${s.id}">+ Nové téma</button></div>`}
  </main>`;
}

// ---------- nahrávání materiálů ----------
const readBase64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(",")[1]);
  fr.onerror = () => reject(new Error("Soubor se nepodařilo přečíst."));
  fr.readAsDataURL(blob);
});

// Fotky z mobilu mají i 10 MB; zmenšení na 2200 px stačí na čtení a zrychlí nahrání.
async function prepareFile(file) {
  if (file.type.startsWith("image/")) {
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
      return { name: file.name, type: "image/jpeg", data: await readBase64(blob) };
    } catch {
      throw new Error(`Obrázek „${file.name}“ se nepodařilo načíst. Zkus JPG nebo PNG.`);
    }
  }
  return { name: file.name, type: file.type, data: await readBase64(file) };
}

// mode: {subjectId} pro nové téma, {topic} pro přidání materiálu
function uploadModal(mode) {
  const isNew = Boolean(mode.subjectId);
  let files = [];
  modal(`<form>
    <h2>${isNew ? "Nové téma" : "Přidat materiál"}</h2>
    ${isNew ? `<label class="field"><span>Název <em>(nepovinné, jinak ho vymyslím)</em></span><input class="input" name="title" placeholder="např. Druhá světová válka"></label>` : ""}
    <div class="drop" tabindex="0"><div class="big">📎</div><b>Přetáhni sem soubory nebo klikni</b><div class="small">PDF, fotky zápisů, Word (.docx), text</div></div>
    <input type="file" multiple hidden accept=".pdf,.docx,.txt,.md,image/*">
    <div class="files"></div>
    <label class="field"><span>Nebo vlož text</span><textarea class="input" name="text" rows="4" placeholder="Sem můžeš vložit zápis z hodiny…"></textarea></label>
    ${isNew ? `<div class="row" style="align-items:flex-start">
        <label class="field grow"><span>Datum testu <em>(nepovinné)</em></span><input class="input" type="date" name="testDate"></label>
        <label class="field grow" style="flex:2"><span>Na co se zaměřit <em>(nepovinné)</em></span><input class="input" name="instructions" placeholder="např. hlavně letopočty"></label></div>`
      : `<label class="row" style="margin-bottom:6px"><input type="checkbox" name="regenerate" checked> Vygenerovat znovu výpisky, kartičky a test ze všech materiálů</label>`}
    <div class="modal-foot"><button type="button" class="btn" data-close>Zrušit</button><button class="btn primary">✨ ${isNew ? "Vytvořit" : "Přidat"}</button></div>
  </form>`, (el, close) => {
    const input = el.querySelector("input[type=file]");
    const drop = el.querySelector(".drop");
    const list = el.querySelector(".files");
    const draw = () => {
      list.innerHTML = files.map((f, i) => `<div class="file">${f.type.startsWith("image/") ? "🖼️" : "📄"}<span>${esc(f.name)}</span><span class="muted small" style="flex:none">${(f.size / 1048576).toFixed(1)} MB</span><button type="button" class="icon-btn" data-rm="${i}">✕</button></div>`).join("");
    };
    const add = (picked) => { files.push(...picked); draw(); };
    drop.onclick = () => input.click();
    drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
    input.onchange = () => { add([...input.files]); input.value = ""; };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); add([...e.dataTransfer.files]); };
    list.onclick = (e) => { const b = e.target.closest("[data-rm]"); if (b) { files.splice(Number(b.dataset.rm), 1); draw(); } };

    el.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const form = Object.fromEntries(new FormData(e.target));
      if (!files.length && !form.text.trim()) return toast("Nahraj soubor nebo vlož text.", true);
      if (files.filter((f) => !f.type.startsWith("image/")).reduce((n, f) => n + f.size, 0) > 40 * 1048576) return toast("Soubory jsou dohromady moc velké (limit 40 MB).", true);
      const button = e.target.querySelector(".btn.primary");
      button.disabled = true;
      button.textContent = "Nahrávám…";
      try {
        const body = { ...form, files: await Promise.all(files.map(prepareFile)) };
        if (isNew) await createTopic({ ...body, subjectId: mode.subjectId }, close);
        else { close(); await runProcessing(`/topics/${mode.topic.id}/sources`, { ...body, regenerate: form.regenerate === "on" }, mode.topic.id); }
      } catch (err) {
        fail(err);
        if (button.isConnected) { button.disabled = false; button.textContent = "✨ Zkusit znovu"; }
      }
    };
  });
}

async function createTopic(body, close) {
  let id = null;
  try {
    await stream("/topics", body, (ev) => {
      if (ev.type === "created") {
        id = ev.id;
        S.streaming = id;
        S.topic = null;
        close();
        location.hash = `#/t/${id}`;
      } else onProcessEvent(id, ev);
    });
  } finally {
    if (S.streaming === id) S.streaming = null;
    refresh().catch(() => {});
  }
}

function onProcessEvent(id, ev) {
  if (S.topic?.id !== id) return;
  if (ev.type === "progress") { S.topic.status = "processing"; S.topic.progress = ev.progress; }
  if (ev.type === "done") { S.topic = ev.topic; if (ev.topic.error) toast(ev.topic.error, true); }
  drawTopic();
}

// Spuštění generování nad existujícím tématem (přidání materiálu, „vygenerovat znovu“).
async function runProcessing(url, body, id) {
  S.streaming = id;
  if (S.topic?.id === id) { S.topic.status = "processing"; S.topic.progress = S.topic.progress || {}; drawTopic(); }
  try {
    await stream(url, body, (ev) => onProcessEvent(id, ev));
  } catch (err) {
    fail(err);
    if (S.topic?.id === id) { S.topic = await api("GET", `/topics/${id}`); drawTopic(); }
  } finally {
    S.streaming = null;
    refresh().catch(() => {});
  }
}

// ---------- stránka tématu ----------
let pollTimer = null;

async function renderTopicRoute(r) {
  clearTimeout(pollTimer);
  if (S.topic?.id !== r.id) {
    S.topic = null;
    $("#app").innerHTML = `${topbar()}<main class="page"><div class="empty"><div class="spinner" style="margin:0 auto"></div></div></main>`;
    try {
      const topic = await api("GET", `/topics/${r.id}`);
      if (route().id !== r.id) return;
      S.topic = topic;
    } catch (err) { fail(err); return go("#/"); }
  }
  drawTopic();
}

const TABS = [["notes", "📝 Výpisky"], ["cards", "🃏 Kartičky"], ["quiz", "✅ Test"], ["sources", "📎 Materiály"]];
const currentTab = () => TABS.some(([k]) => k === route().tab) ? route().tab : "notes";

function drawTopic() {
  const t = S.topic;
  const r = route();
  if (!t || r.view !== "t" || r.id !== t.id) return;
  const subject = S.subjects.find((s) => s.id === t.subjectId);
  const tab = currentTab();
  const counts = { cards: t.flashcards.length, quiz: t.quiz.length, sources: t.sources.length };
  const processing = t.status === "processing";

  // Když zpracování běží bez našeho streamu (např. po obnovení stránky), doptáváme se.
  clearTimeout(pollTimer);
  if (processing && S.streaming !== t.id) {
    pollTimer = setTimeout(async () => {
      try { const fresh = await api("GET", `/topics/${t.id}`); if (S.topic?.id === t.id) { S.topic = fresh; drawTopic(); if (fresh.status !== "processing") refresh(); } } catch { /* zkusíme příště */ }
    }, 3000);
  }

  const chatScroll = $(".chat-body")?.scrollTop;
  const draft = $("#chat-text")?.value || "";
  $("#app").innerHTML = `${topbar(subject ? `<span>›</span><a href="#/s/${subject.id}">${esc(subject.emoji)} ${esc(subject.name)}</a>` : "")}
  <div class="topic-layout">
    <main>
      ${aiBanner()}
      <div class="topic-head"><h1>${esc(t.title || "Nové téma")}</h1>
        <button class="icon-btn" data-act="edit-topic" title="Přejmenovat / datum testu">✏️</button>
        <button class="icon-btn" data-act="delete-topic" title="Smazat téma">🗑️</button>
        <div class="chips" style="margin-top:8px">${testChip(t.testDate)}${t.due ? `<span class="chip accent">🃏 ${t.due} k opakování</span>` : ""}</div></div>
      ${t.error && !processing ? `<div class="banner bad">${esc(t.error)}</div>` : ""}
      ${processing ? `<div class="card pane">${viewProcessing(t)}</div>` : `
        <div class="tabs">${TABS.map(([k, label]) => `<button class="tab ${k === tab ? "active" : ""}" data-act="tab" data-tab="${k}">${label}${counts[k] ? `<span class="n">${counts[k]}</span>` : ""}</button>`).join("")}</div>
        <div class="card pane" id="pane">${viewPane(tab)}</div>`}
    </main>
    ${processing ? "" : viewChat(draft)}
  </div>
  ${processing ? "" : `<button class="btn primary fab" data-act="chat-open">💬 Zeptej se AI</button>`}`;
  const body = $(".chat-body");
  if (body) body.scrollTop = chatScroll ?? body.scrollHeight;
}

function drawPane() {
  const pane = $("#pane");
  if (pane) { hideSelBar(); pane.innerHTML = viewPane(currentTab()); }
  else drawTopic();
}

function viewProcessing(t) {
  const p = t.progress || {};
  const steps = [["read", "Čtu materiály"], ["notes", "Píšu výpisky"], ["flashcards", "Vyrábím kartičky"], ["quiz", "Sestavuji test"]];
  return `<div style="text-align:center;padding:20px 0"><div style="font-size:2.6rem">✨</div><h2>Pracuji na tom…</h2>
    <p class="muted" style="margin-top:6px">Obvykle to trvá 1–3 minuty. Stránku klidně zavři, dodělám to i tak.</p>
    <div class="steps">${steps.filter(([k]) => p[k] !== "skip").map(([k, label]) => {
      const st = p[k] || "wait";
      return `<div class="step ${st}"><span class="dot">${st === "run" ? `<span class="spinner"></span>` : st === "done" ? "✓" : st === "error" ? "!" : ""}</span>${label}</div>`;
    }).join("")}</div></div>`;
}

function viewPane(tab) {
  if (tab === "cards") return S.study ? viewStudy() : viewCards();
  if (tab === "quiz") return S.quiz ? viewQuizRun() : viewQuizStart();
  if (tab === "sources") return viewSources();
  return viewNotes();
}

const regenButton = (part, label = "↻ Vygenerovat znovu") => `<button class="btn sm ghost" data-act="regen" data-part="${part}">${label}</button>`;
const emptyPart = (icon, title, part) => `<div class="empty"><div class="big">${icon}</div><h3>${title}</h3><button class="btn primary" data-act="regen" data-part="${part}" data-now="1">✨ Vygenerovat</button></div>`;

// ----- výpisky -----
function viewNotes() {
  const t = S.topic;
  if (S.notesEdit) {
    return `<div class="pane-tools"><b>Ruční úprava</b><span class="muted small">Markdown · ==zvýraznění== · $vzorec$</span><span class="spacer"></span>
      <button class="btn sm" data-act="notes-cancel">Zrušit</button><button class="btn sm primary" data-act="notes-save">Uložit</button></div>
      <textarea class="input notes-editor" id="notes-src">${esc(t.notes)}</textarea>`;
  }
  if (!t.notes) return emptyPart("📝", "Výpisky tu zatím nejsou", "notes");
  return `<div class="pane-tools"><span class="muted small">Tip: označ text a zvýrazni ho, nebo si ho nech vysvětlit.</span><span class="spacer"></span>
      <button class="btn sm ghost" data-act="notes-edit">✏️ Upravit</button><button class="btn sm ghost" data-act="print">🖨️ Tisk / PDF</button>${regenButton("notes")}</div>
    <article class="prose" id="notes">${md(t.notes)}</article>`;
}

let selBar = null;
function hideSelBar() { selBar?.remove(); selBar = null; }
function showSelBar(x, y, buttons) {
  hideSelBar();
  selBar = document.createElement("div");
  selBar.className = "sel-bar";
  selBar.style.left = Math.max(110, Math.min(innerWidth - 110, x)) + "px";
  selBar.style.top = y + scrollY - 8 + "px";
  selBar.innerHTML = buttons.map(([act, label]) => `<button data-act="${act}">${label}</button>`).join("");
  selBar.addEventListener("mousedown", (e) => e.preventDefault()); // ať klik nezruší výběr
  document.body.append(selBar);
}

let picked = ""; // text, kterého se týká nabídka nad výběrem
function onSelection(e) {
  const notes = $("#notes");
  if (!notes || e.target.closest?.(".sel-bar")) return;
  const sel = getSelection();
  const text = sel.toString().trim();
  if (text && sel.rangeCount && notes.contains(sel.anchorNode) && notes.contains(sel.focusNode)) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    picked = text;
    return showSelBar(rect.left + rect.width / 2, rect.top, [["sel-mark", "🖍️ Zvýraznit"], ["sel-explain", "💡 Vysvětlit"], ["sel-card", "🃏 Kartička"]]);
  }
  const mark = e.target.closest?.("#notes mark");
  if (mark) {
    const rect = mark.getBoundingClientRect();
    picked = mark.textContent;
    return showSelBar(rect.left + rect.width / 2, rect.top, [["sel-unmark", "Zrušit zvýraznění"], ["sel-explain", "💡 Vysvětlit"]]);
  }
  hideSelBar();
}
document.addEventListener("mouseup", (e) => setTimeout(() => onSelection(e), 0));
document.addEventListener("touchend", (e) => setTimeout(() => onSelection(e), 50));

async function saveNotes(notes) {
  S.topic = await api("PATCH", `/topics/${S.topic.id}`, { notes });
  drawPane();
}

// ----- kartičky -----
function viewCards() {
  const t = S.topic;
  if (!t.flashcards.length) return emptyPart("🃏", "Kartičky tu zatím nejsou", "flashcards") + `<div style="text-align:center"><button class="btn sm ghost" data-act="card-add">+ Přidat ručně</button></div>`;
  const now = Date.now();
  const due = t.flashcards.filter((c) => (c.due || 0) <= now).length;
  const learned = t.flashcards.filter((c) => c.box >= 3).length;
  return `<div class="stat-row">
      <div class="stat"><b>${t.flashcards.length}</b><span>kartiček</span></div>
      <div class="stat"><b>${due}</b><span>k opakování dnes</span></div>
      <div class="stat"><b>${learned}</b><span>dobře naučených</span></div></div>
    <div class="pane-tools">
      ${due ? `<button class="btn primary" data-act="study" data-mode="due">▶ Procvičovat (${due})</button><button class="btn" data-act="study" data-mode="all">Projít všechny</button>`
        : `<span class="chip ok">🎉 Dnes máš zopakováno</span><button class="btn" data-act="study" data-mode="all">▶ Projít všechny znovu</button>`}
      <span class="spacer"></span><button class="btn sm ghost" data-act="card-add">+ Přidat</button>${regenButton("flashcards")}</div>
    <div class="card-list">${t.flashcards.map((c) => `<div class="fc-row">
        <div class="q"><div class="prose">${md(c.front, true)}</div><div class="boxes" title="Jak dobře kartičku umíš">${[1, 2, 3, 4, 5].map((i) => `<i class="${c.box >= i ? "on" : ""}"></i>`).join("")}</div></div>
        <div class="a prose">${md(c.back, true)}</div>
        <div class="ops"><button class="icon-btn" data-act="card-edit" data-id="${c.id}" title="Upravit">✏️</button><button class="icon-btn" data-act="card-del" data-id="${c.id}" title="Smazat">🗑️</button></div></div>`).join("")}</div>`;
}

function startStudy(mode) {
  const now = Date.now();
  const cards = S.topic.flashcards.filter((c) => mode === "all" || (c.due || 0) <= now);
  if (!cards.length) return;
  S.study = { queue: shuffle(cards.map((c) => c.id)), total: cards.length, done: 0, missed: new Set(), flipped: false };
  drawPane();
}

function viewStudy() {
  const st = S.study;
  const card = S.topic.flashcards.find((c) => c.id === st.queue[0]);
  if (!card) {
    const ok = st.total - st.missed.size;
    return `<div class="empty"><div class="big">🎉</div><h3>Hotovo!</h3><p>${ok} z ${st.total} napoprvé správně.${st.missed.size ? " Ty, co nešly, ti ukážu zase brzy." : ""}</p>
      <button class="btn primary" data-act="study-end">Zpět na kartičky</button></div>`;
  }
  return `<div class="study ${st.flipped ? "is-flipped" : ""}">
    <div class="row"><button class="btn sm ghost" data-act="study-end">← Ukončit</button><span class="spacer"></span><span class="muted small">${st.done} / ${st.total}</span></div>
    <div class="progress"><i style="width:${(st.done / st.total) * 100}%"></i></div>
    <div class="flip ${st.flipped ? "flipped" : ""}" data-act="flip"><div class="flip-inner">
      <div class="face"><span class="tag">Otázka</span><div class="prose">${md(card.front)}</div></div>
      <div class="face back"><span class="tag">Odpověď</span><div class="prose">${md(card.back)}</div></div></div></div>
    <div class="when-back"><div class="study-actions"><button class="btn lg bad" data-act="rate" data-known="0">✗ Nevím</button><button class="btn lg ok" data-act="rate" data-known="1">✓ Umím</button></div>
      <p class="hint"><kbd>1</kbd> nevím · <kbd>2</kbd> umím</p></div>
    <div class="when-front"><div class="study-actions" style="grid-template-columns:1fr"><button class="btn lg primary" data-act="flip">Ukázat odpověď</button></div><p class="hint"><kbd>mezerník</kbd> otočí kartičku</p></div>
  </div>`;
}

function rateCard(known) {
  const st = S.study;
  const id = st.queue.shift();
  st.flipped = false;
  if (known) {
    st.done++;
    // Kartička, která v tomhle kole nešla, zůstává k opakování na zítra.
    if (!st.missed.has(id)) review(id, true);
  } else {
    if (!st.missed.has(id)) review(id, false);
    st.missed.add(id);
    st.queue.splice(Math.min(st.queue.length, 3), 0, id);
  }
  drawPane();
}

async function review(cardId, known) {
  try {
    const out = await api("POST", `/topics/${S.topic.id}/review`, { cardId, known });
    const card = S.topic.flashcards.find((c) => c.id === cardId);
    if (card) Object.assign(card, out.card);
    S.topic.due = out.due;
  } catch (err) { fail(err); }
}

async function saveCards(cards) {
  S.topic = await api("PATCH", `/topics/${S.topic.id}`, { flashcards: cards });
  drawTopic();
}

// ----- test -----
function viewQuizStart() {
  const t = S.topic;
  if (!t.quiz.length) return emptyPart("✅", "Test tu zatím není", "quiz");
  const last = t.attempts[t.attempts.length - 1];
  const wrong = last ? t.quiz.filter((q) => last.wrong?.includes(q.id)) : [];
  const types = { choice: "výběr", truefalse: "pravda/nepravda", open: "otevřená" };
  return `<div style="text-align:center;padding:10px 0 4px"><div style="font-size:2.6rem">✅</div>
      <h2>${plural(t.quiz.length, "otázka", "otázky", "otázek")}</h2>
      <p class="muted" style="margin:6px 0 20px">Po každé odpovědi hned uvidíš, jestli je správně a proč.</p>
      <div class="row" style="justify-content:center">
        <button class="btn primary lg" data-act="quiz-start">▶ Spustit test</button>
        ${wrong.length ? `<button class="btn lg" data-act="quiz-start" data-wrong="1">Jen ${plural(wrong.length, "chybná", "chybné", "chybných")} z minula</button>` : ""}
      </div></div>
    ${t.attempts.length ? `<div style="max-width:420px;margin:28px auto 0"><b class="small">Předchozí pokusy</b>
      <div class="history">${t.attempts.slice(-12).map((a) => `<i style="height:${Math.max(6, (a.score / a.total) * 100)}%" title="${Math.round((a.score / a.total) * 100)} %"></i>`).join("")}</div>
      <div class="muted small">Naposledy ${Math.round((last.score / last.total) * 100)} % · ${new Date(last.at).toLocaleDateString("cs-CZ")}</div></div>` : ""}
    <details class="manage"><summary>Správa otázek</summary>
      <div class="pane-tools"><span class="muted small">Otázky uprav nebo přidej přes AI v chatu („přidej 5 těžších otázek“).</span><span class="spacer"></span>${regenButton("quiz")}</div>
      <div class="card-list">${t.quiz.map((q, i) => `<div class="q-row"><b>${i + 1}.</b><div class="grow"><div class="prose">${md(q.question, true)}</div>
        <div class="muted small">${types[q.type]} · správně: ${q.type === "open" ? md(q.answer, true) : md(q.options[q.correct], true)}</div></div>
        <button class="icon-btn" data-act="q-del" data-id="${q.id}" title="Smazat">🗑️</button></div>`).join("")}</div></details>`;
}

function startQuiz(onlyWrong) {
  const t = S.topic;
  const last = t.attempts[t.attempts.length - 1];
  const pool = onlyWrong ? t.quiz.filter((q) => last?.wrong?.includes(q.id)) : t.quiz;
  if (!pool.length) return;
  S.quiz = { questions: shuffle(pool), i: 0, results: [], current: null, grading: false, practice: Boolean(onlyWrong) };
  drawPane();
}

function viewQuizRun() {
  const qz = S.quiz;
  if (qz.i >= qz.questions.length) return viewQuizEnd();
  const q = qz.questions[qz.i];
  const cur = qz.current; // {given, points, verdict, feedback}
  const letters = "ABCDEFGH";
  let body;
  if (q.type === "open") {
    body = `<textarea class="input" id="open-answer" rows="4" placeholder="Napiš odpověď vlastními slovy…" ${cur || qz.grading ? "disabled" : ""}>${esc(cur?.given || qz.draft || "")}</textarea>
      ${cur ? "" : `<div class="row" style="margin-top:12px"><button class="btn primary" data-act="quiz-open" ${qz.grading ? "disabled" : ""}>${qz.grading ? `<span class="spinner" style="width:16px;height:16px"></span> Hodnotím…` : "Zkontrolovat"}</button>
        <button class="btn ghost" data-act="quiz-skip" ${qz.grading ? "disabled" : ""}>Nevím</button></div>`}`;
  } else {
    body = `<div class="options">${q.options.map((o, i) => {
      const cls = cur ? (i === q.correct ? "right" : i === cur.given ? "wrong" : "") : "";
      return `<button class="option ${cls}" data-act="quiz-pick" data-i="${i}" ${cur ? "disabled" : ""}><span class="key">${letters[i]}</span><span class="prose">${md(o, true)}</span></button>`;
    }).join("")}</div>`;
  }
  const verdict = cur && (cur.points === 1 ? "right" : cur.points > 0 ? "partial" : "wrong");
  const title = { right: "✓ Správně", partial: "◐ Částečně správně", wrong: "✗ Špatně" }[verdict];
  return `<div class="question">
    <div class="row"><button class="btn sm ghost" data-act="quiz-end">← Ukončit</button><span class="spacer"></span><span class="muted small">Otázka ${qz.i + 1} z ${qz.questions.length}</span></div>
    <div class="progress"><i style="width:${(qz.i / qz.questions.length) * 100}%"></i></div>
    <h2>${md(q.question, true)}</h2>
    ${body}
    ${cur ? `<div class="feedback ${verdict}"><b>${title}</b><div class="prose">
        ${cur.feedback ? md(cur.feedback) : ""}${q.type === "open" ? md("**Vzorová odpověď:** " + q.answer) : ""}${q.explanation ? md(q.explanation) : ""}</div></div>
      <div class="row" style="margin-top:16px"><button class="btn ghost sm" data-act="quiz-explain">💡 Nechápu, vysvětli mi to</button><span class="spacer"></span>
      <button class="btn primary" data-act="quiz-next" autofocus>${qz.i + 1 < qz.questions.length ? "Další →" : "Vyhodnotit"}</button></div>` : ""}
  </div>`;
}

function answerQuiz(result) {
  const qz = S.quiz;
  qz.current = result;
  qz.results.push({ q: qz.questions[qz.i], ...result });
  qz.grading = false;
  qz.draft = "";
  drawPane();
  $("[data-act=quiz-next]")?.focus();
}

function viewQuizEnd() {
  const qz = S.quiz;
  const score = qz.results.reduce((n, r) => n + r.points, 0);
  const pct = Math.round((score / qz.results.length) * 100);
  const text = pct >= 90 ? "Paráda, tohle umíš! 🏆" : pct >= 70 ? "Dobrá práce, ještě doladit detaily." : pct >= 50 ? "Základ tam je. Projdi si chyby a zkus to znovu." : "Chce to ještě zabrat. Začni výpisky a kartičkami.";
  const letters = "ABCDEFGH";
  return `<div class="question" style="text-align:center">
    <div class="score-ring" style="--p:${pct}"><div>${pct}%</div></div>
    <h2 style="margin:0 0 4px">${text}</h2><p class="muted">${score % 1 ? score.toFixed(1) : score} z ${qz.results.length} bodů</p>
    <div class="row" style="justify-content:center;margin-top:18px"><button class="btn primary" data-act="quiz-start">↻ Znovu</button><button class="btn" data-act="quiz-end">Zpět</button></div>
    <div class="review">${qz.results.map((r) => {
      const cls = r.points === 1 ? "right" : r.points > 0 ? "partial" : "";
      const given = r.q.type === "open" ? esc(r.given || "(bez odpovědi)") : r.given == null ? "(bez odpovědi)" : md(r.q.options[r.given], true);
      const right = r.q.type === "open" ? md(r.q.answer, true) : `${letters[r.q.correct]}) ${md(r.q.options[r.q.correct], true)}`;
      return `<div class="review-item ${cls}"><div class="prose"><p><b>${md(r.q.question, true)}</b></p>
        ${r.points === 1 ? "" : `<p class="muted">Tvoje odpověď: ${given}</p>`}<p>Správně: ${right}</p>${r.points === 1 ? "" : md(r.feedback || r.q.explanation || "")}</div>
        ${r.points === 1 ? "" : `<button class="btn ghost sm" data-act="review-explain" data-id="${r.q.id}" style="margin-top:6px">💡 Vysvětli mi to</button>`}</div>`;
    }).join("")}</div></div>`;
}

async function finishQuiz() {
  const qz = S.quiz;
  qz.i = qz.questions.length;
  drawPane();
  if (qz.practice || qz.saved) return; // opakování chyb se do historie nepočítá
  qz.saved = true;
  try {
    const out = await api("POST", `/topics/${S.topic.id}/attempts`, {
      score: qz.results.reduce((n, r) => n + r.points, 0),
      total: qz.results.length,
      wrong: qz.results.filter((r) => r.points < 1).map((r) => r.q.id),
    });
    S.topic.attempts = out.attempts;
    refresh().catch(() => {});
  } catch (err) { fail(err); }
}

const explainPrompt = (q, given) =>
  `Nechápu tuhle otázku z testu, vysvětli mi to od základů.\n\nOtázka: ${q.question}\n${given ? `Moje odpověď: ${given}\n` : ""}Správná odpověď: ${q.type === "open" ? q.answer : q.options[q.correct]}`;

// ----- materiály -----
function viewSources() {
  const t = S.topic;
  const icons = { pdf: "📕", image: "🖼️", docx: "📄", text: "📝" };
  return `<div class="pane-tools"><span class="muted small">Z těchto materiálů vychází výpisky, kartičky, test i odpovědi AI.</span><span class="spacer"></span>
      <button class="btn sm primary" data-act="source-add">+ Přidat materiál</button></div>
    ${t.sources.map((s) => `<details class="source"><summary>${icons[s.kind] || "📄"}<span class="grow">${esc(s.name)}</span>
        <span class="muted small">${s.chars.toLocaleString("cs-CZ")} znaků</span>
        <button class="icon-btn" data-act="source-del" data-id="${s.id}" title="Odebrat">🗑️</button></summary>
        <pre>${esc(s.preview)}${s.chars > s.preview.length ? "\n\n… (zkráceno)" : ""}</pre></details>`).join("") || `<div class="empty">Žádné materiály.</div>`}`;
}

// ---------- chat ----------
const SUGGESTIONS = [
  ["Vysvětli mi to od základů", "Vysvětli mi celé tohle téma úplně od základů, jako bych o tom nikdy neslyšel."],
  ["Zkrať výpisky", "Zkrať výpisky zhruba na polovinu, nech jen to nejdůležitější na test."],
  ["Zvýrazni to hlavní", "Zvýrazni ve výpiscích to nejdůležitější, co se mám naučit."],
  ["Přidej 10 kartiček", "Přidej 10 nových kartiček na věci, které ještě nejsou pokryté."],
  ["Těžší test", "Udělej test těžší: víc otázek na pochopení a souvislosti."],
  ["Co bude nejspíš v testu?", "Co z tohohle tématu bude nejspíš v testu? Seřaď to podle důležitosti."],
  ["Vyzkoušej mě", "Vyzkoušej mě: ptej se mě po jedné otázce a vždy mi řekni, jestli jsem odpověděl správně."],
];

function viewChat(draft = "") {
  return `<aside class="card chat ${S.chatOpen ? "open" : ""}">
    <div class="chat-head"><span class="ai">✨</span><div class="grow"><b>Zeptej se AI</b><span class="muted small">Vysvětlím cokoliv a upravím výpisky, kartičky i test</span></div>
      ${S.topic.chat.length ? `<button class="icon-btn" data-act="chat-clear" title="Smazat konverzaci">🧹</button>` : ""}
      <button class="icon-btn chat-close" data-act="chat-close" title="Zavřít">✕</button></div>
    <div class="chat-body">${viewMessages()}</div>
    <div class="suggest">${SUGGESTIONS.map(([label], i) => `<button data-act="suggest" data-i="${i}">${label}</button>`).join("")}</div>
    <form class="chat-input" id="chat-form"><textarea class="input" id="chat-text" rows="1" placeholder="Na co se chceš zeptat?">${esc(draft)}</textarea>
      <button class="btn primary" title="Odeslat" ${S.sending ? "disabled" : ""}>➤</button></form>
  </aside>`;
}

function viewMessage(m) {
  if (m.role === "user") return `<div class="msg user">${esc(m.text)}</div>`;
  const actions = m.actions?.length ? `<div class="actions">${m.actions.map((a) => `<span class="chip ok">✓ ${esc(a)}</span>`).join("")}</div>` : "";
  if (m.error) return `<div class="msg assistant error">${m.text ? `<div class="prose">${md(m.text)}</div>` : ""}${actions}<div>⚠️ ${esc(m.error)}</div></div>`;
  const body = m.text ? `<div class="prose">${md(m.text)}</div>` : "";
  return `<div class="msg assistant">${body}${actions}${m.pending && !m.text ? `<span class="typing"><i></i><i></i><i></i></span>` : ""}</div>`;
}

function viewMessages() {
  const chat = S.topic.chat;
  if (!chat.length) return `<div class="chat-intro"><div class="big">💬</div><p><b>Něčemu nerozumíš?</b></p><p class="small">Zeptej se na cokoliv z materiálů. Vysvětlím to od začátku, nebo ti na přání upravím výpisky, kartičky i test.</p></div>`;
  return chat.map(viewMessage).join("");
}

let chatFrame = 0;
function drawLastMessage() {
  cancelAnimationFrame(chatFrame);
  chatFrame = requestAnimationFrame(() => {
    const body = $(".chat-body");
    if (!body) return;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    const last = S.topic.chat[S.topic.chat.length - 1];
    if (body.lastElementChild?.classList.contains("assistant")) body.lastElementChild.outerHTML = viewMessage(last);
    else body.innerHTML = viewMessages();
    if (nearBottom) body.scrollTop = body.scrollHeight;
  });
}

async function sendChat(text) {
  text = text.trim();
  const t = S.topic;
  if (!text || !t) return;
  if (S.sending) return toast("Počkej, až AI dopíše.");
  S.sending = true;
  S.chatOpen = true;
  const reply = { role: "assistant", text: "", actions: [], pending: true };
  t.chat.push({ role: "user", text }, reply);
  // Překreslí se jen panel chatu, ať se neztratí rozepsaná odpověď v testu nebo úprava výpisků.
  const panel = $(".chat");
  if (panel) panel.outerHTML = viewChat(); else drawTopic();
  const body = $(".chat-body");
  if (body) body.scrollTop = body.scrollHeight;

  // Úpravy od AI se promítnou hned, ale rozdělaný test nebo procvičování nepřekreslujeme pod rukama.
  const applyTopic = (fresh) => {
    if (S.topic?.id !== fresh.id) return;
    const chat = S.topic.chat;
    S.topic = { ...fresh, chat };
    if (!S.study && !S.quiz && !S.notesEdit) drawPane();
  };

  try {
    await stream(`/topics/${t.id}/chat`, { message: text }, (ev) => {
      if (ev.type === "text") reply.text += ev.delta;
      if (ev.type === "reset") reply.text = ev.text;
      if (ev.type === "action" && !reply.actions.includes(ev.label)) reply.actions.push(ev.label);
      if (ev.type === "topic") applyTopic(ev.topic);
      if (ev.type === "error") { reply.error = ev.message; applyTopic(ev.topic); }
      if (ev.type === "done") applyTopic(ev.topic);
      if (S.topic?.id === t.id) drawLastMessage();
    });
  } catch (err) {
    reply.error = err.message;
  }
  reply.pending = false;
  reply.text = reply.text.trim();
  S.sending = false;
  if (S.topic?.id === t.id) {
    drawLastMessage();
    const send = $("#chat-form button");
    if (send) send.disabled = false;
    if (reply.actions.length) refresh().catch(() => {});
  }
}

// ---------- akce ----------
function subjectForm(subject) {
  let emoji = subject?.emoji || EMOJIS[0];
  let color = subject?.color || COLORS[Math.floor(Math.random() * COLORS.length)];
  modal(`<form><h2>${subject ? "Upravit předmět" : "Nový předmět"}</h2>
    <label class="field"><span>Název</span><input class="input" name="name" value="${esc(subject?.name || "")}" placeholder="např. Dějepis" required autofocus></label>
    <div class="field"><span style="display:block;font-weight:600;font-size:.875rem;margin-bottom:6px">Ikona</span><div class="picks" data-kind="emoji">${EMOJIS.map((e) => `<button type="button" class="pick ${e === emoji ? "on" : ""}" data-v="${e}">${e}</button>`).join("")}</div></div>
    <div class="field" style="margin-top:14px"><span style="display:block;font-weight:600;font-size:.875rem;margin-bottom:6px">Barva</span><div class="picks" data-kind="color">${COLORS.map((c) => `<button type="button" class="pick color ${c === color ? "on" : ""}" data-v="${c}" style="background:${c}"></button>`).join("")}</div></div>
    <div class="modal-foot">${subject ? `<button type="button" class="btn danger ghost" data-del>Smazat předmět</button><span class="spacer"></span>` : ""}
      <button type="button" class="btn" data-close>Zrušit</button><button class="btn primary">Uložit</button></div></form>`, (el, close) => {
    el.addEventListener("click", (e) => {
      const pick = e.target.closest(".pick");
      if (!pick) return;
      const group = pick.parentElement;
      group.querySelectorAll(".pick").forEach((p) => p.classList.toggle("on", p === pick));
      if (group.dataset.kind === "emoji") emoji = pick.dataset.v; else color = pick.dataset.v;
    });
    el.querySelector("[data-del]")?.addEventListener("click", async () => {
      if (!(await confirmBox(`Smazat předmět „${subject.name}“ se všemi tématy?`))) return;
      try { await api("DELETE", `/subjects/${subject.id}`); await refresh(); close(); go("#/"); } catch (err) { fail(err); }
    });
    el.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: new FormData(e.target).get("name"), emoji, color, profileId: S.profileId };
      try {
        if (subject) await api("PATCH", `/subjects/${subject.id}`, body); else await api("POST", "/subjects", body);
        await refresh(); close(); render();
      } catch (err) { fail(err); }
    };
  });
}

async function cardForm(card) {
  const v = await formBox(card ? "Upravit kartičku" : "Nová kartička", [
    { name: "front", label: "Otázka", type: "textarea", rows: 2, value: card?.front },
    { name: "back", label: "Odpověď", type: "textarea", rows: 3, value: card?.back },
  ]);
  if (!v.front.trim() || !v.back.trim()) return toast("Vyplň otázku i odpověď.", true);
  const cards = S.topic.flashcards.map((c) => (c.id === card?.id ? { ...c, ...v } : c));
  if (!card) cards.push(v);
  await saveCards(cards);
}

const actions = {
  theme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
  },
  "switch-profile"() { S.profileId = null; store.set("profile", null); location.hash = "#/"; render(); },
  "pick-profile"(el) { S.profileId = el.dataset.id; store.set("profile", S.profileId); render(); },
  async "new-profile"() {
    const v = await formBox("Nový profil", [{ name: "name", label: "Jak ti říkají?", placeholder: "Jméno" }], "Vytvořit");
    const p = await api("POST", "/profiles", { name: v.name, color: COLORS[S.profiles.length % COLORS.length] });
    await refresh();
    actions["pick-profile"]({ dataset: { id: p.id } });
  },
  "delete-profile"() {
    modal(`<h2>Který profil smazat?</h2><p class="muted" style="margin-bottom:14px">Smaže se i se všemi předměty a tématy.</p>
      <div class="picks">${S.profiles.map((p) => `<button class="btn danger" data-del="${p.id}">${esc(p.name)}</button>`).join("")}</div>
      <div class="modal-foot"><button class="btn" data-close>Zrušit</button></div>`, (el, close) => {
      el.addEventListener("click", async (e) => {
        const id = e.target.closest("[data-del]")?.dataset.del;
        if (!id) return;
        try { await api("DELETE", `/profiles/${id}`); await refresh(); close(); render(); } catch (err) { fail(err); }
      });
    });
  },
  "new-subject"() { subjectForm(); },
  "edit-subject"(el) { subjectForm(S.subjects.find((s) => s.id === el.dataset.id)); },
  "new-topic"(el) { uploadModal({ subjectId: el.dataset.id }); },

  tab(el) { S.study = null; S.quiz = null; S.notesEdit = false; history.replaceState(null, "", `#/t/${S.topic.id}/${el.dataset.tab}`); drawTopic(); },
  async "edit-topic"() {
    const v = await formBox("Upravit téma", [
      { name: "title", label: "Název", value: S.topic.title },
      { name: "testDate", label: "Datum testu", type: "date", value: S.topic.testDate, optional: true },
    ]);
    S.topic = await api("PATCH", `/topics/${S.topic.id}`, v);
    await refresh();
    drawTopic();
  },
  async "delete-topic"() {
    if (!(await confirmBox(`Smazat téma „${S.topic.title}“?`))) return;
    const subjectId = S.topic.subjectId;
    await api("DELETE", `/topics/${S.topic.id}`);
    S.topic = null;
    await refresh();
    go(`#/s/${subjectId}`);
  },
  async regen(el) {
    const part = el.dataset.part;
    const names = { notes: "výpisky", flashcards: "kartičky", quiz: "test" };
    let instructions = "";
    if (!el.dataset.now) {
      const v = await formBox(`Vygenerovat znovu ${names[part]}`, [{ name: "instructions", label: "Chceš to jinak?", hint: "(nepovinné)", type: "textarea", rows: 3, optional: true,
        placeholder: part === "notes" ? "např. stručněji, víc tabulek…" : part === "quiz" ? "např. 20 otázek, těžší…" : "např. víc kartiček na letopočty…" }], "Vygenerovat");
      instructions = v.instructions;
    }
    await runProcessing(`/topics/${S.topic.id}/generate`, { parts: [part], instructions }, S.topic.id);
  },

  "notes-edit"() { S.notesEdit = true; drawPane(); },
  "notes-cancel"() { S.notesEdit = false; drawPane(); },
  async "notes-save"() { const text = $("#notes-src").value; S.notesEdit = false; await saveNotes(text); toast("Uloženo"); },
  print() { print(); },
  async "sel-mark"() {
    const notes = S.topic.notes;
    getSelection().removeAllRanges();
    hideSelBar();
    // Jde to bez AI, pokud je označený text ve zdroji výpisků doslova (bez formátování uvnitř).
    if (!picked.includes("\n") && notes.includes(picked) && !picked.includes("==")) {
      await saveNotes(notes.replace(picked, () => `==${picked}==`));
    } else {
      sendChat(`Zvýrazni ve výpiscích tuhle část:\n„${picked}“`);
    }
  },
  async "sel-unmark"() {
    hideSelBar();
    const notes = S.topic.notes;
    if (notes.includes(`==${picked}==`)) await saveNotes(notes.replace(`==${picked}==`, () => picked));
    else sendChat(`Zruš ve výpiscích zvýraznění u textu:\n„${picked}“`);
  },
  "sel-explain"() { getSelection().removeAllRanges(); hideSelBar(); sendChat(`Vysvětli mi od základů tuhle část výpisků:\n„${picked}“`); },
  "sel-card"() { getSelection().removeAllRanges(); hideSelBar(); sendChat(`Udělej z téhle části výpisků kartičku (nebo víc, pokud je tam víc faktů):\n„${picked}“`); },

  study(el) { startStudy(el.dataset.mode); },
  "study-end"() { S.study = null; drawTopic(); refresh().catch(() => {}); },
  flip() {
    if (!S.study) return;
    S.study.flipped = !S.study.flipped;
    $(".flip")?.classList.toggle("flipped", S.study.flipped);
    $(".study")?.classList.toggle("is-flipped", S.study.flipped);
  },
  rate(el) { rateCard(el.dataset.known === "1"); },
  "card-add"() { return cardForm(); },
  "card-edit"(el) { return cardForm(S.topic.flashcards.find((c) => c.id === el.dataset.id)); },
  async "card-del"(el) { await saveCards(S.topic.flashcards.filter((c) => c.id !== el.dataset.id)); },

  "quiz-start"(el) { startQuiz(el.dataset.wrong === "1"); },
  "quiz-end"() { S.quiz = null; drawTopic(); },
  "quiz-pick"(el) {
    const q = S.quiz.questions[S.quiz.i];
    if (S.quiz.current) return;
    const given = Number(el.dataset.i);
    answerQuiz({ given, points: given === q.correct ? 1 : 0 });
  },
  async "quiz-open"() {
    const qz = S.quiz;
    const q = qz.questions[qz.i];
    const given = $("#open-answer").value.trim();
    if (!given) return toast("Napiš odpověď, nebo dej „Nevím“.");
    qz.grading = true;
    qz.draft = given;
    drawPane();
    try {
      const out = await api("POST", `/topics/${S.topic.id}/grade`, { questionId: q.id, answer: given });
      if (S.quiz !== qz) return;
      answerQuiz({ given, points: { correct: 1, partial: 0.5, wrong: 0 }[out.verdict] ?? 0, feedback: out.feedback });
    } catch (err) {
      qz.grading = false;
      if (S.quiz === qz) drawPane();
      fail(err);
    }
  },
  "quiz-skip"() { answerQuiz({ given: "", points: 0 }); },
  "quiz-next"() {
    const qz = S.quiz;
    qz.current = null;
    if (qz.i + 1 >= qz.questions.length) return finishQuiz();
    qz.i++;
    drawPane();
  },
  "quiz-explain"() {
    const qz = S.quiz;
    const q = qz.questions[qz.i];
    const given = q.type === "open" ? qz.current.given : q.options[qz.current.given];
    sendChat(explainPrompt(q, given));
  },
  "review-explain"(el) {
    const r = S.quiz.results.find((x) => x.q.id === el.dataset.id);
    sendChat(explainPrompt(r.q, r.q.type === "open" ? r.given : r.q.options[r.given]));
  },
  async "q-del"(el) {
    S.topic = await api("PATCH", `/topics/${S.topic.id}`, { deleteQuestions: [el.dataset.id] });
    const open = true;
    drawTopic();
    const d = $("details.manage");
    if (d) d.open = open;
  },

  "source-add"() { uploadModal({ topic: S.topic }); },
  async "source-del"(el) {
    if (!(await confirmBox("Odebrat tento materiál?", "Odebrat"))) return;
    S.topic = await api("DELETE", `/topics/${S.topic.id}/sources/${el.dataset.id}`);
    drawTopic();
  },

  "chat-open"() { S.chatOpen = true; $(".chat")?.classList.add("open"); $("#chat-text")?.focus(); },
  "chat-close"() { S.chatOpen = false; $(".chat")?.classList.remove("open"); },
  async "chat-clear"() {
    if (S.sending) return;
    if (!(await confirmBox("Smazat celou konverzaci?"))) return;
    await api("DELETE", `/topics/${S.topic.id}/chat`);
    S.topic.chat = [];
    drawTopic();
  },
  suggest(el) { sendChat(SUGGESTIONS[Number(el.dataset.i)][1]); },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = actions[el.dataset.act];
  if (!act) return;
  if (el.closest("a")) e.preventDefault(); // tlačítka uvnitř karet-odkazů
  Promise.resolve().then(() => act(el)).catch(fail);
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "chat-form") return;
  e.preventDefault();
  const input = $("#chat-text");
  const text = input.value;
  input.value = "";
  sendChat(text);
});

document.addEventListener("keydown", (e) => {
  if (e.target.id === "chat-text" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    e.target.form.requestSubmit();
    return;
  }
  if (e.target.matches("input, textarea") || $("#modals").children.length) return;
  if (S.study && route().view === "t") {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); actions.flip(); }
    else if (S.study.flipped && e.key === "1") rateCard(false);
    else if (S.study.flipped && e.key === "2") rateCard(true);
  } else if (S.quiz && !S.quiz.current && S.quiz.i < S.quiz.questions.length) {
    const q = S.quiz.questions[S.quiz.i];
    const i = "abcdefgh".indexOf(e.key.toLowerCase());
    if (q.type !== "open" && i >= 0 && i < q.options.length) actions["quiz-pick"]({ dataset: { i } });
  }
});

// automatická výška pole chatu
document.addEventListener("input", (e) => {
  if (e.target.id !== "chat-text") return;
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight + 2, 160) + "px";
});

// ---------- start ----------
async function start() {
  S.config = await (await fetch("/api/config")).json();
  if (S.config.needsPassword && !store.get("password")) return renderLogin();
  await refresh();
  render();
}
start().catch((err) => {
  if (!$("#login")) $("#app").innerHTML = `<div class="center-screen"><div class="center-card"><h1>😕</h1><p>${esc(err.message)}</p><button class="btn primary" onclick="location.reload()" style="margin-top:16px">Zkusit znovu</button></div></div>`;
});
