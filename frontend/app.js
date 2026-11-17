const API = "http://localhost:8000";
const $ = (id) => document.getElementById(id);
const PARTIAL = / \(from character \d+\)$/;
const normalize = (p) => (String(p || ".").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") || ".");

// tree
const Graph = (() => {
  const pane = $("graph-pane");
  const svg = d3.select("#graph");
  const vp = svg.append("g");                      
  const linkG = vp.append("g"), trailG = vp.append("g"), nodeG = vp.append("g");
  const zoom = d3.zoom().scaleExtent([0.2, 4]).on("zoom", (e) => vp.attr("transform", e.transform));
  svg.call(zoom).on("dblclick.zoom", null);

  const ROW = 22;    // vertical space between nodes
  const COL = 200;   // horizontal space between levels

  let byId = new Map();          // id -> node
  let kids = new Map();          // folder id -> its children (sorted)
  let open = new Set(["."]);     // folders that are currently expanded
  let laid = new Map();          // id -> position computed by d3.tree
  let nodeSel = null;
  let trail = [], pos = ".", active = false;
  const sets = { listed: new Set(), read: new Set(), match: new Set(), seen: new Set() };

  // 1) receive the flat list from the backend and build lookups
  function setTree(data) {
    clear();
    const nodes = data.nodes.map((n) => ({ ...n }));
    byId = new Map(nodes.map((n) => [n.id, n]));
    kids = new Map();
    nodes.forEach((n) => {
      if (n.parent === null) return;
      if (!kids.has(n.parent)) kids.set(n.parent, []);
      kids.get(n.parent).push(n);
    });
    // folders first, then files, each A-Z
    kids.forEach((list) =>
      list.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
    );
    open = new Set(["."]);
    render(true);
  }

  const radius = (n) => (n.id === "." ? 8 : n.type === "dir" ? 5 : 3);

  // 2) draw only the folders that are open
  function render(refit) {
    if (!byId.has(".")) return;

    const root = d3.hierarchy(byId.get("."), (d) => (open.has(d.id) ? kids.get(d.id) : null));
    d3.tree().nodeSize([ROW, COL])(root);        // d3 sets .x (vertical) and .y (horizontal)
    const list = root.descendants();
    laid = new Map(list.map((d) => [d.data.id, d]));

    linkG.selectAll("path")
      .data(root.links(), (d) => d.target.data.id)
      .join("path")
      .attr("class", "link")
      .attr("fill", "none")
      .attr("d", d3.linkHorizontal().x((d) => d.y).y((d) => d.x));

    nodeSel = nodeG.selectAll("g.node")
      .data(list, (d) => d.data.id)
      .join((enter) => {
        const g = enter.append("g")
          .attr("class", (d) => "node " + d.data.type)
          .on("click", (e, d) => toggle(d.data.id));
        g.append("circle").attr("class", "halo").attr("r", (d) => radius(d.data) + 3);
        g.append("circle").attr("class", "body").attr("r", (d) => radius(d.data));
        g.append("text").attr("x", (d) => radius(d.data) + 6).attr("y", 3);
        g.append("title").text((d) => d.data.id);
        return g;
      })
      .classed("show", true)                      // always show labels in a tree
      .style("cursor", (d) => (kids.has(d.data.id) ? "pointer" : "default"))
      .attr("transform", (d) => `translate(${d.y},${d.x})`);

    // a closed folder gets a "+" so you know you can click it
    nodeSel.select("text").text((d) => {
      const n = d.data;
      const closed = n.type === "dir" && kids.has(n.id) && !open.has(n.id);
      return n.name + (closed ? "  +" : "");
    });

    paint();
    if (refit) fit(list);
  }

  // 3) colours + the dashed trail of the agent's path
  function paint() {
    if (!nodeSel) return;
    nodeSel
      .classed("seen", (d) => sets.seen.has(d.data.id))
      .classed("listed", (d) => sets.listed.has(d.data.id))
      .classed("match", (d) => sets.match.has(d.data.id))
      .classed("read", (d) => sets.read.has(d.data.id))
      .classed("visited", (d) => sets.listed.has(d.data.id) || sets.read.has(d.data.id) || sets.match.has(d.data.id))
      .classed("current", (d) => active && d.data.id === pos);

    trailG.selectAll("path")
      .data(trail)
      .join("path")
      .attr("class", "trail")
      .attr("d", (t) => {
        const a = laid.get(t.from), b = laid.get(t.to);
        if (!a || !b) return null;                
        const mid = (a.y + b.y) / 2;
        return `M${a.y},${a.x}C${mid},${a.x} ${mid},${b.x} ${b.y},${b.x}`;
      });
  }

  function fit(list) {
    const w = pane.clientWidth, h = pane.clientHeight;
    const [x0, x1] = d3.extent(list, (n) => n.x), [y0, y1] = d3.extent(list, (n) => n.y);
    const k = Math.min(1.2, 0.9 * Math.min(w / (y1 - y0 + COL), h / (x1 - x0 + 60)));
    svg.transition().duration(500).call(
      zoom.transform,
      d3.zoomIdentity.translate(50 - k * y0, h / 2 - (k * (x0 + x1)) / 2).scale(k)
    );
  }

  // click a folder to open / close it
  function toggle(id) {
    if (!kids.has(id)) return;
    open.has(id) ? open.delete(id) : open.add(id);
    render(false);
  }

  // open every folder above a node so the node is visible
  function reveal(id) {
    let p = byId.get(id) && byId.get(id).parent;
    while (p !== null && p !== undefined) {
      open.add(p);
      p = byId.get(p).parent;
    }
  }

  // called for every step the agent takes
  function apply(f) {
    const path = normalize(f.target.replace(PARTIAL, ""));
    let hits = [];
    if (f.action === "list_dir" && byId.has(path)) {
      sets.listed.add(path);
      (kids.get(path) || []).forEach((n) => sets.seen.add(n.id));
      open.add(path);
      hits = [path];
    } else if (f.action === "read_file" && byId.has(path)) {
      sets.read.add(path);
      hits = [path];
    } else if (f.action === "search_code") {
      const m = /^Matched files: (.*)$/m.exec(f.result_summary);
      hits = m ? m[1].split(" | ").map(normalize).filter((id) => byId.has(id)) : [];
      hits.forEach((id) => sets.match.add(id));
    }
    hits.forEach(reveal);
    if (hits.length) {
      if (pos !== hits[0]) trail.push({ from: pos, to: hits[0] });
      pos = hits[0];
    }
    render(true);
  }

  function reset(on = false) {            // forget the exploration, keep the map
    Object.values(sets).forEach((s) => s.clear());
    trail = []; pos = "."; active = on;
    open = new Set(["."]);
    render(true);
  }

  function clear() {
    byId = new Map(); kids = new Map(); nodeSel = null; laid = new Map();
    reset();
    [linkG, trailG, nodeG].forEach((g) => g.selectAll("*").remove());
  }

  return { setTree, apply, reset, clear, setActive: (on) => { active = on; paint(); } };
})();

// ---------------------------------------------------------------- page
const repoUrlInput = $("repo-url"), loadBtn = $("load-btn"), repoStatus = $("repo-status");
const questionInput = $("question"), askBtn = $("ask-btn"), askStatus = $("ask-status");
const outputCard = $("output-card"), findingsList = $("findings"), answerBox = $("answer");
const tabActivity = $("tab-activity"), tabAnswer = $("tab-answer");
const expandBtn = $("expand-btn"), stepCount = $("step-count");
const tabBody = document.querySelector(".tab-body"), workspace = $("workspace");
const graphEmpty = $("graph-empty"), pill = $("pill");

let repoId = localStorage.getItem("repoId");
let sessionId = localStorage.getItem("sessionId");
let repoReady = false, asking = false, shown = 0, timer = null;
let answerReady = false, justLoaded = false;
let repoGen = 0, askGen = 0, treeFor = null, treeReady = Promise.resolve();

const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const setStatus = (el, text, kind = "") => { el.textContent = text; el.className = "status " + kind; };
const refresh = () => { const on = repoReady && !asking; questionInput.disabled = askBtn.disabled = !on; };

async function api(path, options) {
  let res;
  try { res = await fetch(API + path, options); }
  catch { throw new Error("Cannot reach the backend. Is it running?"); }
  if (!res.ok) {
    const err = new Error((await res.json().catch(() => ({}))).detail || "Server returned " + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function ensureTree() {
  if (repoId && treeFor !== repoId) {
    const id = (treeFor = repoId);
    treeReady = api(`/repos/${id}/tree`)
      .then((d) => { Graph.setTree(d); graphEmpty.hidden = true; })
      .catch(() => { treeFor = null; });
  }
  return treeReady;
}

function startTimer() {
  stopTimer();
  const t0 = Date.now();
  const tick = () => setStatus(askStatus, `The agent is exploring… ${Math.round((Date.now() - t0) / 1000)}s`);
  tick();
  timer = setInterval(tick, 1000);
}
function stopTimer() { clearInterval(timer); timer = null; }

// ---- tabs
function closeFull() {
  outputCard.classList.remove("full");
  expandBtn.textContent = "Expand ⤢";
}

function showTab(name) {
  const answer = name === "answer";
  if (!answer) closeFull();
  findingsList.hidden = answer;
  answerBox.hidden = !answer;
  tabActivity.classList.toggle("active", !answer);
  tabAnswer.classList.toggle("active", answer);
  expandBtn.hidden = !(answer && answerReady);
  tabBody.scrollTop = 0;
}

function clearRun() {
  shown = 0; answerReady = false;
  findingsList.innerHTML = ""; answerBox.innerHTML = ""; stepCount.textContent = "";
  pill.hidden = true;
  Graph.reset();
}

// ---- repository
async function loadRepo() {
  const url = repoUrlInput.value.trim();
  if (!url) return setStatus(repoStatus, "Please enter a repository URL.", "error");

  loadBtn.disabled = true; repoReady = false; asking = false; askGen++; stopTimer(); refresh();
  clearRun(); outputCard.hidden = true; closeFull();
  sessionId = null; localStorage.removeItem("sessionId");
  Graph.clear(); treeFor = null; graphEmpty.hidden = false;
  setStatus(repoStatus, "Submitting…"); setStatus(askStatus, "");
  try {
    const d = await api("/repos", post({ repo_url: url }));
    repoId = d.repo_id;
    justLoaded = true;
    localStorage.setItem("repoId", repoId);
    localStorage.setItem("repoUrl", url);
    pollRepo(++repoGen);
  } catch (e) {
    loadBtn.disabled = false;
    setStatus(repoStatus, e.message, "error");
  }
}

async function pollRepo(my) {
  try {
    const d = await api(`/repos/${repoId}/status`);
    if (my !== repoGen) return;
    if (d.status === "ready") {
      repoReady = true; loadBtn.disabled = false; refresh();
      setStatus(repoStatus, `Ready · ${d.chunk_count} chunks indexed`, "ok");
      ensureTree();
      if (justLoaded) {                      // bring the workspace into view after a fresh load
        justLoaded = false;
        workspace.scrollIntoView({ behavior: "smooth" });
      }
    } else if (d.status === "failed") {
      loadBtn.disabled = false;
      setStatus(repoStatus, "Failed: " + d.error, "error");
    } else {
      setStatus(repoStatus, "Working… " + d.status);
      setTimeout(() => pollRepo(my), 1500);
    }
  } catch (e) {
    if (my !== repoGen) return;
    loadBtn.disabled = false;
    if (e.status === 404) { repoId = null; localStorage.removeItem("repoId"); }
    setStatus(repoStatus, e.status === 404 ? "The backend no longer has this repository. Click Load to add it again." : e.message, "error");
  }
}

// ---- questions
async function askQuestion() {
  const q = questionInput.value.trim();
  if (!repoReady || !q) return setStatus(askStatus, repoReady ? "Please type a question." : "Load a repository first.", "error");

  asking = true; refresh(); clearRun();
  outputCard.hidden = false; tabAnswer.disabled = true; showTab("activity");
  setStatus(askStatus, "Sending question…");
  try {
    const d = await api("/ask", post({ repo_id: repoId, question: q }));
    sessionId = d.session_id;
    localStorage.setItem("sessionId", sessionId);
    pollAnswer(++askGen);
  } catch (e) {
    asking = false; refresh();
    setStatus(askStatus, e.message, "error");
  }
}

async function pollAnswer(my) {
  try {
    const d = await api(`/ask/${sessionId}`);
    if (my !== askGen) return;
    await ensureTree();
    outputCard.hidden = false;
    d.findings.slice(shown).forEach(addStep);
    shown = d.findings.length;
    stepCount.textContent = shown || "";

    const running = d.status === "running";
    Graph.setActive(running);
    pill.hidden = !running;
    pill.textContent = `Exploring · ${shown} step${shown === 1 ? "" : "s"}`;
    if (running) {
      if (!timer) startTimer();
      return setTimeout(() => pollAnswer(my), 1200);
    }
    finish(d);
  } catch (e) {
    if (my !== askGen) return;
    stopTimer(); asking = false; refresh(); pill.hidden = true; Graph.setActive(false);
    if (e.status === 404) { sessionId = null; localStorage.removeItem("sessionId"); }
    setStatus(askStatus, e.status === 404 ? "That session is gone (the backend restarted). Please ask again." : e.message, "error");
  }
}

function finish(d) {
  stopTimer(); asking = false; refresh();
  if (d.status === "failed") return setStatus(askStatus, "The agent failed: " + d.error, "error");
  setStatus(askStatus, "Done.", "ok");
  const text = d.final_answer || "(The agent returned no answer.)";
  if (window.marked && window.DOMPurify) answerBox.innerHTML = DOMPurify.sanitize(marked.parse(text));
  else answerBox.textContent = text;
  answerReady = true;
  tabAnswer.disabled = false;
  showTab("answer");                        // switch to the answer automatically
}

function addStep(f) {
  Graph.apply(f);
  const li = document.createElement("li");
  li.innerHTML = "<details><summary><span class='badge'></span><code></code></summary><pre></pre></details>";
  const badge = li.querySelector(".badge");
  badge.textContent = f.action;
  badge.classList.add(f.action);
  li.querySelector("code").textContent = f.target;
  li.querySelector("pre").textContent = f.result_summary;
  findingsList.appendChild(li);
  if (!findingsList.hidden) tabBody.scrollTop = tabBody.scrollHeight;   // follow the newest step
}

// ---- wiring
loadBtn.addEventListener("click", loadRepo);
askBtn.addEventListener("click", askQuestion);
repoUrlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadRepo(); });
questionInput.addEventListener("keydown", (e) => { if (e.key === "Enter") askQuestion(); });
tabActivity.addEventListener("click", () => showTab("activity"));
tabAnswer.addEventListener("click", () => showTab("answer"));
expandBtn.addEventListener("click", () => {
  expandBtn.textContent = outputCard.classList.toggle("full") ? "Close ✕" : "Expand ⤢";
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFull(); });

repoUrlInput.value = localStorage.getItem("repoUrl") || "";
refresh();
if (repoId) {
  loadBtn.disabled = true;
  setStatus(repoStatus, "Checking saved repository…");
  pollRepo(++repoGen);
}
if (sessionId) {
  asking = true; refresh();
  setStatus(askStatus, "Checking saved question…");
  pollAnswer(++askGen);
}