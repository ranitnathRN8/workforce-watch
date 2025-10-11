/* HR News Viewer (Calendar date → ISO week)
   - Auto-load week on date change
   - Sort by Significance (desc)
   - Category filter, Search, Pagination (10/page)
   Data path: /data/<year>/<year>-W<week>.json
*/

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------- State ---------- */
const state = {
  allItems: [],   // immutable list from JSON
  filtered: [],   // after category + search, sorted
  meta: null,
  pageSize: 10,
  page: 1
};

/* ----------  view routing ---------- */
state.route = "week";        // "week" | "favourites"
state.favYear = null;        // favourites UI selections
state.favMonth = null;


/* ---------- Helpers ---------- */

// Local yyyy-mm-dd without using UTC (prevents off-by-one day in IST, etc.)
function localISODate(d = new Date()) {
  const tz = d.getTimezoneOffset() * 60000; // minutes -> ms
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

// Parse yyyy-mm-dd as a local date (anchor at noon to dodge DST/UTC edges)
function parseLocalDate(yyyy_mm_dd) {
  // Midday avoids accidental previous/next day shifts
  return new Date(`${yyyy_mm_dd}T12:00:00`);
}

// Return local ISO week as { year: 2025, week: 34 }  (week is NUMBER)
function isoWeekLocal(d) {
  // Use a UTC-anchored clone for ISO-week math, but from the LOCAL date
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Thursday in current week decides the year
  const dow = date.getUTCDay() || 7;                // 1..7
  date.setUTCDate(date.getUTCDate() + 4 - dow);     // move to Thursday
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return { year, week };
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

function navigateToWeekAndLoad(dateStr) {
  const d = parseLocalDate(dateStr || localISODate(new Date()));
  const { year, week } = isoWeekLocal(d);
  // Switch route first so week view becomes visible
  if (location.hash !== '#/') location.hash = '#/';
  // Ensure week view UI is shown (if you have showWeekView(), call it)
  if (typeof showWeekView === 'function') showWeekView();
  // Then load the data
  loadWeek(year, week);
}


/* ---------- Supabase Client ---------- */
let supabase = null;
if (window.SUPABASE_URL && window.SUPABASE_ANON_KEY && window.supabase) {
  supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  console.log("Supabase ready");
} else {
  console.warn("Supabase not configured; favourites disabled");
}

// small helpers for favourites
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function dateFromIsoYearWeek(isoYear, isoWeek) {
  const d = new Date(Date.UTC(isoYear, 0, 1 + (isoWeek - 1) * 7));
  const dow = d.getUTCDay() || 7;
  const th = new Date(d);
  th.setUTCDate(d.getUTCDate() + (4 - dow));
  return th;
}
function weekOfMonthFromDateStr(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const offset = (first.getUTCDay() + 6) % 7; // Monday=0
  const dom = d.getUTCDate();
  return Math.ceil((dom + offset)/7);
}
async function favIsOn(url) {
  if (!supabase) return false;
  const url_hash = await sha256(url);
  const { data, error } = await supabase.from('favourites').select('id').eq('url_hash', url_hash).maybeSingle();
  if (error && error.code !== 'PGRST116') console.warn(error);
  return !!data;
}
async function favToggle({ url, title, summary, isoYear, isoWeek, published }) {
  if (!supabase) return false;
  const url_hash = await sha256(url);
  const { data: existing } = await supabase.from('favourites').select('id').eq('url_hash', url_hash).maybeSingle();
  if (existing) { await supabase.from('favourites').delete().eq('url_hash', url_hash); return false; }
  const day = (published ? new Date(published) : dateFromIsoYearWeek(isoYear, isoWeek)).toISOString().slice(0,10);
  await supabase.from('favourites').insert({
    url_hash, url, title, summary: summary || null, iso_year: isoYear, iso_week: isoWeek, day_date: day
  });
  return true;
}
async function favListByMonth(year, month) {
  if (!supabase) return [];
  const start = new Date(Date.UTC(year, month-1, 1)).toISOString().slice(0,10);
  const end   = new Date(Date.UTC(year, month,   1)).toISOString().slice(0,10);
  const { data, error } = await supabase.from('favourites').select('*').gte('day_date', start).lt('day_date', end).order('day_date', { ascending: false });
  if (error) { console.error(error); return []; }
  return data || [];
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
  return arr.sort((a, b) => {
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
    try { srcDomain = new URL(it.url).hostname.replace(/^www\./, ""); } catch { }

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

    // Create the star button once the card is built
    const favBtn = document.createElement("button");
    favBtn.className = "fav-toggle";
    favBtn.type = "button";
    favBtn.textContent = "☆";                 // default (off)

    // non-blocking init of the state
    (async () => {
      try {
        if (await favIsOn(it.url)) {
          favBtn.textContent = "★";
          favBtn.classList.add("is-on");
          favBtn.title = "Remove from favourites";
        } else {
          favBtn.title = "Add to favourites";
        }
      } catch { }
    })();

    favBtn.addEventListener("click", async () => {
      favBtn.disabled = true;
      const nowOn = await favToggle({
        url: it.url,
        title: it.title || "(untitled)",
        summary: (it.summary_bullets || []).join(" • "),
        isoYear, isoWeek, published: it.published || null
      });
      favBtn.textContent = nowOn ? "★" : "☆";
      favBtn.classList.toggle("is-on", nowOn);
      favBtn.title = nowOn ? "Remove from favourites" : "Add to favourites";
      favBtn.disabled = false;
    });

    // attach to the card (top-right via CSS)
    card.appendChild(favBtn);

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

  const makeBtn = (n) => `<button class="page-btn ${n === p ? "active" : ""}" data-page="${n}">${n}</button>`;
  const ellipsis = `<span class="ellipsis">…</span>`;
  const windowStart = Math.max(1, p - 2);
  const windowEnd = Math.min(pages, p + 2);

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

// ----- FAVOURITES VIEW -----
function initFavSelectorsOnce() {
  const ySel = document.getElementById("fav-year");
  const mSel = document.getElementById("fav-month");
  if (!ySel || !mSel) return;

  // Run only once
  if (ySel.dataset.init === "1") return;

  const now = new Date();
  const currentYear = now.getUTCFullYear();

  // ---- Year select (current year default) ----
  ySel.innerHTML = "";
  for (let y = currentYear - 2; y <= currentYear + 1; y++) {
    const o = document.createElement("option");
    o.value = String(y);
    o.textContent = String(y);
    if (y === currentYear) o.selected = true;
    ySel.appendChild(o);
  }

  // ---- Month select (All by default) ----
  mSel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";                 // empty = All months
  optAll.textContent = "All";
  optAll.selected = true;            // default to All
  mSel.appendChild(optAll);

  for (let m = 1; m <= 12; m++) {
    const o = document.createElement("option");
    o.value = String(m);
    o.textContent = String(m).padStart(2, "0");
    mSel.appendChild(o);
  }

  // ---- Wire listeners (only once) ----
  ySel.addEventListener("change", refreshFavs);
  mSel.addEventListener("change", refreshFavs);

  // Mark initialized so we don't rebuild/wire twice
  ySel.dataset.init = "1";
}

async function refreshFavs() {
  const y = +$("#fav-year").value;
  const m = $("#fav-month").value === "all" ? "all" : +$("#fav-month").value;
  state.favYear = y;
  state.favMonth = m;

  const listEl = $("#fav-list");
  listEl.innerHTML = "Loading...";
  const rows = await favListByMonth(y, m);

  if (!rows.length) {
    listEl.innerHTML = "<p>No favourites yet.</p>";
    return;
  }

  // Create grid like normal view
  listEl.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "grid";

  for (const r of rows) {
    const card = document.createElement("div");
    card.className = "card";

    card.innerHTML = `
      <div class="title"><a href="${r.url}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></div>
      <div class="meta-line">
        <span class="badge">${escapeHtml(r.category || "Misc")}</span>
        <span class="src">${r.source || ""}</span>
      </div>
      <ul class="bullets">${(r.bullets || [])
        .map((b) => `<li>${escapeHtml(b)}</li>`)
        .join("")}</ul>
      <div class="companies">
        ${(r.tags || [])
          .map((t) => `<span class="chip">${escapeHtml(t)}</span>`)
          .join("")}
      </div>
      <button class="fav-toggle is-on" title="Remove from Favourites">★</button>
    `;

    const favBtn = card.querySelector(".fav-toggle");
    favBtn.addEventListener("click", async () => {
      await removeFav(r.url);
      card.remove();
      if (!grid.children.length) listEl.innerHTML = "<p>No favourites yet.</p>";
    });

    grid.appendChild(card);
  }

  listEl.appendChild(grid);
}

async function showFavouritesView() {
  state.route = "favourites";

  // Hide week list + meta + pagination
  $("#results").style.display = "none";
  $("#meta").style.display = "none";
  $("#pagination")?.classList.add("hidden");

  // Show favourites view
  $("#favourites-view").hidden = false;

  // Highlight top bar button (if present)
  document.getElementById("openFavourites")?.classList.add("active");

  // Ensure selectors exist and are set
  initFavSelectorsOnce();

  const ySel = document.getElementById("fav-year");
  const mSel = document.getElementById("fav-month");

  // Always default to current year + All months when opening
  const now = new Date();
  ySel.value = String(now.getUTCFullYear());
  mSel.value = "";     // empty string means "All"

  await refreshFavs();
}

function showWeekView() {
  state.route = "week";
  $("#favourites-view").hidden = true;
  $("#results").style.display = "";   // show weekly list
  $("#meta").style.display = "";      // show meta
  $("#pagination")?.classList.remove("hidden");
  document.getElementById("openFavourites")?.classList.remove("active");
}

// ----- tiny router -----
function routeFromHash() {
  return location.hash.startsWith("#/favourites") ? "favourites" : "week";
}
window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#/favourites")) {
    showFavouritesView();
  } else {
    // Back to week view: load the currently selected day (or today)
    const v = $("#day")?.value || localISODate(new Date());
    navigateToWeekAndLoad(v);
  }
});


/* ---------- Data loading ---------- */
function setItems(items, meta) {
  state.allItems = Array.isArray(items) ? items.slice() : [];
  state.meta = meta || null;
  buildCategoryOptions(state.allItems);
  applyFilters();
  render(paginatedItems(), state.meta || { items: [], generated_at: "" });
}

async function loadWeek(year, week) {
  const path = `data/${year}/${year}-W${pad2(week)}.json`;
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
  $("#day")?.addEventListener("change", () => {
    const v = $("#day").value;
    if (!v) return;
    navigateToWeekAndLoad(v);
  });

  // Calendar icon opens the picker
  $("#openPicker").addEventListener("click", () => {
    const el = $("#day");
    if (el.showPicker) el.showPicker();
    else el.focus();
  });

  // Today: set date + load (LOCAL today)
  $("#loadToday")?.addEventListener("click", () => {
    const today = localISODate(new Date());
    $("#day").value = today;
    navigateToWeekAndLoad(today);
  });


  $("#category").addEventListener("change", () => {
    applyFilters();
    render(paginatedItems(), state.meta || { items: [], generated_at: "" });
  });

  $("#search").addEventListener("input", () => {
    applyFilters();
    render(paginatedItems(), state.meta || { items: [], generated_at: "" });
  });

  $("#openFavourites").addEventListener("click", () => { location.hash = "#/favourites"; });

  // also ensure default route on load
  if (!location.hash) location.hash = "#/week";
}

window.addEventListener("DOMContentLoaded", () => {
  // Default: local today
  const today = localISODate(new Date());
  $("#day").value = today;
  attachEvents();
  const { year, week } = isoWeekLocal(parseLocalDate(today));
  loadWeek(year, week);
});

window.addEventListener("DOMContentLoaded", () => {
  // existing: set date + load week
  const today = localISODate(new Date());
  $("#day").value = today;
  const { year, week } = isoWeekLocal(parseLocalDate(today));
  attachEvents();

  if (routeFromHash() === "favourites") {
    showFavouritesView();
  } else {
    loadWeek(year, week);
  }
});
