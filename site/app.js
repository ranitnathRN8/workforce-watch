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
  page: 1,
  route: "week",        // "week" | "favourites"
  favYear: null,
  favMonth: null,
};

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
  if (typeof showWeekView === 'function') showWeekView();
  // Then load the data
  loadWeek(year, week);
}

// Parse week values that might be "41", "W41", or "2025-W41" -> 41
function parseIsoWeekish(val) {
  if (Number.isInteger(val)) return val;
  if (typeof val === "string") {
    const m = val.match(/W(\d{1,2})$/i) || val.match(/(\d{1,2})$/);
    if (m) {
      const n = +m[1];
      if (Number.isInteger(n)) return n;
    }
    const n = parseInt(val, 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}


/* ---------- Supabase Client (single global) ---------- */
// Prefer build-time env (bundlers) then runtime env.js
const SUPABASE_URL =
  (typeof process !== "undefined" && process.env?.SUPABASE_URL) || // optional (bundler/dev)
  window.SUPABASE_URL;

const SUPABASE_ANON_KEY =
  (typeof process !== "undefined" && process.env?.SUPABASE_ANON_KEY) || // optional (bundler/dev)
  window.SUPABASE_ANON_KEY;

const supa =
  (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

if (!supa) console.warn("⚠️ Supabase not configured; favourites disabled");


/* ---------- Favourites helpers ---------- */
// Robust sha256 with fallback for non-secure origins
async function sha256(text) {
  // Prefer WebCrypto when available (secure origins)
  if (window.crypto && window.crypto.subtle) {
    const buf = await window.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text)
    );
    return [...new Uint8Array(buf)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Fallback: FNV-1a 32-bit (non-cryptographic but stable)
  // Ensures favourites still work on "Not Secure" local hosts.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // h *= 16777619 (with overflow), written as shifts for speed
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  h >>>= 0;
  return h.toString(16).padStart(8, "0"); // shorter, but unique enough as a key
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
  return Math.ceil((dom + offset) / 7);
}
async function favIsOn(url) {
  if (!supa) return false;
  const url_hash = await sha256(url);
  const { data, error } = await supa.from('favourites').select('id').eq('url_hash', url_hash).maybeSingle();
  if (error && error.code !== 'PGRST116') console.warn(error);
  return !!data;
}

// --- helpers: robust date parsing + safe day resolver ---
function toValidDate(x) {
  if (x instanceof Date && !isNaN(x)) return x;
  if (typeof x === "number") {
    const d = new Date(x);
    return isNaN(d) ? null : d;
  }
  if (typeof x === "string" && x.trim()) {
    const t = Date.parse(x);
    if (!Number.isNaN(t)) return new Date(t);
  }
  return null;
}

function resolveDayDate(isoYear, isoWeek, published) {
  // 1) published wins if valid
  const pd = toValidDate(published);
  if (pd) return pd.toISOString().slice(0, 10);

  // 2) try the passed isoYear/isoWeek
  const y1 = Number(isoYear);
  const w1 = parseIsoWeekish(isoWeek);
  if (Number.isInteger(y1) && Number.isInteger(w1)) {
    return dateFromIsoYearWeek(y1, w1).toISOString().slice(0, 10);
  }

  // 3) try state.meta
  const y2 = Number(state?.meta?.iso_year ?? state?.meta?.year);
  const w2 = parseIsoWeekish(state?.meta?.iso_week ?? state?.meta?.week);
  if (Number.isInteger(y2) && Number.isInteger(w2)) {
    return dateFromIsoYearWeek(y2, w2).toISOString().slice(0, 10);
  }

  // 4) fallback: today (local)
  return localISODate(new Date());
}

async function favToggle(article, { isoYear, isoWeek, published } = {}) {
  if (!supa) return false;

  const url_hash = await sha256(article.url);

  // Already a favourite?
  const { data: exists, error: checkErr } = await supa
    .from("favourites")
    .select("id")
    .eq("url_hash", url_hash)
    .maybeSingle();
  if (checkErr && checkErr.code !== "PGRST116") console.error("favToggle check error:", checkErr);

  if (exists) {
    const { error: delErr } = await supa.from("favourites").delete().eq("url_hash", url_hash);
    if (delErr) { console.error("favToggle delete error:", delErr); return true; }
    return false; // OFF
  }

  // Normalize year/week
  const yearFinal =
    Number.isInteger(isoYear) ? isoYear :
      Number(state?.meta?.iso_year ?? state?.meta?.year);

  const weekFinal =
    parseIsoWeekish(isoWeek) ??
    parseIsoWeekish(state?.meta?.iso_week ?? state?.meta?.week);

  const day = resolveDayDate(yearFinal, weekFinal, published);

  const payload = {
    url_hash,
    url: article.url,
    title: article.title || "(untitled)",
    summary: (article.summary_bullets || []).join(" • ") || null,
    iso_year: yearFinal ?? null,              // INTEGER
    iso_week: weekFinal ?? null,              // INTEGER
    day_date: day                             // "YYYY-MM-DD"
  };

  const { error: insErr } = await supa.from("favourites").insert(payload);
  if (insErr) {
    console.error("favToggle insert error:", insErr, payload);
    return false;
  }
  return true; // ON
}

async function removeFav(url) {
  if (!supa) return;
  const url_hash = await sha256(url);
  await supa.from('favourites').delete().eq('url_hash', url_hash);
}
async function favListByMonth(year, month) {
  if (!supa) return [];
  if (!month || month === 'all' || month === "") {
    const { data, error } = await supa.from('favourites')
      .select('*').eq('iso_year', year).order('day_date', { ascending: false });
    if (error) { console.error(error); return []; }
    return data || [];
  }
  const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const { data, error } = await supa.from('favourites')
    .select('*').gte('day_date', start).lt('day_date', end).order('day_date', { ascending: false });
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
  // ✅ ensure these exist for favourites payload
  // Get year/week from meta and normalize
  const metaYear = Number(meta?.iso_year ?? meta?.year);
  const metaWeek = parseIsoWeekish(meta?.iso_week ?? meta?.week);
  const { year: isoYear, week: isoWeek } = (meta && (meta.iso_year || meta.year))
    ? { year: meta.iso_year || meta.year, week: meta.iso_week || meta.week }
    : (state.meta || {});

  items.forEach(it => {
    const card = document.createElement("div");
    card.className = "card";

    let srcDomain = "";
    try { srcDomain = new URL(it.url).hostname.replace(/^www\./, ""); } catch { }

    card.innerHTML = `
      <h3 class="title"><a href="${it.url}" target="_blank" rel="noopener">${escapeHtml(it.title || "(untitled)")}</a></h3>
      <div class="meta-line"><span class="badge">${escapeHtml(it.category || "Uncategorized")}</span></div>
      <div class="meta-line"><span class="stars" title="Significance">${starBar(it.significance || 1)}</span></div>
      <div class="meta-line"><span class="src">${escapeHtml(srcDomain)}</span></div>
      <ul class="bullets">${(it.summary_bullets || []).map(b => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
      ${(it.companies && it.companies.length)
        ? `<div class="companies">${it.companies.map(c => `<span class="chip">${escapeHtml(c)}</span>`).join("")}</div>` : ``}
    `;

    // ⭐ top-right favourite toggle
    const favBtn = document.createElement("button");
    favBtn.className = "fav-toggle";
    favBtn.type = "button";
    favBtn.textContent = "☆";

    // init async
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
      const on = await favToggle(
        { url: it.url, title: it.title, summary_bullets: it.summary_bullets },
        { isoYear: metaYear, isoWeek: metaWeek, published: it.published || null }
      );
      favBtn.textContent = on ? "★" : "☆";
      favBtn.classList.toggle("is-on", on);
      favBtn.title = on ? "Remove from favourites" : "Add to favourites";
      favBtn.disabled = false;
    });

    card.appendChild(favBtn);
    frag.appendChild(card);
  });

  container.appendChild(frag);
  $("#meta").textContent = `${meta.items?.length ?? items.length} items • Generated at ${meta.generated_at || ""}`;
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

/* ---------- FAVOURITES VIEW ---------- */
function initFavSelectorsOnce() {
  const ySel = document.getElementById("fav-year");
  const mSel = document.getElementById("fav-month");
  if (!ySel || !mSel) return;
  if (ySel.dataset.init === "1") return;

  const now = new Date();
  const currentYear = now.getUTCFullYear();

  // Year select
  ySel.innerHTML = "";
  for (let y = currentYear - 2; y <= currentYear + 1; y++) {
    const o = document.createElement("option");
    o.value = String(y);
    o.textContent = String(y);
    if (y === currentYear) o.selected = true;
    ySel.appendChild(o);
  }

  // Month select (All default)
  mSel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = ""; optAll.textContent = "All"; optAll.selected = true;
  mSel.appendChild(optAll);
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement("option");
    o.value = String(m);
    o.textContent = String(m).padStart(2, "0");
    mSel.appendChild(o);
  }

  ySel.addEventListener("change", refreshFavs);
  mSel.addEventListener("change", refreshFavs);
  ySel.dataset.init = "1";
}

async function refreshFavs() {
  const y = parseInt($("#fav-year").value, 10);
  const mVal = $("#fav-month").value;   // "" = All months
  state.favYear = y;
  state.favMonth = mVal === "" ? null : parseInt(mVal, 10);

  const host = $("#fav-list");
  host.innerHTML = "Loading…";

  let rows = [];
  try {
    if (mVal === "") {
      const { data, error } = await supa
        .from("favourites").select("*")
        .eq("iso_year", y)
        .order("day_date", { ascending: false });
      if (error) throw error;
      rows = data || [];
    } else {
      const m = parseInt(mVal, 10);
      const start = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
      const end   = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
      const { data, error } = await supa
        .from("favourites").select("*")
        .gte("day_date", start).lt("day_date", end)
        .order("day_date", { ascending: false });
      if (error) throw error;
      rows = data || [];
    }
  } catch (e) {
    console.error(e);
    host.textContent = "Error loading favourites.";
    return;
  }

  // builder for a favourite card (yellow-tinted)
  const buildFavCard = (r) => {
    const card = document.createElement("div");
    card.className = "card favourite";
    const bullets = (r.summary || "")
      .split("•")
      .map(s => s.trim())
      .filter(Boolean);

    card.innerHTML = `
      <div class="title">
        <a href="${r.url}" target="_blank" rel="noopener">${escapeHtml(r.title || "(untitled)")}</a>
      </div>
      <div class="meta-line">
        <span class="badge">Favourites</span>
        <span class="src" title="Saved date">${r.day_date}</span>
      </div>
      <ul class="bullets">${bullets.map(b => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
      <button class="fav-toggle is-on" title="Remove from favourites">★</button>
    `;

    const star = card.querySelector(".fav-toggle");
    star.addEventListener("click", async () => {
      if (star.disabled) return;
      star.disabled = true;
      try {
        await removeFav(r.url);
        // ✅ Re-fetch & re-render everything so other months/grids remain visible
        await refreshFavs();
      } catch (e) {
        console.error(e);
      } finally {
        star.disabled = false;
      }
    });

    return card;
  };

  if (!rows.length) {
    host.innerHTML = "<p>No favourites yet.</p>";
    return;
  }

  host.innerHTML = "";

  if (mVal === "") {
    // All months — group by month
    const byMonth = {};
    for (const r of rows) {
      const m = new Date(r.day_date + "T00:00:00Z").getUTCMonth() + 1;
      (byMonth[m] ??= []).push(r);
    }
    const months = Object.keys(byMonth).map(Number).sort((a, b) => a - b);

    for (const m of months) {
      const monthName = new Date(Date.UTC(y, m - 1, 1))
        .toLocaleString(undefined, { month: "long", timeZone: "UTC" });
      const h2 = document.createElement("h2");
      h2.textContent = `${monthName} ${y}`;
      host.appendChild(h2);

      const grid = document.createElement("div");
      grid.className = "grid";
      byMonth[m].forEach(r => grid.appendChild(buildFavCard(r)));
      host.appendChild(grid);
    }
  } else {
    // Single month
    const grid = document.createElement("div");
    grid.className = "grid";
    rows.forEach(r => grid.appendChild(buildFavCard(r)));
    host.appendChild(grid);
  }
}

/* ---------- Week load & bootstrap ---------- */
function setItems(items, meta) {
  state.allItems = Array.isArray(items) ? items.slice() : [];
  state.meta = (meta && meta.meta) ? meta.meta : meta; // allow either {items, meta} or meta directly
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

function attachEvents() {
  // Auto-load the week when date changes
  $("#day")?.addEventListener("change", () => {
    const v = $("#day").value;
    if (!v) return;
    navigateToWeekAndLoad(v);
  });

  // Calendar icon opens the picker
  $("#openPicker")?.addEventListener("click", () => {
    const el = $("#day");
    if (el?.showPicker) el.showPicker(); else el?.focus();
  });

  // Today: set date + load (LOCAL today)
  $("#loadToday")?.addEventListener("click", () => {
    const today = localISODate(new Date());
    $("#day").value = today;
    navigateToWeekAndLoad(today);
  });

  $("#category")?.addEventListener("change", () => {
    applyFilters();
    render(paginatedItems(), state.meta || { items: [], generated_at: "" });
  });

  $("#search")?.addEventListener("input", () => {
    applyFilters();
    render(paginatedItems(), state.meta || { items: [], generated_at: "" });
  });

  $("#openFavourites")?.addEventListener("click", () => { location.hash = "#/favourites"; });

  if (!location.hash) location.hash = "#/week";
}

/* ---------- Router ---------- */
function showFavouritesView() {
  state.route = "favourites";
  $("#results").style.display = "none";
  $("#meta").style.display = "none";
  $("#pagination")?.classList.add("hidden");
  $("#favourites-view").hidden = false;
  document.getElementById("openFavourites")?.classList.add("active");
  initFavSelectorsOnce();
  const now = new Date();
  $("#fav-year").value = String(now.getUTCFullYear());
  $("#fav-month").value = ""; // All
  refreshFavs();
}
function showWeekView() {
  state.route = "week";
  $("#favourites-view").hidden = true;
  $("#results").style.display = "";
  $("#meta").style.display = "";
  $("#pagination")?.classList.remove("hidden");
  document.getElementById("openFavourites")?.classList.remove("active");
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

/* ---------- Boot ---------- */
window.addEventListener("DOMContentLoaded", () => {
  const today = localISODate(new Date());
  $("#day").value = today;
  attachEvents();
  const { year, week } = isoWeekLocal(parseLocalDate(today));
  loadWeek(year, week);
});
