
# HR News Weekly Agent (Static, Private)

Scrape HR news from top sources once a week, summarize with Gemini, and publish static JSON files
that a simple website can browse by **Year** and **ISO Week** or via a **Today** button.

## Quick Start

1. **Clone** this repo and create a virtual env:
   ```bash
   python3 -m venv venv
   source venv/bin/activate   # Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. **Set Gemini key** (create `.env` or export directly):
   ```bash
   export GEMINI_API_KEY=your_key_here
   ```
3. **Set the SHRM auth token** (create `.env` or export directly):
   ```bash
   export SHRM_COVEO_TOKEN=your_token_here
   ```

4. **Run locally**:
   ```bash
   python scraper/run.py
   ```
   This will create weekly and daily JSON files under `data/<year>/`.

5. **Open the site locally** (no build step needed):
   - Serve `site/` with any static server, e.g.
     ```bash
     python -m http.server --directory site 8080
     ```
     and browse http://localhost:8080

6. **Deploy**:
   - Push to GitHub.
   - Add `GEMINI_API_KEY` as a GitHub Actions secret.
   - The workflow `.github/workflows/weekly.yml` runs every Monday 08:00 IST and commits new JSON.

7. **Protect the site**:
   - Recommended: Cloudflare Pages + Cloudflare Access (Zero Trust) to require email/SSO login.

## Data Layout

- Weekly file: `data/<YEAR>/<YEAR>-W<WW>.json` (e.g., `data/2025/2025-W35.json`)
- Daily file:  `data/<YEAR>/<YYYY-MM-DD>.json` (e.g., `data/2025/2025-08-23.json`)

## Editing Sources
Update CSS selectors in `scraper/selectors.py`. We use URL-prefix matchers for stability.

## Notes
- ISO Week is Thursday-based per ISO-8601.
- The frontend fetches `data/<year>/<year>-W<week>.json` and renders cards.
