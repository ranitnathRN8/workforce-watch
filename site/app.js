/* HR News Viewer (Calendar date → ISO week)
   - Auto-load week on date change
   - Sort by Significance (desc)
   - Category filter, Search, Pagination (10/page)
   Data path: /data/<year>/<year>-W<week>.json
*/

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------- State ---------- */
const state = {
  allItems: [],   // immutable list from JSON
  filtered: [],   // after category + search, sorted
  meta: null,
  pageSize: 10,
  page: 1
};

/* ---------- Helpers ---------- */
function isoWeek(date) {
  // ISO-8601 week calculation
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return [d.getUTCFullYear(), weekNo];
}
const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.json();
}

function starBar(n) {
  const s = Math.max(1, Math.min(5, Number(n) || 1));
  return "★".repeat(s) + "☆".repeat(5 - s);
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

/* ---------- Category dropdown ---------- */
function buildCategoryOptions(items) {
  const sel = $("#category");
  const current = sel.value || "";
  const cats = new Set(items.map(it => it.category || "Uncategorized"));
  sel.innerHTML =
    `<option value="">All categories</option>` +
    [...cats].sort().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if ([...cats].includes(current)) sel.value = current; else sel.value = "";
}

/* ---------- Filtering + Sorting + Pagination ---------- */
function sortBySignificanceDesc(arr) {
  return arr.sort((a,b) => {
    const sa = Number(a.significance) || 0;
    const sb = Number(b.significance) || 0;
    if (sb !== sa) return sb - sa;
    // tie-breakers
    const pa = a.published || "";
    const pb = b.published || "";
    if (pa !== pb) return (pb > pa) ? 1 : -1;
    return (a.title || "").localeCompare(b.title || "");
  });
}

function applyFilters() {
  const q = ($("#search").value || "").toLowerCase().trim();
  const cat = $("#category").value || "";

  const out = state.allItems.filter(it => {
    const inCat = !cat || (it.category === cat);
    if (!inCat) return false;

    if (!q) return true;
    const t = (it.title || "").toLowerCase();
    const b = (it.summary_bullets || []).some(x => (x || "").toLowerCase().includes(q));
    const c = (it.companies || []).some(x => (x || "").toLowerCase().includes(q));
    return t.includes(q) || b || c;
  });

  state.filtered = sortBySignificanceDesc(out);
  state.page = 1;
}

function paginatedItems() {
  const start = (state.page - 1) * state.pageSize;
  return state.filtered.slice(start, start + state.pageSize);
}

function totalPages() {
  return Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
}

/* ---------- Rendering ---------- */
function render(items, meta) {
  const container = $("#results");
  container.innerHTML = "";

  if (!items || !items.length) {
    container.innerHTML = `<div class="empty">No items for the selected week.</div>`;
    $("#meta").textContent = "";
    renderPagination();
    return;
  }

  const frag = document.createDocumentFragment();

  items.forEach(it => {
    const card = document.createElement("div");
    card.className = "card";

    let srcDomain = "";
    try { srcDomain = new URL(it.url).hostname.replace(/^www\./, ""); } catch {}

    card.innerHTML = `
      <h3 class="title"><a href="${it.url}" target="_blank" rel="noopener">${escapeHtml(it.title || "(untitled)")}</a></h3>

      <div class="meta-line">
        <span class="badge">${escapeHtml(it.category || "Uncategorized")}</span>
      </div>

      <div class="meta-line">
        <span class="stars" title="Significance">${starBar(it.significance || 1)}</span>
      </div>

      <div class="meta-line">
        <span class="src">${escapeHtml(srcDomain)}</span>
      </div>

      <ul class="bullets">
        ${(it.summary_bullets || []).map(b => `<li>${escapeHtml(b)}</li>`).join("")}
      </ul>

      ${(it.companies && it.companies.length)
        ? `<div class="companies">` + it.companies.map(c => `<span class="chip">${escapeHtml(c)}</span>`).join("") + `</div>`
        : ``
      }
    `;
    frag.appendChild(card);
  });

  container.appendChild(frag);
  $("#meta").textContent = `${meta.items.length} items • Generated at ${meta.generated_at}`;
  renderPagination();
}

function renderPagination() {
  let bar = $("#pagination");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "pagination";
    $("#results").insertAdjacentElement("afterend", bar);
  }
  const pages = totalPages();
  const p = state.page;

  if (!state.filtered.length) { bar.innerHTML = ""; return; }

  const buttons = [];
  buttons.push(`<button class="page-btn" data-act="prev" ${p === 1 ? "disabled" : ""}>‹ Prev</button>`);

  const makeBtn = (n) => `<button class="page-btn ${n===p?"active":""}" data-page="${n}">${n}</button>`;
  const ellipsis = `<span class="ellipsis">…</span>`;
  const windowStart = Math.max(1, p - 2);
  const windowEnd   = Math.min(pages, p + 2);

  if (windowStart > 1) buttons.push(makeBtn(1));
  if (windowStart > 2) buttons.push(ellipsis);
  for (let i = windowStart; i <= windowEnd; i++) buttons.push(makeBtn(i));
  if (windowEnd < pages - 1) buttons.push(ellipsis);
  if (windowEnd < pages) buttons.push(makeBtn(pages));

  buttons.push(`<button class="page-btn" data-act="next" ${p === pages ? "disabled" : ""}>Next ›</button>`);

  bar.className = "pagination";
  bar.innerHTML = buttons.join("");

  $$("#pagination .page-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const act = btn.getAttribute("data-act");
      const pagesNow = totalPages();
      if (act === "prev" && state.page > 1) state.page--;
      else if (act === "next" && state.page < pagesNow) state.page++;
      else {
        const pg = parseInt(btn.getAttribute("data-page") || "0", 10);
        if (pg) state.page = pg;
      }
      render(paginatedItems(), state.meta || { items: [], generated_at: "" });
    });
  });
}

/* ---------- Data loading ---------- */
function setItems(items, meta) {
  state.allItems = Array.isArray(items) ? items.slice() : [];
  state.meta = meta || null;
  buildCategoryOptions(state.allItems);
  applyFilters();
  render(paginatedItems(), state.meta || { items: [], generated_at: "" });
}

async function loadWeek(year, week) {
  const path = `/data/${year}/${year}-W${pad2(week)}.json`;
  try {
    const data = await fetchJSON(path);
    setItems(data.items || [], data);
  } catch (e) {
    $("#results").innerHTML = `<div class="empty">No weekly file found: ${path}</div>`;
    $("#meta").textContent = "";
    renderPagination();
  }
}

/* ---------- UI bootstrap ---------- */
function attachEvents() {
  // Auto-load the week when date changes
  $("#day").addEventListener("change", () => {
    const v = $("#day").value;
    const d = v ? new Date(v) : new Date();
    if (isNaN(d)) return;
    const [y, w] = isoWeek(d);
    loadWeek(y, w);
  });

  // Calendar icon opens the picker
  $("#openPicker").addEventListener("click", () => {
    const el = $("#day");
    if (el.showPicker) el.showPicker();
    else el.focus();
  });

  // Today: set date + load
  $("#loadToday").addEventListener("click", () => {
    const d = new Date();
    $("#day").value = d.toISOString().slice(0,10);
    const [y, w] = isoWeek(d);
    loadWeek(y, w);
  });

  $("#category").addEventListener("change", () => {
    applyFilters();
    render(paginatedItems(), state.meta || { items: [], generated_at: "" });
  });

  $("#search").addEventListener("input", () => {
    applyFilters();
    render(paginatedItems(), state.meta || { items: [], generated_at: "" });
  });
}

window.addEventListener("DOMContentLoaded", () => {
  // Default: today
  const d = new Date();
  $("#day").value = d.toISOString().slice(0,10);
  attachEvents();
  const [y, w] = isoWeek(d);
  loadWeek(y, w);
});
