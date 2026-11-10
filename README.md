# Anyday Quote Studio

Internal tool for analysing a website, assembling an implementation quote and exporting a branded PDF proposal. Clients only ever see the exported proposal.

All prices are USD. Every investment figure comes from one deterministic pricing engine (`shared/pricing.js`). No AI is involved in classification or pricing.

---

## 1. Setup

### Requirements

* Node.js 20 or newer
* Chromium for PDF export (installed once with the command below)
* Python 3 with `openpyxl` only if you want to regenerate the library and examples from the source workbooks

### Run locally

```bash
npm ci                                   # installs dependencies and builds the browser app
npx playwright@1.56.0 install chromium   # one time, for PDF export
npm start                                # http://127.0.0.1:4310
```

On first start the server creates `data/` and seeds it with the Pricing Library, the AAIF foundation and the three Linux Foundation examples (PyTorch, OpenSSF, CNCF).

### Run with Docker

```bash
docker build -t anyday-quote-studio .
docker run -p 4310:4310 -v anyday-quote-data:/data anyday-quote-studio
```

The image is based on the official Playwright image, so Chromium is included.

### Settings (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4310` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only behind your SSO, VPN or reverse proxy |
| `DATA_DIR` | `./data` | Where quotes, the library and scans are stored |
| `CHROMIUM_PATH` | auto detected | Path to a Chromium or Chrome binary for PDF export |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Google OAuth web client for sign-in |
| `SESSION_SECRET` | none | At least 32 random characters; signs sign-in sessions |
| `ALLOWED_DOMAIN` | `anyday.inc` | Google Workspace domain allowed to sign in |
| `ALLOWED_EMAILS` | none | Extra individual addresses allowed to sign in |
| `PUBLIC_URL` | none | i.e. `https://quotes.anyday.inc`; used for the sign-in callback and secure cookies |

### Access control

Google sign-in limits the app to verified **@anyday.inc** Google Workspace accounts (plus any addresses in `ALLOWED_EMAILS`). It switches on when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `SESSION_SECRET` are set. Without them the app only starts on `127.0.0.1`; on a public address it refuses to start unless `ALLOW_NO_AUTH=1` is set behind your own access control.

To deploy to **quotes.anyday.inc** on Render, follow **DEPLOY.md**. The `render.yaml` Blueprint configures the service, disk and settings.

### Storage and backups

Everything lives as plain JSON under `DATA_DIR`:

* `library.json`: the current Pricing Library. Every save archives the previous version in `library-versions/`.
* `team.json`: the delivery team used by the Plan step (cost rates are sent to admins only).
* `settings.json`: cost currency, exchange rate and target margin.
* `foundations/<id>.json`: one file per foundation (components, content models, integrations, capabilities provided, notes). Every save archives the previous version in `foundation-versions/`.
* `backups/`: copies taken before an automatic data upgrade (i.e. `pre-v2-<time>/`).
* `quotes/<id>.json`: one file per quote, including its own pricing snapshot.
* `scans/<id>.json`: raw results of each website scan.
* `trash/`: deleted quotes (recoverable).

Writes are atomic (write to a temporary file, flush, rename). Saving a quote that someone else changed in the meantime is refused rather than overwritten. Back up `DATA_DIR` to keep everything.

---

## 2. Quick guide

### Create a quote

1. **Quotes → New quote.** First choose what you are pricing:
   * **New platform and rollout**: a new multisite platform built from scratch, then a portfolio of sites rolled onto it (i.e. 600 clinic sites). Can optionally start from an existing foundation.
   * **New site on an existing foundation**: a site for a sub brand or sister organisation reusing a platform Anyday already built (i.e. a Linux Foundation project on AAIF). Needs a foundation.
   * **Expand a platform we already run**: new sites on a live platform. Enter how many sites are already live; site activation pricing continues from that volume tier.
   The type sets the starting scope (its presets, editable in Pricing Library → Quote type presets), the steps and the proposal wording. The quote takes snapshots of the current library and of the chosen foundation.
2. **Sites** (portfolio types only). Group sites into site types with a count each. **Import site list (CSV)** with columns such as name, url, brand, site type creates the types and counts and picks samples. For each type, add one or two sample sites to analyse, or enter typical per site figures when nothing can be scanned.
3. **Analyse** the website, or each sample site (see below), or skip it and enter quantities by hand. Each sample scan only replaces that site's own pages.
4. **Review.** For portfolios, the Portfolio table shows sites, samples, per site averages and extrapolated totals per site type. Check the dashboard and the URL table. Check the dashboard and the URL table. Change a category, include or exclude URLs, set content types, mark rows reviewed. Use search, filters and bulk actions for large sites. Your decisions are stored separately from the scan findings.
5. Click **Review and apply quantities.** The dialog shows current quantities, proposed quantities, the investment change and the assumptions that will be added. Only ticked rows are applied. Quantities you set by hand are unticked by default. Redirects and per site brand configuration are entered independently. Portfolios also get a site activation row.
6. **Scope.** For each item choose **Included**, **Optional** or **Hidden**. Expand any row with **+** to see what it means, what the client receives and how it is priced, and to:
   * set a quote specific price override (the library is unchanged),
   * confirm a "starting at" price,
   * choose whether a design amount is an additional charge or an allocation from an existing fee,
   * offer additional volume as an optional addition, priced against the scope already included.
   In **WebOps Base + Design**, when the quote uses a foundation, its panel sets each component to Brand, Redesign, Extend, New or Not used. **Component design** counts each redesigned component once; on a new platform it also counts every reusable component being built.
7. **Plan (internal).** Hours by role for every deliverable, who does the work, and the timeline. Open a row to enter fixed hours and hours per unit, assign people from the Team, set the phase and what it waits on. Set a kickoff date for calendar dates (time off then applies). **Save as library defaults** stores the hours so the next quote starts with them. **Download internal plan** exports a PDF and CSV with no prices or client proposal copy, for the delivery team.
8. **Investment.** **Suggest an introduction** writes a starting paragraph for the quote type. Edit the introduction, assumptions, exclusions, payment terms, validity and (optionally) timeline. The live preview updates as you type.

### Edit library prices

**Pricing Library** lists every item with its section, pricing rule and status. Click the pencil to edit names, plain language descriptions, unit prices, units, batch sizes and prices, volume tiers, proposal section, dependencies, design flag and optional availability. **Add item** creates new items, including design items. **Sections and mapping** shows the section for every item. **Quote type presets** sets which lines each quote type starts with.

### Team

**Team** lists the people who deliver the work: name, role (designer, developer, project manager, technical lead), hours a week for client work, and time off. Each quote's Plan step assigns them and times the work from their hours. On a quote you can also lower the share of someone's week spent on that project.

### Quote assistant

With `ANTHROPIC_API_KEY` set in Render, every quote has an **Assistant** button (and the Quotes screen has **New quote with assistant**). Attach a brief (PDF, Word, text, Markdown, CSV or images) or describe the project, and Claude builds the quote with the studio's own tools:
* sets up the client, project, quote type, foundation and site types,
* analyses the websites named in the brief and applies migration quantities from the scan,
* chooses every deliverable with a quantity and a reason (shown under each line in Scope), sets foundation component treatments,
* writes the introduction, assumptions and exclusions, and adds first pass Plan hours,
* ends with the total and the open questions the brief did not answer.

Changes apply to the quote directly. Each turn saves a restore point first, so **Undo last turn** puts the quote back exactly as it was. Prices always come from the Pricing Library; the assistant never sets prices. `ANTHROPIC_MODEL` (optional) picks the model; the default is `claude-sonnet-5-5`.

### Clockify

With `CLOCKIFY_API_KEY` set in Render:
* **Team → Sync from Clockify** brings in names, roles from Clockify groups (Designers, Developers, Project Manager, Design Leads, Dev Leads), weekly capacity, approved time off and cost rates. A role changed in the studio is kept on later syncs.
* **Pricing Library → Hours from Clockify** reads the last 12 months of logged time (or a Clockify detailed report CSV) and proposes baseline hours for each deliverable. Each baseline shows how it was worked out, how many tasks or projects it rests on, its confidence, and the implied rate (unit price ÷ hours). Baselines never replace hours someone set. Editing a baseline hour, or saving hours from a quote's Plan, makes them confirmed hours.

Clockify entries carry no quantities, so baselines are guesstimates and tend to run low. To sharpen them over time, log the Task as the deliverable and put the count in the description (i.e. "Migrate 12 pages").

### Costs and gross margin (admins only)

Accounts listed in `ADMIN_EMAILS` see cost rates on the Team, cost settings (cost currency, exchange rate to USD, target margin) and a **Gross margin** card on each quote's Investment step: price against planned hours × each person's cost rate, by section and by deliverable. Everyone else never receives cost rates from the server, and the internal plan export contains no prices, costs or margins.

### Foundations

**Foundations** holds the platforms Anyday has built, one folder each: Components, Content models, Integrations, Capabilities provided and Notes. Add, duplicate, archive, import and export them. A quote keeps its own snapshot; **Setup → Refresh from the current foundation** applies later edits and keeps redesign choices.

Click **Save library**. New quotes use the new prices. Existing quotes keep their snapshot until you open one and choose **Setup → Review current library pricing → Apply to this quote**, which shows every change and the total before and after.

**Export** and **Import** move the library as a JSON file.

### Analyse a URL

In **Analyse website**, set how many pages to inspect (up to 600), any extra hosts to include, and whether to crawl when no sitemap exists. Click **Analyse website**. Progress, failures, limits and coverage appear as it runs. When it finishes, click **Merge … URLs into the inventory**. A partial scan asks you to confirm first. A failed or cancelled scan changes nothing.

Rescanning keeps your edits and marks URLs as new, changed or not seen.

Media has four separate numbers: media found on scanned pages, image sitemap entries, a verified CMS export (import a CSV, WordPress media JSON or Sanity export), and your migration allowance, which is the only one the quote charges.

### Export the PDF

In **Investment and proposal**:

* **View PDF pages** renders the actual PDF in the preview pane.
* **Download draft PDF** works at any time and carries a DRAFT watermark.
* **Export final PDF** is enabled only when every included item has a price and a quantity. Items marked "Price needed" or "Quantity needed" block it and are listed with a link to fix them.
* Tick **Include the full URL inventory as an appendix**, or use **URL inventory (CSV)** for a separate file.

---

## 3. Pricing rules

Prices, units and pattern keys come from the **Pricing Library** tab of *Pricing Calculator, Anyday WebOps Implementation* (Google Sheet, Oct 1 2026). The section mapping comes from that workbook's calculator tabs 01, 02 and 03, so configuration items whose library Phase is "Migration" but which sit on tab 03 appear under **Platform Extensions**.

| Rule | Behaviour |
| --- | --- |
| Quantity × unit price | Pages, components, content types, per site configuration |
| Progressive site activation | Sites 1 to 10 at $2,500, 11 to 50 at $1,750, 51 to 100 at $1,250, 101 plus at $750, each band priced at its own rate |
| First batch plus additional batches | Records ($5,000 first 500, $3,500 per further 500 or part), media ($2,500 / $1,500 per 1,000), bulk static pages ($3,500 / $2,500 per 50), redirects ($1,500 / $750 per 250). Zero quantity is never charged |
| Per block of N | Broken HTML cleanup and metadata cleanup: $2,500 and $1,500 per 500 records or part, calculated from a record count |
| Included | Basic migration cleanup at $0 |
| Starting at | Shown as "Starting at" until you confirm a price. The total reads "starting at" while one is included. It does not block export |
| Unpriced | Design items. Shown as "Price needed" and block final export |

Collapsed library rows keep every original pattern key (`MIG_DYNAMIC_FIRST_500` and `MIG_DYNAMIC_ADD_500` form the Structured records item, for example).

**Duplicate charges are prevented by design:** every URL has exactly one migration category; generated archives are regenerated rather than charged per URL; a design allocation re-attributes part of an existing fee without adding to the total, and cannot exceed that fee; a foundation integration whose existing connector meets the requirement cannot be priced as a new connector build; a prerequisite already included or provided by the foundation is never charged again; optional additions never enter the total.

### Decisions taken on ambiguities (all editable)

1. **Core multisite platform:** $75,000 in the Oct 1 library, $25,000 in the Sep 29 copy and the LF workbooks. The app uses $75,000. It is hidden in the LF Option 1 examples, so their totals are unaffected.
2. **Advanced brand controls:** $20,000 in the library, $15,000 in the original calculator. The app uses the library.
3. **Per 500 record cleanup items:** the original calculator multiplied quantity by price directly. The app takes a record count and charges per started block of 500.
4. **Starting at items** count toward the total and do not block export.
5. **Dependencies** between items (search setup needs a search capability, locale specific menus need localization, and so on) are suggestions derived from the item descriptions. They warn rather than block, and you can edit them in the library.
6. **Source content type count** proposed from a scan is unticked by default because public sitemaps do not always expose CMS types.

---

## 4. The LF examples

PyTorch, OpenSSF and CNCF are seeded as Option 1 examples on the existing AAIF foundation, built from the Oct 6 workbooks:

* Core platform, standard brand controls and advanced brand controls are hidden.
* Base quantities, migration rows and extensions match the workbooks. Migration and extension totals reproduce the workbooks exactly (PyTorch $54,000 and $7,250; OpenSSF $81,500 and $8,000; CNCF $111,500 and $8,750).
* Page and record quantities are counted from the imported Sitemap Analysis, which is labelled as a dated example inventory, never a fresh scan.
* Blocks listed in each workbook's redesign comment are set to Redesign (22, 22 and 24). All other blocks are Brand.
* Design items are included and unpriced, so all three stay drafts until design rates are entered.

---

## 5. Known gaps and limitations

* **AAIF block documentation was not supplied.** The catalogue holds the 26 block names referenced in the LF workbooks and is flagged as incomplete against the expected 39. Add the rest in Foundations → AAIF → Components.
* **AAIF integrations** are seeded from Anyday's engagement notes and marked unconfirmed.
* **Brand:** pure black, pure white and #A10E15 for accents; MD Lorien for headings (embedded from the supplied file) and Inter for body text; layout cues from the *Anyday WebOps for Multibrand Enterprises* deck. Only MD Lorien Regular was supplied, so headings use no italic. Add the italic file to `public/assets/fonts` to bring back the deck's roman and italic mix. MD Lorien allows embedding in PDFs; confirm the web licence covers its use in the app interface.
* **The scanner reads server rendered HTML.** It does not run JavaScript, so sites that build their content in the browser will show less structure than a visitor sees. Classifications are recommendations for review.
* **Scan bounds:** up to 200 sitemap files, 20,000 URLs, 600 inspected pages, 15 seconds and 3 MB per page, a 10 minute budget, one site at a time, robots.txt and crawl delay respected, private network destinations and unsafe redirects refused.
* **Interface prototype (Artifact):** runs entirely in the browser with the same code and seed data. It keeps data in memory only, shows exports as copyable text, and cannot scan sites or produce PDFs. Those features are disabled there, not simulated.

---

## 6. Project layout

```
shared/         pricing engine, inventory model, proposal renderer, library, quote types, migration, foundations seed data (shared/foundations/)
server/         Express API, JSON storage, PDF (Chromium), scanner/
client/         Preact interface (built to public/app.js)
scripts/        library and example generators, client build, UI walkthrough scripts
sources/        the source workbooks and brandmark
seed/quotes/    the three LF example quotes
test/           engine, scanner and API tests, plus a local fixture website
```

## 7. Tests

```bash
npm test
```

35 tests cover library prices against the source rows, section mapping, tier and batch boundaries, zero quantities, included items, starting at prices, overrides and snapshots, design allocations, optional additions, dependency handling, connector duplication, unpriced export blocking, SSRF protection, robots.txt, nested and gzipped sitemaps, partial failures, classification, media deduplication, CMS export parsing, rescan preservation, apply quantities, save and restore, edit conflicts, import and export, library versioning, and PDF output for short, long (CNCF with a 3,101 URL appendix) and single item scopes, and the full Google sign-in flow (domain restriction, forged sessions, forged OAuth state, cross-site writes, refusal to start publicly without sign-in).

`scripts/ui-walkthrough.mjs`, `scripts/ui-interact.mjs` and `scripts/ui-scan.mjs` drive the real interface in headless Chromium.

To regenerate the library and examples from the workbooks in `sources/`: `npm run seed`.

## 8. Brand files

| What | File |
| --- | --- |
| Logo for dark backgrounds (PDF cover) | `public/assets/anyday-logo-white.png` |
| Logo for light backgrounds | `public/assets/anyday-logo.png` |
| Gem mark (app header, PDF footer, favicon) | `public/assets/anyday-mark.png` |
| Fonts | `public/assets/fonts/` (MD Lorien, Inter) |
| Interface colours and fonts | `client/styles.css`, the `:root` tokens at the top |
| Proposal and PDF colours, fonts and layout | `shared/proposal.js`, the `BRAND` block and `proposalCss` |
| Original brand sources | `sources/brand/` (supplied logo, font file and reference deck) |
