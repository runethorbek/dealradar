# DealRadar

DealRadar is a personal deal-tracking application for products from sources such as Vinted, Zalando, and Scarosso.

The system is split into two GitHub repositories:

* `runethorbek/deals` — scraping and scheduled data collection
* `runethorbek/dealradar` — web application, database, product evaluation, feedback, and later notifications

## Architecture

The overall flow is:

```text
ScrapingAnt
    ↓
GitHub Actions in `deals`
    ↓
JSON files committed to GitHub
    ↓
DealRadar import API on Vercel
    ↓
Neon PostgreSQL
    ↓
Gemini evaluation
    ↓
DealRadar web UI
    ↓
Later: Slack notifications / feedback
```

## 1. Scrapers

The scraper code lives in the separate GitHub repository:

```text
runethorbek/deals
```

The scrapers currently collect deals from:

* Scarosso
* Zalando
* Vinted

ScrapingAnt is used for web scraping where required.

The scrapers output the latest results as JSON files under:

```text
public/deals/
```

Current files include:

```text
scarosso-latest.json
zalando-latest.json
vinted-latest.json
```

Each JSON file contains information such as product URL, title, image, price, discount, source-specific data, and the time the scan was performed.

## 2. GitHub Actions

The `deals` repository contains scheduled GitHub Actions:

```text
.github/workflows/daily-scarosso.yml
.github/workflows/daily-zalando.yml
.github/workflows/daily-vinted.yml
```

Each workflow roughly does the following:

```text
1. Checkout repository
2. Install Node dependencies
3. Run scraper
4. Write/update the source JSON file
5. Commit and push the JSON file
6. Determine the exact new Git commit SHA
7. Trigger the DealRadar import API
```

The DealRadar trigger uses the exact commit SHA:

```text
POST https://dealradar-rouge.vercel.app/api/import-deals?ref=<commit-sha>
```

Using the exact SHA is important because it avoids a race condition where `raw.githubusercontent.com/.../main/...` may briefly return the previous version immediately after a push.

The request is authenticated using:

```text
Authorization: Bearer <DEALRADAR_INGEST_API_KEY>
```

## 3. DealRadar web application

This repository contains the DealRadar application:

```text
runethorbek/dealradar
```

Technology:

* Next.js
* TypeScript
* Vercel
* Neon PostgreSQL
* Google Gemini API

The application is deployed automatically by Vercel whenever changes are pushed to the `main` branch of this repository.

Production deployment:

```text
https://dealradar-rouge.vercel.app
```

## 4. Import flow

The main import endpoint is:

```text
POST /api/import-deals
```

It accepts an optional Git reference:

```text
POST /api/import-deals?ref=<git-sha>
```

If no ref is supplied, `main` is used.

The importer fetches the three JSON files from the `deals` repository at the specified Git commit.

It then:

* normalizes source-specific product data
* upserts products
* preserves the original JSON in `raw_data`
* records price/history snapshots
* avoids duplicate snapshots for the same product and observation timestamp
* identifies new or meaningfully changed products
* can evaluate products using Gemini

## 5. Neon database

DealRadar uses Neon PostgreSQL.

The database is connected to the Vercel application through:

```text
DATABASE_URL
```

Main tables currently include:

### `products`

Contains the latest known state of each product.

Important fields include:

* source
* external URL
* title
* image URL
* current price
* original price
* discount percentage
* target size
* availability
* brand
* category
* first seen
* last seen
* complete original source object in `raw_data`

A product is uniquely identified by:

```text
(source, external_url)
```

### `product_snapshots`

Stores historical observations of each product.

Used for:

* price history
* detecting price changes
* identifying unusually good prices
* determining whether a current deal is actually better than previous prices

A product can only have one snapshot for the same observation timestamp.

### `product_feedback`

Stores manual feedback from the DealRadar UI.

Current values:

```text
like
dislike
```

The meaning is:

* `like` — I like this product / it fits my taste
* `dislike` — this product is not for me

This feedback is about the product itself, not whether Gemini's evaluation was correct.

Only the latest feedback value is stored for each product.

### `preferences`

Stores a single editable text profile describing personal preferences.

Examples of information stored here:

* preferred brands
* preferred styles
* materials
* colors
* shoe preferences
* things to avoid
* what constitutes an interesting deal

This profile is used as the primary context for Gemini evaluation.

### `product_evaluations`

Stores Gemini's latest evaluation for a product.

Current evaluation fields include:

```text
preference_score
deal_score
reason
evaluated_at
```

`preference_score` indicates how well the product matches the preference profile.

`deal_score` indicates how strong the current price/deal appears to be.

DealRadar can derive an overall ranking from these scores in the UI.

## 6. Gemini

Google Gemini is used as an evaluation layer.

Gemini does not scrape products and does not maintain persistent memory itself.

Instead, each evaluation can receive context from DealRadar, including:

```text
- current product data
- preference profile
- recent likes/dislikes
- product price history
```

Gemini returns structured output similar to:

```json
{
  "preferenceScore": 8,
  "dealScore": 7,
  "reason": "Strong match for the user's preferences and currently priced below recent observations."
}
```

The preference profile and feedback remain stored in Neon, so the system's persistent "memory" belongs to DealRadar rather than Gemini.

## 7. Vercel

The Next.js application runs on Vercel.

Deployment flow:

```text
VS Code / Codex
    ↓
git commit
    ↓
git push to GitHub
    ↓
Vercel automatically builds and deploys `main`
```

Server-side API routes run inside the Vercel application and communicate with Neon and Gemini.

## Environment variables and secrets

No secret values should ever be committed to GitHub.

### Vercel — DealRadar project

The DealRadar Vercel project currently needs:

```text
DATABASE_URL
```

Location:

```text
Vercel
→ DealRadar project
→ Settings
→ Environment Variables
```

Purpose:

Connection string for the Neon PostgreSQL database.

---

```text
INGEST_API_KEY
```

Location:

```text
Vercel
→ DealRadar project
→ Settings
→ Environment Variables
```

Purpose:

Protects:

```text
POST /api/import-deals
```

The matching value is stored in the `deals` GitHub repository as `DEALRADAR_INGEST_API_KEY`.

---

```text
GEMINI_API_KEY
```

Location:

```text
Vercel
→ DealRadar project
→ Settings
→ Environment Variables
```

Purpose:

Used server-side to call the Google Gemini API.

### GitHub — `deals` repository

Repository secrets are stored under:

```text
GitHub
→ runethorbek/deals
→ Settings
→ Secrets and variables
→ Actions
```

Required secrets currently include:

```text
SCRAPINGANT_API_KEY
```

Purpose:

Used by the scraping scripts to access ScrapingAnt.

---

```text
DEALRADAR_INGEST_API_KEY
```

Purpose:

Used by GitHub Actions when calling the DealRadar import API.

This must have the same value as:

```text
INGEST_API_KEY
```

in the DealRadar Vercel project.

## Local development

Install dependencies:

```bash
npm install
```

Start the local Next.js development server:

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

For database or Gemini functionality during local development, equivalent environment variables need to exist locally, normally in:

```text
.env.local
```

Do not commit `.env.local`.

## Database migrations

Database schema changes are stored under:

```text
migrations/
```

At the moment migrations are applied manually through the Neon SQL Editor.

Changing a migration file in GitHub does not automatically change the existing Neon database.

When a new migration is added:

```text
1. Review the SQL
2. Run it in Neon SQL Editor
3. Verify the database change
4. Commit/push the migration file
```

## Current responsibilities

### `deals` repository

Responsible for:

* scraping
* ScrapingAnt
* schedules
* source-specific parsing
* JSON output
* triggering DealRadar after a scan

### `dealradar` repository

Responsible for:

* importing JSON
* normalization
* persistent product state
* price history
* feedback
* preference profile
* Gemini evaluations
* ranking
* web UI
* future notifications

Keeping these responsibilities separate is intentional.

## Planned Slack integration

Slack is intended to be the notification layer rather than part of the scraping pipeline.

Possible flow:

```text
new/changed product
    ↓
Gemini evaluation
    ↓
high preference score + strong deal score
    ↓
Slack notification
```

A future Slack app could also include interactive feedback buttons such as:

```text
Like
Not for me
```

Those interactions should normally call DealRadar directly:

```text
Slack
→ DealRadar API
→ Neon
```

There is normally no reason to involve GitHub Actions for simple feedback.

A Slack action could later trigger a GitHub Action for operations such as:

```text
Rescan Scarosso now
Rescan Zalando now
Rescan Vinted now
```

That would use:

```text
Slack
→ DealRadar
→ GitHub Actions
→ scraper
→ JSON
→ DealRadar
```

## Useful mental model

The easiest way to remember the system is:

```text
GitHub Actions collect
Neon remembers
Gemini judges
Vercel orchestrates and displays
Slack notifies
```
