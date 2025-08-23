#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
HR News Aggregator — Weekly & Daily JSON
Python 3.9 compatible

- Uses sources defined in sources_map.SOURCES
- Special source id "shrm:coveo-news" calls SHRM Coveo API (filter = News)
- ET (hr.economictimes.indiatimes.com) parsed statically (no Playwright)
- Non-ET categories decided by model
- Robust summarization & parsing to avoid "invalid literal for int()" warnings
"""

import os
import re
import json
import uuid
import datetime
from typing import Optional, List, Tuple, Dict, Any
from urllib.parse import urljoin, urlparse

import requests
from requests.adapters import HTTPAdapter, Retry
from bs4 import BeautifulSoup
import trafilatura
import google.generativeai as genai

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# Your predefined sources list: List[Tuple[str, str]] -> (base_url_or_id, css_selector)
from sources_map import SOURCES


# ------------------------ Tunables ------------------------
UA = "Mozilla/5.0 (HRNewsAgent/3.2; +https://example.org)"
COMMON_HEADERS = {
    "User-Agent": UA,
    "Accept-Language": "en-IN,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

PER_SITE_LIMIT   = int(os.getenv("PER_SITE_LIMIT", "25"))
MAX_TOTAL_ITEMS  = int(os.getenv("MAX_TOTAL_ITEMS", "160"))
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

# Dedup & selection knobs
DEDUP_SIM_THRESHOLD = float(os.getenv("DEDUP_SIM_THRESHOLD", "0.82"))  # 0.78–0.88 typical
MIN_SIGNIFICANCE    = int(os.getenv("MIN_SIGNIFICANCE", "3"))          # raise to 4 for stricter
MAX_PER_COMPANY     = int(os.getenv("MAX_PER_COMPANY", "2"))
SUMM_BATCH_SIZE     = int(os.getenv("SUMM_BATCH_SIZE", "3"))           # 2 is safer if very long articles


# ------------------------ Session w/ retries ------------------------
def make_session() -> requests.Session:
    s = requests.Session()
    retries = Retry(
        total=3, backoff_factor=0.6,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET", "POST"])
    )
    s.mount("https://", HTTPAdapter(max_retries=retries))
    s.mount("http://", HTTPAdapter(max_retries=retries))
    s.headers.update(COMMON_HEADERS)
    return s

SESSION = make_session()


# ------------------------ Taxonomy & Rules ------------------------
CATEGORY_TAXONOMY = [
    "Talent Acquisition",
    "Compensation & Benefits",
    "Learning & Development",
    "Performance Management",
    "Employee Engagement",
    "Diversity & Inclusion",
    "HR Tech & AI",
    "Workplace Policy & Culture",
    "Legal & Compliance",
    "Org Design & Restructuring",
    "People Analytics",
]
CATEGORY_KEYWORDS = [
    ("Talent Acquisition",        r"\bhiring|recruit|recruitment|campus|sourcing|ATS\b|offer\b|onboard|on-?boarding|talent acquisition\b"),
    ("Compensation & Benefits",   r"\bcompensation|pay|salary|wage|bonus|incentive|esop|benefit|perks|gratuity|pf\b"),
    ("Learning & Development",    r"\bL&D\b|learning|upskilling|reskilling|training|academy|certificate|cohort\b"),
    ("Performance Management",    r"\bOKR|KPI|performance review|appraisal|PMS\b|rating|calibration\b"),
    ("Employee Engagement",       r"\bengagement|wellbeing|well-being|experience\b|\bEX\b|culture survey|pulse\b"),
    ("Diversity & Inclusion",     r"\bDEI\b|D&I|diversity|inclusion|equity|belonging|LGBTQ|women leadership|neurodivers"),
    ("HR Tech & AI",              r"\bAI\b|gen\s*AI|LLM|chatbot|automation|HCM|HRIS|Workday|SuccessFactors|BambooHR|Rippling|Darwinbox"),
    ("Workplace Policy & Culture",r"\breturn to office|RTO|hybrid|remote|flexi|policy\b|leave policy|dress code|code of conduct|ethics"),
    ("Legal & Compliance",        r"\bEEOC|NLRB|compliance|regulation|law\b|litigation|GDPR|DPDP|privacy|OSHA|labor court|industrial dispute"),
    ("Org Design & Restructuring",r"\brestructur(ing|e)|reorg|org design|span of control|delayering|rightsiz|downs(iz|cal)|merger|acquisition|spin[- ]?off"),
    ("People Analytics",          r"\banalytics|dashboard|insight|attrition model|predictive|workforce analytics\b"),
]

def infer_category_rule_based(title: str, body: str, url: str) -> Optional[str]:
    hay = " ".join([title or "", body or "", url or ""]).lower()
    for cat, pattern in CATEGORY_KEYWORDS:
        if re.search(pattern, hay, flags=re.I):
            return cat
    return None

def snap_to_taxonomy(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    n = name.strip().lower()
    for t in CATEGORY_TAXONOMY:
        tl = t.lower()
        if n == tl or n in tl or tl in n:
            return t
    return None


# ------------------------ Utils ------------------------
def iso_week(dt: datetime.date):
    y, w, _ = dt.isocalendar()
    return y, f"{y}-W{w:02d}"

def normalize_link(base: str, href: str) -> str:
    if not href:
        return ""
    if href.startswith(("http://", "https://")):
        return href
    return urljoin(base, href)

def clean_bullet(s: str) -> str:
    s = re.sub(r"(?i)^(this url|the url|the link)\b.*?:\s*", "", s or "").strip()
    s = re.sub(r"^\s*[-•]\s*", "", s).strip()
    return s

def chunk(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i+n]

def domain_of(url: str) -> str:
    try:
        return urlparse(url).netloc.replace("www.", "").lower()
    except:
        return ""


# ------------------------ ET HRWorld (static only) ------------------------
ET_DOMAIN = "hr.economictimes.indiatimes.com"
# accept .../123456 (cms optional, allow query/anchor)
ET_ARTICLE_RE = re.compile(r"/\d{6,}(?:\.cms)?(?:[/?#].*)?$", re.I)

def is_et_category(url: str) -> bool:
    u = urlparse(url)
    if ET_DOMAIN not in u.netloc:
        return False
    return ("/news" in (u.path or "")) and (not ET_ARTICLE_RE.search(u.path or ""))

def _extract_et_articles_from_html(base_url: str, html: str, per_cat_limit: int) -> List[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items, seen = [], set()
    # Broad anchor scan — ET classes change often
    for a in soup.find_all("a", href=True):
        href = a.get("href")
        if not href:
            continue
        url = normalize_link(base_url, href)
        if not url or url in seen or not url.startswith("http"):
            continue
        path = (urlparse(url).path or "")
        if not ET_ARTICLE_RE.search(path):
            continue
        title = (a.get_text(strip=True) or a.get("title") or "Article").strip()
        if not title:
            continue
        seen.add(url)
        items.append({"source": base_url, "title": title, "url": url})
        if len(items) >= per_cat_limit:
            break
    return items

def crawl_et_category_page(base_url: str, html: str, per_cat_limit=20) -> Tuple[str, List[dict]]:
    items = _extract_et_articles_from_html(base_url, html, per_cat_limit)
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.select_one("h1, .sectionHeading, .heading, .title")
    category = (h1.get_text(strip=True) if h1 else "ET HRWorld")
    for it in items:
        it["category"] = category
    return category, items

def expand_et_news_landing(html: str, base_url: str, max_cats=8, per_cat_limit=20) -> List[dict]:
    soup = BeautifulSoup(html, "html.parser")
    cat_links, seen = [], set()
    for a in soup.find_all("a", href=True):
        url = normalize_link(base_url, a["href"])
        if url not in seen and is_et_category(url):
            seen.add(url)
            cat_links.append(url)

    items = []
    for url in cat_links[:max_cats]:
        try:
            r = SESSION.get(url, timeout=15)
            r.raise_for_status()
            cat, ci = crawl_et_category_page(url, r.text, per_cat_limit)
            print(f"[ET] {cat}: {len(ci)} from hub {url}")
            items.extend(ci)
        except Exception as e:
            print(f"[warn] ET category fetch failed {url}: {e}")
    return items


# ------------------------ Domain-aware heuristics (non-ET) ------------------------
DOMAIN_RULES = {
    "indianexpress.com": {
        "article_re": re.compile(r"/article/"),
        "extra_selectors": [
            "a[href*='/article/']",
            "h3 a[href*='/article/']",
            "article a[href*='/article/']",
        ],
    },
    "aihr.com": {
        "article_re": re.compile(r"/blog/"),
        "extra_selectors": [
            "a.blog-card__link",
            "a[href*='/blog/']",
            "h2 a[href*='/blog/']",
        ],
    },
    "hrdive.com": {
        "article_re": re.compile(r"/news/.+/\d+/?$"),
        "extra_selectors": [
            "a.article-title",
            "a.card__title-link",
            "a[href*='/news/']",
        ],
    },
    "hrexecutive.com": {
        "article_re": re.compile(r"/\d{4}/\d{2}/\d{2}/"),
        "extra_selectors": [
            "a.post-title-link",
            "h2.entry-title a",
            "a[href*='hrexecutive.com/20']",
        ],
    },
    "hrmorning.com": {
        "article_re": re.compile(r"/articles/"),
        "extra_selectors": [
            "h3 a[href*='/articles/']",
            "a[href*='/articles/']",
            "h2.entry-title a",
        ],
    },
}
GENERIC_FALLBACK_SELECTORS = [
    "a[href*='/article/']",
    "h2 a[href*='/article/']",
    "h3 a[href*='/article/']",
    "a[href*='/news/']",
    "article a[href]",
]

def looks_like_article(url: str, domain: str) -> bool:
    if not url or not url.startswith(("http://", "https://")):
        return False
    rules = DOMAIN_RULES.get(domain)
    if rules and rules.get("article_re"):
        return bool(rules["article_re"].search((urlparse(url).path or "")))
    # generic heuristic
    path = (urlparse(url).path or "")
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        return False
    if any(seg in path.lower() for seg in ["/tag/", "/topic/", "/topics/", "/category/", "/categories/"]):
        return False
    return True


# ------------------------ Fetch article body ------------------------
def fetch_article_text_and_meta(url: str):
    try:
        dl = trafilatura.fetch_url(url, no_ssl=True)
        text = ""
        if dl:
            text = trafilatura.extract(dl, include_links=False, include_images=False) or ""
            text = re.sub(r"\s+", " ", text).strip()
        return text, None
    except:
        return "", None


# ------------------------ SHRM via Coveo (optional) ------------------------
COVEO_URL = "https://societyforhumanresourcemanagementproductionay6r644u.org.coveo.com/rest/search/v2"
ORG_ID    = "societyforhumanresourcemanagementproductionay6r644u"

def fetch_shrm_news_via_coveo(count=25):
    token = os.getenv("SHRM_COVEO_TOKEN")
    if not token:
        print("[shrm] SHRM_COVEO_TOKEN not set; skipping SHRM.")
        return []
    headers = dict(COMMON_HEADERS)
    headers["authorization"] = f"Bearer {token}"
    headers["content-type"] = "application/json"
    headers["origin"] = "https://www.shrm.org"
    headers["referer"] = "https://www.shrm.org/"

    payload = {
        "locale": "en",
        "numberOfResults": count,
        "firstResult": 0,
        "searchHub": "ProdShrmUsSearchPage",
        "facets": [
            {
                "facetId": "contenttypefiltertag",
                "field": "contenttypefiltertag",
                "currentValues": [{"value": "News", "state": "selected"}],
                "freezeCurrentValues": True,
                "preventAutoSelect": True,
                "type": "specific"
            }
        ],
        "sortCriteria": "date descending",
    }

    r = SESSION.post(COVEO_URL, params={"organizationId": ORG_ID},
                     headers=headers, data=json.dumps(payload), timeout=25)
    if r.status_code in (401, 403):
        print("[shrm] auth failed; refresh token.")
        return []
    r.raise_for_status()
    data = r.json()
    items = []
    for res in data.get("results", []):
        title = res.get("title")
        url = res.get("clickUri") or res.get("clickuri")
        if title and url:
            items.append({
                "source": "https://www.shrm.org/in/topics-tools/news#article_results",
                "title": title.strip(),
                "url": url.strip()
            })
    print(f"[shrm] captured {len(items)} items via Coveo")
    return items


# ------------------------ Lenient JSON helper ------------------------
def parse_json_lenient(text: str) -> Optional[List[dict]]:
    """Lenient JSON extraction from model output."""
    import json as _json
    import re as _re

    def _strip_fences(s: str) -> str:
        s = s.strip()
        if s.startswith("```"):
            s = _re.sub(r"^```(?:json)?", "", s, flags=_re.I).strip()
            s = _re.sub(r"```$", "", s).strip()
        return s

    s = _strip_fences(text)
    s = "".join(ch for ch in s if ch == "\n" or 32 <= ord(ch) <= 126)

    try:
        data = _json.loads(s)
        return data if isinstance(data, list) else [data]
    except Exception:
        pass

    m = re.search(r"\[[\s\S]*\]", s)
    if m:
        s2 = re.sub(r",\s*([\]}])", r"\1", m.group(0))
        try:
            data = _json.loads(s2)
            return data if isinstance(data, list) else [data]
        except Exception:
            pass

    m2 = re.search(r"\{[\s\S]*\}", s)
    if m2:
        s3 = re.sub(r",\s*([\]}])", r"\1", m2.group(0))
        try:
            return [_json.loads(s3)]
        except Exception:
            pass

    s4 = re.sub(r",\s*([\]}])", r"\1", s)
    try:
        data = _json.loads(s4)
        return data if isinstance(data, list) else [data]
    except Exception:
        return None


# ------------------------ Summarization (Gemini 2.0 Flash) ------------------------
def _dump_model_text(prefix: str, text: str) -> str:
    os.makedirs("logs", exist_ok=True)
    fname = f"logs/{prefix}-{uuid.uuid4().hex[:8]}.txt"
    try:
        with open(fname, "w", encoding="utf-8") as f:
            f.write(text)
    except Exception:
        pass
    return fname

def summarize_bullets(items: List[dict]) -> Dict[str, dict]:
    """Return {url: {bullets, companies, significance, category}} with robust parsing."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("[warn] GEMINI_API_KEY missing; skipping model summaries.")
        return {}

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(
        "gemini-2.0-flash",
        generation_config={"temperature": 0.3, "response_mime_type": "application/json"},
    )

    taxonomy_str = ", ".join(CATEGORY_TAXONOMY)
    out: Dict[str, dict] = {}

    def coerce_significance(val: Any) -> int:
        """Force significance to int 1..5 safely."""
        try:
            if isinstance(val, bool):
                s = 3
            elif isinstance(val, (int, float)):
                s = int(round(val))
            elif isinstance(val, str):
                m = re.search(r"[1-5]", val)
                s = int(m.group(0)) if m else 3
            else:
                s = 3
        except Exception:
            s = 3
        return max(1, min(s, 5))

    for batch in chunk(items, SUMM_BATCH_SIZE):
        listing = []
        for it in batch:
            body = it.get("body", "") or ""
            excerpt = (body[:1600] + "...") if len(body) > 1600 else body
            listing.append(f"- URL: {it['url']}\n  Title: {it['title']}\n  Excerpt: {excerpt}")

        # Conservative but strict prompt (won't break working behavior)
        prompt = (
            "You are an expert HR analyst. For each item below, return ONLY a JSON array; "
            "no markdown, no commentary. For EVERY item include EXACTLY these keys:\n"
            '  url (string), bullets (array of 3-4 short strings), companies (array of strings), '
            'significance (integer 1..5), category (one of: '
            + taxonomy_str + ").\n"
            "- Bullets must be concise and factual; do not start with boilerplate like 'This URL...' or 'This article...'.\n"
            "- significance MUST be a pure integer (1,2,3,4,5) — do not write words.\n"
            "- category MUST be exactly one value from the taxonomy list.\n"
            "Items:\n" + "\n".join(listing)
        )

        try:
            resp = model.generate_content(prompt)
            raw = (getattr(resp, "text", None) or "").strip()
            data = parse_json_lenient(raw)
            if data is None:
                path = _dump_model_text("summarize_raw", raw)
                # Try a single reformat attempt
                retry = model.generate_content(
                    "Reformat STRICTLY as a JSON array. Each object must have keys: "
                    'url, bullets, companies, significance, category. No extra keys, no commentary.\n\n'
                    + raw
                )
                raw2 = (getattr(retry, "text", None) or "").strip()
                data = parse_json_lenient(raw2)
                if data is None:
                    path2 = _dump_model_text("summarize_retry_raw", raw2)
                    print(f"[warn] summarization batch failed; logs: {path}, {path2}")
                    continue

            for obj in data:
                try:
                    url = obj.get("url")
                    if not url:
                        continue

                    # bullets
                    bullets = obj.get("bullets") or []
                    if isinstance(bullets, str):
                        bullets = [bullets]
                    bullets = [clean_bullet(x) for x in bullets if isinstance(x, str) and x.strip()]
                    if len(bullets) > 4:
                        bullets = bullets[:4]
                    # If too few bullets, we still accept (don’t break successful behavior)

                    # companies
                    companies = obj.get("companies") or []
                    if isinstance(companies, str):
                        companies = [companies]
                    companies = [c.strip() for c in companies if isinstance(c, str) and c.strip()]
                    # de-dup companies, keep order
                    seen_c, uniq_c = set(), []
                    for c in companies:
                        lc = c.lower()
                        if lc in seen_c: 
                            continue
                        seen_c.add(lc); uniq_c.append(c)
                    companies = uniq_c[:8]

                    # significance
                    sig = coerce_significance(obj.get("significance"))

                    # category
                    cat = snap_to_taxonomy(obj.get("category"))
                    if not cat:
                        cat = "Workplace Policy & Culture"  # safe default

                    out[url] = {
                        "bullets": bullets,
                        "companies": companies,
                        "significance": sig,
                        "category": cat
                    }
                except Exception:
                    continue

        except Exception as e:
            print("[warn] summarize fail:", e)

    return out


# ------------------------ De-dup & diversity ------------------------
def semantic_dedup(items: List[dict]) -> List[dict]:
    texts = []
    for it in items:
        body = it.get("body") or ""
        texts.append(body if len(body) >= 400 else (it["title"] + " " + body))
    if len(texts) <= 1:
        return items

    vec = TfidfVectorizer(stop_words="english", max_df=0.85)
    X = vec.fit_transform(texts)
    sim = cosine_similarity(X, dense_output=False)

    keep = []
    dropped = set()
    n = len(items)
    for i in range(n):
        if i in dropped:
            continue
        keep.append(i)
        row = sim[i].toarray().ravel()
        for j in range(i + 1, n):
            if j in dropped:
                continue
            if row[j] >= DEDUP_SIM_THRESHOLD:
                dropped.add(j)
    return [items[i] for i in keep]

def enforce_company_diversity(items: List[dict]) -> List[dict]:
    counts: Dict[str, int] = {}
    out: List[dict] = []
    for it in items:
        comps = it.get("companies") or []
        if comps:
            main = sorted({c.lower() for c in comps})[0]
            counts[main] = counts.get(main, 0) + 1
            if counts[main] <= MAX_PER_COMPANY:
                out.append(it)
        else:
            out.append(it)
    return out


# ------------------------ Scraping ------------------------
def _debug_print_sample(domain: str, items: List[dict], n: int = 5):
    if not items:
        print(f"[debug] {domain}: 0 items")
        return
    print(f"[debug] {domain}: sample {min(n,len(items))} URLs:")
    for it in items[:n]:
        print("   -", it["url"])

def scrape_source(base: str, selector: Optional[str]) -> List[dict]:
    out = []
    try:
        r = SESSION.get(base, timeout=18)
        r.raise_for_status()
    except Exception as e:
        print(f"[scrape] {base} failed {e}")
        return out

    u = urlparse(base)
    dom = u.netloc.replace("www.", "").lower()

    # ET hub/category expansion — ET keeps site category
    if ET_DOMAIN in dom and (u.path.rstrip("/") == "/news" or is_et_category(base)):
        hub = expand_et_news_landing(r.text, base, max_cats=8, per_cat_limit=20)
        if hub:
            _debug_print_sample(dom, hub)
            return hub
        cat, ci = crawl_et_category_page(base, r.text, per_cat_limit=25)
        print(f"[ET] {cat}: {len(ci)} from hub {base}")
        _debug_print_sample(dom, ci)
        return ci

    # Non-ET: DO NOT set category here (model will decide)
    soup = BeautifulSoup(r.text, "html.parser")
    count = 0
    rules = DOMAIN_RULES.get(dom, {})

    candidates = soup.select(selector) if selector else []
    for sel in rules.get("extra_selectors", []):
        candidates.extend(soup.select(sel))
    for sel in GENERIC_FALLBACK_SELECTORS:
        candidates.extend(soup.select(sel))

    seen = set()
    for a in candidates:
        href = a.get("href")
        title = a.get_text(strip=True)
        if not href or not title:
            continue
        url = normalize_link(base, href)
        if url in seen:
            continue
        seen.add(url)
        if not looks_like_article(url, dom):
            continue
        out.append({"source": base, "title": title, "url": url})
        count += 1
        if count >= PER_SITE_LIMIT:
            break

    print(f"[scrape] {dom} -> kept {count} links")
    _debug_print_sample(dom, out)
    return out

def scrape() -> List[dict]:
    items: List[dict] = []
    for base, selector in SOURCES:
        # ---- Special branch: SHRM Coveo pseudo-source ----
        if base == "shrm:coveo-news":
            items.extend(fetch_shrm_news_via_coveo(count=25))
            continue
        # ---- Normal sources ----
        items.extend(scrape_source(base, selector))

    # URL-dedup & global cap
    uniq, seen = [], set()
    for it in items:
        if it["url"] in seen:
            continue
        seen.add(it["url"])
        uniq.append(it)
        if len(uniq) >= MAX_TOTAL_ITEMS:
            break
    print(f"[scrape] total candidates after URL-dedup: {len(uniq)}")
    return uniq


# ------------------------ Main ------------------------
def is_et_url(url: str) -> bool:
    try:
        return ET_DOMAIN in urlparse(url).netloc
    except:
        return False

def main():
    now = datetime.datetime.now(IST)
    year, week_str = iso_week(now.date())

    # 1) Collect links (SHRM handled via special branch)
    candidates = scrape()

    # 2) Fetch article body
    for it in candidates:
        body, _ = fetch_article_text_and_meta(it["url"])
        it["body"] = body

        # Rule-based category only for ET upfront (site-derived later preferred)
        if is_et_url(it["url"]) and not it.get("category"):
            it["category"] = infer_category_rule_based(it["title"], body, it["url"])

    # 3) Semantic dedup
    unique = semantic_dedup(candidates)

    # 4) Summaries (bullets + companies + significance + category by model)
    s_map = summarize_bullets(unique)

    # 5) Final assembly — category preference:
    #    ET: rule → model → default
    #    Non-ET: model → rule → default
    enriched = []
    for it in unique:
        s = s_map.get(it["url"])
        if not s:
            continue
        if s["significance"] < MIN_SIGNIFICANCE:
            continue

        if is_et_url(it["url"]):
            cat = (it.get("category")
                   or s.get("category")
                   or "Workplace Policy & Culture")
        else:
            cat = (s.get("category")
                   or infer_category_rule_based(it["title"], it.get("body", ""), it["url"])
                   or "Workplace Policy & Culture")
        cat = snap_to_taxonomy(cat) or "Workplace Policy & Culture"

        enriched.append({
            "source": it.get("source"),
            "title": it["title"],
            "url": it["url"],
            "published": it.get("published"),
            "summary_bullets": s["bullets"],
            "companies": s["companies"],
            "significance": s["significance"],
            "category": cat,
            "tags": []
        })

    # 6) Company diversity cap
    final_items = enforce_company_diversity(enriched)

    # 7) Output
    out = {
        "week": week_str,
        "year": year,
        "generated_at": now.isoformat(),
        "items": final_items
    }
    out_dir = os.path.join("data", str(year))
    os.makedirs(out_dir, exist_ok=True)
    week_path = os.path.join(out_dir, f"{week_str}.json")
    day_path  = os.path.join(out_dir, f"{now.date().isoformat()}.json")

    with open(week_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    with open(day_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"[ok] wrote {week_path} and {day_path}")


if __name__ == "__main__":
    main()
