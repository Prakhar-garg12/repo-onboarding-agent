const API = "http://localhost:8000";

const $ = (id) => document.getElementById(id);
const repoUrlInput = $("repo-url");
const loadBtn = $("load-btn");
const repoStatus = $("repo-status");
const questionInput = $("question");
const askBtn = $("ask-btn");
const askStatus = $("ask-status");
const resultSection = $("result-section");
const answeredQuestion = $("answered-question");
const answerBox = $("answer");
const findingsSection = $("findings-section");
const findingsList = $("findings");

let repoId = localStorage.getItem("repoId");
let sessionId = localStorage.getItem("sessionId");
let repoReady = false;
let isAsking = false;
let timer = null;
let startedAt = 0;

// ---------- helpers ----------

function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.className = "status " + kind;
}

// The question box and Ask button are enabled only when a repo is ready
// and no question is currently being answered.
function refreshAskControls() {
  const enabled = repoReady && !isAsking;
  questionInput.disabled = !enabled;
  askBtn.disabled = !enabled;
}

async function api(path, options) {
  let res;
  try {
    res = await fetch(`${API}${path}`, options);
  } catch (e) {
    throw new Error(`Cannot reach the backend at ${API}. Is it running?`);
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail; } catch (_) {}
    const err = new Error(detail || `Server returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function renderMarkdownInto(el, text) {
  if (window.marked && window.DOMPurify) {
    // sanitize: the answer comes from a model, so never insert it as raw HTML
    el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  } else {
    el.textContent = text;
    el.style.whiteSpace = "pre-wrap";
  }
}

function startTimer() {
  stopTimer();
  startedAt = Date.now();
  timer = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    setStatus(askStatus, `The agent is exploring the repository... ${secs}s`);
  }, 1000);
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ---------- loading a repository ----------

async function loadRepo() {
  const repoUrl = repoUrlInput.value.trim();
  if (!repoUrl) {
    setStatus(repoStatus, "Please enter a repository URL.", "error");
    return;
  }

  loadBtn.disabled = true;
  repoReady = false;
  refreshAskControls();
  setStatus(repoStatus, "Submitting...");

  try {
    const data = await api("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo_url: repoUrl }),
    });
    repoId = data.repo_id;
    localStorage.setItem("repoId", repoId);
    localStorage.setItem("repoUrl", repoUrl);
    pollRepo();
  } catch (err) {
    setStatus(repoStatus, err.message, "error");
    loadBtn.disabled = false;
  }
}

async function pollRepo() {
  try {
    const data = await api(`/repos/${repoId}/status`);

    if (data.status === "ready") {
      repoReady = true;
      setStatus(repoStatus, `Ready: ${data.chunk_count} chunks indexed`, "ok");
      loadBtn.disabled = false;
      refreshAskControls();
      return;
    }

    if (data.status === "failed") {
      setStatus(repoStatus, `Failed: ${data.error}`, "error");
      loadBtn.disabled = false;
      return;
    }

    setStatus(repoStatus, `Working... (${data.status})`);
    setTimeout(pollRepo, 2000);
  } catch (err) {
    if (err.status === 404) {
      repoId = null;
      localStorage.removeItem("repoId");
      setStatus(
        repoStatus,
        "The backend no longer knows this repository (it was probably restarted). Please load it again.",
        "error"
      );
    } else {
      setStatus(repoStatus, err.message, "error");
    }
    loadBtn.disabled = false;
  }
}

// ---------- asking a question ----------

async function askQuestion() {
  const question = questionInput.value.trim();
  if (!repoId || !repoReady) {
    setStatus(askStatus, "Load a repository first.", "error");
    return;
  }
  if (!question) {
    setStatus(askStatus, "Please type a question.", "error");
    return;
  }

  isAsking = true;
  refreshAskControls();
  resultSection.hidden = true;
  findingsSection.hidden = true;
  setStatus(askStatus, "Sending question...");

  try {
    const data = await api("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo_id: repoId, question: question }),
    });
    sessionId = data.session_id;
    localStorage.setItem("sessionId", sessionId);
    startTimer();
    pollAnswer();
  } catch (err) {
    setStatus(askStatus, err.message, "error");
    isAsking = false;
    refreshAskControls();
  }
}

async function pollAnswer() {
  try {
    const data = await api(`/ask/${sessionId}`);

    if (data.status === "done") {
      stopTimer();
      setStatus(askStatus, "Done.", "ok");
      showResult(data);
      isAsking = false;
      refreshAskControls();
      return;
    }

    if (data.status === "failed") {
      stopTimer();
      setStatus(askStatus, `The agent failed: ${data.error}`, "error");
      isAsking = false;
      refreshAskControls();
      return;
    }

    if (!timer) startTimer();
    setTimeout(pollAnswer, 3000);
  } catch (err) {
    stopTimer();
    if (err.status === 404) {
      sessionId = null;
      localStorage.removeItem("sessionId");
      setStatus(askStatus, "That question's session is gone (the backend was restarted). Please ask again.", "error");
    } else {
      setStatus(askStatus, err.message, "error");
    }
    isAsking = false;
    refreshAskControls();
  }
}

// ---------- showing the result ----------

function showResult(data) {
  answeredQuestion.textContent = data.question;
  renderMarkdownInto(answerBox, data.final_answer || "(The agent returned no answer.)");
  resultSection.hidden = false;

  findingsList.innerHTML = "";
  data.findings.forEach((f) => {
    const li = document.createElement("li");
    const details = document.createElement("details");
    const summary = document.createElement("summary");

    const badge = document.createElement("span");
    badge.className = "badge " + f.action;
    badge.textContent = f.action;

    const target = document.createElement("code");
    target.textContent = f.target;

    summary.append(badge, " ", target);

    const pre = document.createElement("pre");
    pre.textContent = f.result_summary;

    details.append(summary, pre);
    li.appendChild(details);
    findingsList.appendChild(li);
  });
  findingsSection.hidden = data.findings.length === 0;
}

// ---------- wiring ----------

loadBtn.addEventListener("click", loadRepo);
askBtn.addEventListener("click", askQuestion);
repoUrlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadRepo(); });
questionInput.addEventListener("keydown", (e) => { if (e.key === "Enter") askQuestion(); });

// on page load: resume whatever was in progress before the refresh
repoUrlInput.value = localStorage.getItem("repoUrl") || "";
refreshAskControls();

if (repoId) {
  loadBtn.disabled = true;
  setStatus(repoStatus, "Checking saved repository...");
  pollRepo();
}

if (sessionId) {
  isAsking = true;
  refreshAskControls();
  setStatus(askStatus, "Checking saved question...");
  pollAnswer();
}