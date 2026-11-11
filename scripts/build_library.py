"""Generate shared/library-default.json from the Anyday source workbooks.

Source of truth for prices, units and pattern keys:
  Pricing Calculator - Anyday WebOps Implementation.xlsx  ->  "Pricing Library" tab (Oct 1 2026)
Source of truth for section mapping:
  the same workbook's calculator tabs 01 / 02 / 03.

Plain language copy (what it means / what the client receives) is authored here and is
editable later in the Pricing Library screen. Prices are never typed in this file.
"""
import json, sys, datetime
import openpyxl

SRC = sys.argv[1]
OUT = sys.argv[2]

wb = openpyxl.load_workbook(SRC, data_only=False)
lib = {}
for r in wb["Pricing Library"].iter_rows(min_row=3, values_only=True):
    if not r[0]:
        continue
    key, phase, cat, sub, name, price, unit, notes = r[:8]
    lib[key] = dict(key=key, phase=phase, category=cat, subcategory=sub, name=name,
                    price=float(price), unit=unit, notes=notes)

def tab_keys(tab, col=0, start=5):
    out = []
    for r in wb[tab].iter_rows(min_row=start, values_only=True):
        v = r[col]
        if isinstance(v, str) and (v.startswith("BASE_") or v.startswith("MIG_")):
            out.append(v)
    return out

tab01 = tab_keys("01. WebOps Base Calculator")
tab03 = tab_keys("03. Platform Extensions Calcula")
# tab 02 rows are labelled by pattern name rather than key; map explicitly and assert below
tab02_rows = [r[0] for r in wb["02. Migration Calculator"].iter_rows(min_row=5, max_row=13, values_only=True)]
TAB02_MAP = {
    "Sites to activate": ["MIG_SITE_ACTIVATION_1_10", "MIG_SITE_ACTIVATION_11_50", "MIG_SITE_ACTIVATION_51_100", "MIG_SITE_ACTIVATION_101_PLUS"],
    "Level 1 composed pages": ["MIG_L1_PAGE"],
    "Level 2 composed pages": ["MIG_L2_PAGE"],
    "Level 3 simple pages": ["MIG_L3_PAGE"],
    "Bulk static pages": ["MIG_STATIC_FIRST_50", "MIG_STATIC_ADD_50"],
    "Structured records": ["MIG_DYNAMIC_FIRST_500", "MIG_DYNAMIC_ADD_500"],
    "Source content types": ["MIG_CONTENT_TYPE_MAP"],
    "Media assets": ["MIG_MEDIA_FIRST_1000", "MIG_MEDIA_ADD_1000"],
    "Redirect URLs": ["MIG_REDIRECT_250", "MIG_REDIRECT_ADD_250"],
}
assert tab02_rows == list(TAB02_MAP), tab02_rows
tab02 = [k for v in TAB02_MAP.values() for k in v]
all_tab = set(tab01) | set(tab02) | set(tab03)
assert all_tab == set(lib), (set(lib) - all_tab, all_tab - set(lib))

SECTION_OF = {}
for k in tab01: SECTION_OF[k] = "base"
for k in tab02: SECTION_OF[k] = "migration"
for k in tab03: SECTION_OF[k] = "extensions"

# ---- plain language copy -------------------------------------------------
# (what it means, what the client receives). Editable in the app.
COPY = {
 "BASE_CORE_PLATFORM": ("A new shared multisite platform built from scratch: CMS, front end framework, hosting pipeline and shared foundations.", "A production ready platform that every current and future site can run on."),
 "BASE_STD_PAGE_TEMPLATE": ("A new reusable page structure built once for the platform.", "One new page template editors can reuse on any site."),
 "BASE_ADV_PAGE_TEMPLATE": ("A new reusable page structure with complex layout or behaviour.", "One advanced page template with its interactive behaviour."),
 "BASE_STD_COMPONENT": ("A new reusable content block added to the shared library.", "One new block with its fields, rendering and editor experience."),
 "BASE_ADV_COMPONENT": ("A new reusable block with complex behaviour, data or interaction.", "One advanced block with its fields, logic, rendering and editor experience."),
 "BASE_STRUCT_CONTENT_MODEL": ("A new repeatable content type such as news, events, people, projects or resources.", "One content model with fields, editor views and listing or detail rendering."),
 "BASE_STD_BRAND_CONTROLS": ("Global brand controls for colours, typography and logos.", "A brand control set editors can use to theme a site."),
 "BASE_ADV_BRAND_CONTROLS": ("Expanded theme system covering radius, spacing, widths, imagery, headers, footers and section variation.", "An advanced theme control set for deeper brand variation between sites."),
 "BASE_GLOBAL_DESIGN_CONTROL": ("One additional global styling control added to the theme system.", "One new reusable design control."),
 "BASE_SHARED_INTEGRATION_EXISTING": ("Enable an integration the platform already supports.", "The integration switched on and configured for shared use."),
 "BASE_SHARED_INTEGRATION_NEW": ("A new reusable integration added to the shared platform.", "A new integration available to every site."),
 "BASE_NEW_SIMPLE_API": ("Connect one external service with a simple read or write.", "A working connection to one external service."),
 "BASE_NEW_ADV_API": ("Connect a service with multiple endpoints, authentication, transforms, sync or error handling.", "A robust connection to one complex external service."),
 "BASE_ENDPOINT": ("One more endpoint on an existing API connection.", "One additional endpoint wired into the platform."),
 "BASE_WEBHOOK": ("An automated workflow triggered by an event in another system.", "One reusable webhook workflow."),
 "BASE_DATA_SOURCE": ("A new external data source feeding structured content.", "One reusable data source connection."),
 "BASE_COMPLEX_SYNC_SOURCE": ("An external data source kept in ongoing sync with the platform.", "One continuously synchronised data source."),
 "BASE_DATA_MAPPING": ("One additional mapping between external data and platform content.", "One reusable data mapping."),
 "BASE_SCHEDULED_SYNC": ("A data sync that runs on a schedule.", "One reusable scheduled synchronisation."),
 "BASE_SITE_SEARCH": ("Standard search across site content.", "A reusable site search capability."),
 "BASE_FACETED_SEARCH": ("Search with filters and facets.", "Filterable search results with facets."),
 "BASE_EXTERNAL_SEARCH": ("Connect an external search platform such as Algolia or Elastic.", "Search powered by the chosen external platform."),
 "BASE_SEARCH_INDEX": ("One more search index for a distinct content set.", "One additional reusable search index."),
 "BASE_MULTI_CONTENT_SEARCH": ("Unified search across several content types.", "One search experience spanning multiple content models."),
 "BASE_TRANSLATION_INTEGRATION": ("Connect a translation service to the platform.", "A reusable translation integration."),
 "BASE_LOCALIZATION_ARCH": ("Locale architecture and routing for multilingual sites.", "Reusable locale structure, routing and editor support."),
 "BASE_ECOMMERCE_SIMPLE": ("A simple donation or payment flow.", "One reusable payment or donation flow."),
 "BASE_ECOMMERCE_PLATFORM": ("Connect a commerce platform.", "A reusable commerce platform connection."),
 "BASE_PRODUCT_CATALOG": ("A product catalogue content structure and display.", "A reusable product catalogue."),
 "BASE_FULL_COMMERCE": ("A full commerce implementation.", "A complete commerce capability, scoped in detail before confirmation."),
 "BASE_AUTH_AREA": ("A signed in area for members.", "A reusable authenticated member area."),
 "BASE_USER_PROFILES": ("Member profiles.", "A reusable profile capability."),
 "BASE_DASHBOARD": ("A member dashboard.", "A reusable dashboard."),
 "BASE_ROLE_PERMISSIONS": ("Role based permissions for members or editors.", "A reusable permission model."),
 "BASE_IDP": ("Single sign on or an external identity provider.", "Sign in through the chosen identity provider."),
 "BASE_COMPLEX_PORTAL": ("A complex member portal.", "A portal capability, scoped in detail before confirmation."),
 "BASE_GATED_RESOURCE": ("A resource that requires a simple gate before access.", "A reusable gated content pattern."),
 "BASE_REG_GATE": ("Content unlocked by registration.", "A reusable registration gate."),
 "BASE_CRM_GATE": ("Gated content connected to the CRM.", "A reusable CRM connected gate."),
 "BASE_ROLE_GATE": ("Content gated by member role.", "Reusable role based gating."),
 "BASE_SIMPLE_TOOL": ("A reusable interactive tool such as a selector, calculator or explorer.", "One interactive tool, scoped in detail before confirmation."),
 "BASE_DATA_APP": ("A data driven application inside the platform.", "One data driven application, scoped in detail before confirmation."),
 "MIG_SITE_ACTIVATION": ("Set up each site on the platform: CMS project, settings, deployment, QA, domain and launch.", "Each site live on the platform."),
 "MIG_L1_PAGE": ("A major page requiring substantial assembly.", "The page rebuilt on the platform with its content and blocks."),
 "MIG_L2_PAGE": ("A supporting page assembled from established patterns.", "The page rebuilt on the platform from existing blocks."),
 "MIG_L3_PAGE": ("A simple, standardised page with limited assembly.", "The page migrated into a standard layout."),
 "MIG_BULK_STATIC": ("Near identical static pages migrated in bulk instead of page by page.", "The page set migrated with a shared layout."),
 "MIG_STRUCTURED_RECORDS": ("Repeatable content such as articles, news, events, people, projects and resources.", "Records migrated into structured content models."),
 "MIG_CONTENT_TYPE_MAP": ("Map each legacy content type to its new content model.", "A documented, implemented mapping for each source content type."),
 "MIG_MEDIA": ("Images, files and other media moved into the new media library.", "Media assets migrated and linked to their content."),
 "MIG_REDIRECTS": ("Old URLs that change are mapped to their new location.", "A tested redirect map for the URLs that change."),
 "MIG_BASIC_CLEANUP": ("Basic automated cleanup during migration.", "Content imported with standard automated cleanup."),
 "MIG_FIELD_NORMALIZE": ("Systematic normalisation of field values for a content type.", "Consistent field values for each normalised content type."),
 "MIG_HTML_CLEANUP": ("Systematic cleanup of malformed HTML in migrated records.", "Clean rich text in the affected records."),
 "MIG_URL_NORMALIZE": ("Systematic normalisation of URL structure for a site.", "Consistent URL patterns for the site."),
 "MIG_METADATA_CLEANUP": ("Systematic cleanup of record metadata.", "Consistent metadata in the affected records."),
 "MIG_ENABLE_TRANSLATION": ("Activate the supported translation workflow on a site.", "Translation workflow enabled for the site."),
 "MIG_LANGUAGE": ("Configure one additional language.", "One more language available to editors and visitors."),
 "MIG_LOCALIZATION": ("Activate the existing locale architecture on a site.", "Locale routing and editor support enabled for the site."),
 "MIG_LOCALE_NAV": ("Navigation specific to one locale.", "A dedicated navigation for each locale."),
 "MIG_LOCALE_RULES": ("Rules for which content appears in which locale.", "Locale content rules configured for the site."),
 "MIG_REGION_VARIATION": ("A regional variation of a site.", "One configured regional variation."),
 "MIG_BRAND_CONFIG": ("Apply the site's logo, colours and fonts using existing global controls.", "The site styled with its brand using existing controls."),
 "MIG_CRM_SETUP": ("Configure a CRM the platform already supports.", "The site connected to its CRM."),
 "MIG_STANDARD_FORM": ("Connect one standard form.", "One working form connected to its destination."),
 "MIG_ADV_FORM": ("Configure one advanced supported form workflow.", "One advanced form workflow."),
 "MIG_NEWSLETTER": ("Connect the supported newsletter integration.", "Newsletter sign up connected for the site."),
 "MIG_API_SETUP": ("Configure an integration that already exists in the base.", "The existing integration configured for the site."),
 "MIG_DATA_SOURCE_SETUP": ("Configure a supported data source for a site.", "The data source connected for the site."),
 "MIG_SEARCH_SETUP": ("Configure the shared search for a site.", "Search configured and working for the site."),
 "MIG_MEMBER_DIRECTORY": ("Configure the existing member directory pattern for a site.", "A working member directory for the site."),
 "MIG_ANALYTICS": ("Configure and validate analytics.", "Analytics configured and validated for the site."),
 "MIG_SEO_METADATA": ("Migrate SEO metadata into the new content model.", "Titles, descriptions and social metadata carried over."),
 "MIG_ECOMMERCE_SETUP": ("Configure the supported commerce capability for a site.", "Commerce configured for the site."),
 "MIG_GATED_CONTENT_SETUP": ("Configure the supported gated content pattern for a site.", "Gated content configured for the site."),
}

UNIT_LABEL = {  # quantity unit shown next to the input (singular, plural)
 "each": ("item", "items"), "starting": ("item", "items"), "site": ("site", "sites"), "page": ("page", "pages"),
 "type": ("content type", "content types"), "content type": ("content type", "content types"),
 "language": ("language", "languages"), "locale": ("locale", "locales"), "variation": ("variation", "variations"),
 "form": ("form", "forms"), "source": ("source", "sources"), "included": ("item", "items"),
}

# Suggested dependencies (editable). Prerequisite may be satisfied by an included item
# or by a capability the chosen foundation already provides, in which case nothing is charged twice.
DEPENDS = {
 "BASE_SEARCH_INDEX": [["BASE_SITE_SEARCH", "BASE_FACETED_SEARCH", "BASE_EXTERNAL_SEARCH"]],
 "BASE_MULTI_CONTENT_SEARCH": [["BASE_SITE_SEARCH", "BASE_FACETED_SEARCH", "BASE_EXTERNAL_SEARCH"]],
 "BASE_ENDPOINT": [["BASE_NEW_SIMPLE_API", "BASE_NEW_ADV_API", "BASE_SHARED_INTEGRATION_EXISTING", "BASE_SHARED_INTEGRATION_NEW"]],
 "BASE_DATA_MAPPING": [["BASE_DATA_SOURCE", "BASE_COMPLEX_SYNC_SOURCE"]],
 "BASE_SCHEDULED_SYNC": [["BASE_DATA_SOURCE", "BASE_COMPLEX_SYNC_SOURCE"]],
 "BASE_USER_PROFILES": [["BASE_AUTH_AREA", "BASE_COMPLEX_PORTAL"]],
 "BASE_DASHBOARD": [["BASE_AUTH_AREA", "BASE_COMPLEX_PORTAL"]],
 "BASE_ROLE_PERMISSIONS": [["BASE_AUTH_AREA", "BASE_COMPLEX_PORTAL"]],
 "BASE_ROLE_GATE": [["BASE_ROLE_PERMISSIONS"]],
 "BASE_PRODUCT_CATALOG": [["BASE_ECOMMERCE_PLATFORM", "BASE_FULL_COMMERCE"]],
 "MIG_ENABLE_TRANSLATION": [["BASE_TRANSLATION_INTEGRATION"]],
 "MIG_LANGUAGE": [["MIG_ENABLE_TRANSLATION", "MIG_LOCALIZATION"]],
 "MIG_LOCALIZATION": [["BASE_LOCALIZATION_ARCH"]],
 "MIG_LOCALE_NAV": [["MIG_LOCALIZATION"]],
 "MIG_LOCALE_RULES": [["MIG_LOCALIZATION"]],
 "MIG_REGION_VARIATION": [["MIG_LOCALIZATION"]],
 "MIG_SEARCH_SETUP": [["BASE_SITE_SEARCH", "BASE_FACETED_SEARCH", "BASE_EXTERNAL_SEARCH"]],
 "MIG_API_SETUP": [["BASE_SHARED_INTEGRATION_EXISTING", "BASE_SHARED_INTEGRATION_NEW", "BASE_NEW_SIMPLE_API", "BASE_NEW_ADV_API"]],
 "MIG_DATA_SOURCE_SETUP": [["BASE_DATA_SOURCE", "BASE_COMPLEX_SYNC_SOURCE"]],
 "MIG_ECOMMERCE_SETUP": [["BASE_ECOMMERCE_SIMPLE", "BASE_ECOMMERCE_PLATFORM", "BASE_FULL_COMMERCE"]],
 "MIG_GATED_CONTENT_SETUP": [["BASE_GATED_RESOURCE", "BASE_REG_GATE", "BASE_CRM_GATE", "BASE_ROLE_GATE"]],
 "MIG_HTML_CLEANUP": [["MIG_STRUCTURED_RECORDS"]],
 "MIG_METADATA_CLEANUP": [["MIG_STRUCTURED_RECORDS"]],
}

def money(v):
    return int(round(v * 100))  # cents

items = []
def add(item):
    items.append(item)

def base_item(key):
    s = lib[key]
    unit = s["unit"]
    what, receives = COPY[key]
    status = "starting_at" if unit == "starting" else "confirmed"
    model = "included" if unit == "included" else "per_unit"
    sing, plur = UNIT_LABEL.get(unit, (unit, unit + "s"))
    item = dict(
        id=key, keys=[key], name=s["name"], what=what, receives=receives,
        sourceNotes=s["notes"], phase=s["phase"], category=s["category"], subcategory=s["subcategory"],
        section=SECTION_OF[key], subsection="implementation",
        pricing=dict(model=model, unitPrice=money(s["price"]), status=status,
                     sourceUnit=unit, qtyUnit=sing, qtyUnitPlural=plur),
        dependsOn=DEPENDS.get(key, []), optionalAvailable=True, isDesign=False,
    )
    return item

handled = set()
for key in tab01:
    add(base_item(key)); handled.add(key)

# ---- migration tab (collapsed tier and batch rows keep every original key) ----
act = [lib[k] for k in TAB02_MAP["Sites to activate"]]
add(dict(id="MIG_SITE_ACTIVATION", keys=TAB02_MAP["Sites to activate"], name="Site activation",
         what=COPY["MIG_SITE_ACTIVATION"][0], receives=COPY["MIG_SITE_ACTIVATION"][1],
         sourceNotes=act[0]["notes"], phase="Migration", category="Content + Migration", subcategory="Site Activation",
         section="migration", subsection="implementation",
         pricing=dict(model="progressive", status="confirmed", qtyUnit="site", qtyUnitPlural="sites", sourceUnit="site",
                      tiers=[dict(key=act[0]["key"], label="Sites 1 to 10", upTo=10, price=money(act[0]["price"])),
                             dict(key=act[1]["key"], label="Sites 11 to 50", upTo=50, price=money(act[1]["price"])),
                             dict(key=act[2]["key"], label="Sites 51 to 100", upTo=100, price=money(act[2]["price"])),
                             dict(key=act[3]["key"], label="Sites 101 plus", upTo=None, price=money(act[3]["price"]))]),
         dependsOn=[], optionalAvailable=True, isDesign=False))
for k in TAB02_MAP["Sites to activate"]: handled.add(k)

for key in ["MIG_L1_PAGE", "MIG_L2_PAGE", "MIG_L3_PAGE", "MIG_CONTENT_TYPE_MAP"]:
    it = base_item(key); it["section"] = "migration"; add(it); handled.add(key)

def batched(id_, name, first, addk, sing, plur, unit_word):
    f, a = lib[first], lib[addk]
    size_f = {"MIG_STATIC_FIRST_50": 50, "MIG_DYNAMIC_FIRST_500": 500, "MIG_MEDIA_FIRST_1000": 1000, "MIG_REDIRECT_250": 250}[first]
    size_a = {"MIG_STATIC_ADD_50": 50, "MIG_DYNAMIC_ADD_500": 500, "MIG_MEDIA_ADD_1000": 1000, "MIG_REDIRECT_ADD_250": 250}[addk]
    add(dict(id=id_, keys=[first, addk], name=name, what=COPY[id_][0], receives=COPY[id_][1],
             sourceNotes=f["notes"] + " " + a["notes"], phase="Migration", category=f["category"], subcategory=f["subcategory"],
             section="migration", subsection="implementation",
             pricing=dict(model="batched", status="confirmed", qtyUnit=sing, qtyUnitPlural=plur, sourceUnit="block",
                          first=dict(key=first, size=size_f, price=money(f["price"])),
                          additional=dict(key=addk, size=size_a, price=money(a["price"]))),
             dependsOn=DEPENDS.get(id_, []), optionalAvailable=True, isDesign=False))
    handled.update([first, addk])

batched("MIG_BULK_STATIC", "Bulk static pages", "MIG_STATIC_FIRST_50", "MIG_STATIC_ADD_50", "page", "pages", "pages")
batched("MIG_STRUCTURED_RECORDS", "Structured records", "MIG_DYNAMIC_FIRST_500", "MIG_DYNAMIC_ADD_500", "record", "records", "records")
batched("MIG_MEDIA", "Media assets", "MIG_MEDIA_FIRST_1000", "MIG_MEDIA_ADD_1000", "asset", "assets", "assets")
batched("MIG_REDIRECTS", "Redirect mapping", "MIG_REDIRECT_250", "MIG_REDIRECT_ADD_250", "redirect", "redirects", "URLs")

# order migration items like the calculator tab
order = ["MIG_SITE_ACTIVATION", "MIG_L1_PAGE", "MIG_L2_PAGE", "MIG_L3_PAGE", "MIG_BULK_STATIC", "MIG_STRUCTURED_RECORDS",
         "MIG_CONTENT_TYPE_MAP", "MIG_MEDIA", "MIG_REDIRECTS"]
mig = {i["id"]: i for i in items if i["section"] == "migration"}
items = [i for i in items if i["section"] != "migration"] + [mig[o] for o in order]

for key in tab03:
    it = base_item(key)
    if lib[key]["unit"] == "500 records":
        it["pricing"] = dict(model="per_block", status="confirmed", qtyUnit="record", qtyUnitPlural="records",
                             sourceUnit="500 records", blockSize=500, price=money(lib[key]["price"]))
    add(it); handled.add(key)

assert handled == set(lib), set(lib) - handled

# ---- design items: unpriced, editable -------------------------------------
DESIGN = [
 ("DESIGN_DIRECTION", "Visual direction and brand application",
  "Establish the visual direction and apply the brand across the component library and page templates.",
  "An approved visual direction: type, colour, imagery and component styling applied across the component library.", "direction", "directions"),
 ("DESIGN_COMPONENTS", "Component design",
  "Design of the components in scope. On a new platform this is each new reusable component. On an existing foundation it is each existing component chosen for visual redesign, which keeps its schema and behaviour; new fields, filters, workflows or functionality are separate development scope.",
  "Approved designs for each component, counted once however often it appears.", "component", "components"),
 ("DESIGN_PAGE_LAYOUTS", "Representative page layout designs",
  "Full page designs for representative templates that show how the components compose.",
  "Approved designs for each representative page layout.", "layout", "layouts"),
 ("DESIGN_REVIEWS", "Design review rounds",
  "Structured review and revision rounds on the design work.",
  "Consolidated feedback rounds with revised designs.", "round", "rounds"),
]
for id_, name, what, rec, s_, p_ in DESIGN:
    add(dict(id=id_, keys=[id_], name=name, what=what, receives=rec, sourceNotes="Design rates not established in source workbooks.",
             phase="Base", category="Design + Experience", subcategory="Design", section="base", subsection="design",
             pricing=dict(model="per_unit", unitPrice=None, status="unpriced", qtyUnit=s_, qtyUnitPlural=p_, sourceUnit="each"),
             dependsOn=[], optionalAvailable=True, isDesign=True,
             quantitySource="component_design_count" if id_ == "DESIGN_COMPONENTS" else None))

# ---- quote types and their presets (editable in the Pricing Library) --------
QUOTE_TYPES = [
 dict(id="new_site", name="New website from scratch",
      description="Design and build one website from scratch, with nothing reused from an existing platform.",
      usesFoundation="none", sitesStep=False),
 dict(id="new_platform", name="New platform and rollout",
      description="Build a new multisite platform from scratch, then roll out the portfolio of sites onto it.",
      usesFoundation="optional", sitesStep=True),
 dict(id="foundation_site", name="New site on an existing foundation",
      description="Build a site for a sub brand or sister organisation by reusing a platform foundation Anyday already built.",
      usesFoundation="required", sitesStep=False),
 dict(id="expansion", name="Expand a platform we already run",
      description="Add new sites to a live Anyday platform. Volume pricing continues from the sites already live.",
      usesFoundation="required", sitesStep=True),
]
MIGRATION_CORE = ["MIG_SITE_ACTIVATION", "MIG_L1_PAGE", "MIG_L2_PAGE", "MIG_L3_PAGE", "MIG_STRUCTURED_RECORDS",
                  "MIG_CONTENT_TYPE_MAP", "MIG_MEDIA", "MIG_REDIRECTS"]
PRESETS = {
 "new_platform": {
   **{k: dict(state="included", qty=1) for k in ["BASE_CORE_PLATFORM", "BASE_STD_BRAND_CONTROLS", "DESIGN_DIRECTION", "MIG_BASIC_CLEANUP"]},
   **{k: dict(state="included") for k in ["BASE_STD_PAGE_TEMPLATE", "BASE_STD_COMPONENT", "BASE_STRUCT_CONTENT_MODEL",
                                          "DESIGN_COMPONENTS", "DESIGN_PAGE_LAYOUTS", "DESIGN_REVIEWS", "MIG_BRAND_CONFIG"] + MIGRATION_CORE},
 },
 "new_site": {
   **{k: dict(state="included", qty=1) for k in ["BASE_CORE_PLATFORM", "BASE_STD_BRAND_CONTROLS", "DESIGN_DIRECTION", "MIG_BASIC_CLEANUP", "MIG_SITE_ACTIVATION"]},
   **{k: dict(state="included") for k in ["BASE_STD_PAGE_TEMPLATE", "BASE_STD_COMPONENT", "BASE_STRUCT_CONTENT_MODEL",
                                          "DESIGN_COMPONENTS", "DESIGN_PAGE_LAYOUTS", "DESIGN_REVIEWS"] + MIGRATION_CORE[1:]},
   **{k: dict(state="hidden") for k in ["MIG_BRAND_CONFIG"]},
 },
 "foundation_site": {
   **{k: dict(state="hidden") for k in ["BASE_CORE_PLATFORM", "BASE_STD_BRAND_CONTROLS", "BASE_ADV_BRAND_CONTROLS"]},
   **{k: dict(state="included", qty=1) for k in ["MIG_SITE_ACTIVATION", "MIG_BASIC_CLEANUP", "MIG_BRAND_CONFIG", "DESIGN_DIRECTION"]},
   **{k: dict(state="included") for k in ["DESIGN_COMPONENTS", "DESIGN_PAGE_LAYOUTS", "DESIGN_REVIEWS"] + MIGRATION_CORE[1:]},
 },
 "expansion": {
   **{k: dict(state="hidden") for k in ["BASE_CORE_PLATFORM", "BASE_STD_BRAND_CONTROLS", "BASE_ADV_BRAND_CONTROLS"]},
   **{k: dict(state="included", qty=1) for k in ["MIG_BASIC_CLEANUP"]},
   **{k: dict(state="included") for k in ["MIG_BRAND_CONFIG"] + MIGRATION_CORE},
 },
}
for it in items:
    it["presets"] = {t: PRESETS[t][it["id"]] for t in PRESETS if it["id"] in PRESETS[t]}

library = dict(
    schemaVersion=2,
    quoteTypes=QUOTE_TYPES,
    name="Anyday WebOps Pricing Library",
    version="2026-10-01",
    currency="USD",
    updatedAt=datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
    source=dict(
        workbook="Pricing Calculator - Anyday WebOps Implementation (Google Sheet, modified 2026-10-01)",
        tab="Pricing Library",
        note="Prices, units and pattern keys from the Pricing Library tab. Section mapping from calculator tabs 01, 02 and 03.",
    ),
    sections=[
        dict(id="base", name="WebOps Base + Design", order=1, sourceTab="01. WebOps Base Calculator",
             intro="The shared implementation and design work built once and reused across every site."),
        dict(id="migration", name="Migration", order=2, sourceTab="02. Migration Calculator",
             intro="Moving the sites' pages, records, media and URLs onto the platform."),
        dict(id="extensions", name="Platform Extensions", order=3, sourceTab="03. Platform Extensions Calculator",
             intro="Supported configuration and cleanup beyond core migration volume."),
    ],
    items=items,
    sourceRows=[dict(key=v["key"], phase=v["phase"], name=v["name"], price=money(v["price"]), unit=v["unit"]) for v in lib.values()],
)
json.dump(library, open(OUT, "w"), indent=1)
print(len(items), "library items;", len(lib), "source rows")
