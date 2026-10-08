"""Extract the PyTorch, OpenSSF and CNCF examples from their workbooks into raw JSON.
Quantities and classifications are provisional examples, not live scans."""
import json, sys, re, os
import openpyxl

SRC_DIR, OUT = sys.argv[1], sys.argv[2]
EXAMPLES = [
    ("PyTorch", "PyTorch Foundation", "https://pytorch.org", "PyTorch_WebOps_Pricing.xlsx"),
    ("OpenSSF", "Open Source Security Foundation", "https://openssf.org", "OpenSSF_WebOps_Pricing.xlsx"),
    ("CNCF", "Cloud Native Computing Foundation", "https://www.cncf.io", "CNCF_WebOps_Pricing.xlsx"),
]
BUCKET = {"Level 1 composed pages": "L1", "Level 2 composed pages": "L2", "Level 3 simple pages": "L3",
          "Structured records": "RECORD", "Generated archive": "ARCHIVE", "Bulk static pages": "BULK_STATIC"}
CONF = {"Verified sitemap class": "high", "HTML inspected; provisional level": "medium",
        "Target model proposal; review": "low", "URL inference; review": "medium"}

out = []
all_blocks = []
for short, client, url, fname in EXAMPLES:
    wb = openpyxl.load_workbook(os.path.join(SRC_DIR, fname))
    base = wb["01. WebOps Base Calculator"]
    base_qty = {}
    for r in base.iter_rows(min_row=5, max_row=51):
        k, q = r[0].value, r[4].value
        if k and isinstance(q, (int, float)):
            base_qty[k] = q
    comment = base["E49"].comment.text
    blocks = [b.strip() for b in re.search(r"Selected blocks: (.*?)\. Count", comment).group(1).split(",")]
    for b in blocks:
        if b not in all_blocks:
            all_blocks.append(b)
    mig = wb["02. Migration Calculator"]
    mig_vals = {r[0].value: r[1].value for r in mig.iter_rows(min_row=5, max_row=13)}
    mig_comments = {r[0].value: (r[1].comment.text if r[1].comment else None) for r in mig.iter_rows(min_row=5, max_row=13)}
    ext = wb["03. Platform Extensions Calcula"]
    ext_qty = {r[0].value: r[3].value for r in ext.iter_rows(min_row=5, max_row=28) if r[0].value}
    notes = [r[0] for r in wb["Summary"].iter_rows(min_row=10, values_only=True) if r[0]]
    entries = []
    for r in wb["Sitemap Analysis"].iter_rows(min_row=2, values_only=True):
        (u, page_type, ctype, bucket, basis, review, sitemap, lastmod, title, heads, forms, embeds, incl, cms, err) = r[:15]
        if not u:
            continue
        cat = BUCKET.get(bucket, "REVIEW")
        entries.append(dict(
            url=u, title=title or "", contentType=ctype or "", category=cat, include=incl in ("Yes", "Regenerate"),
            reason=basis or "", evidence=f"{review}; sitemap: {sitemap}" if sitemap else (review or ""),
            confidence=CONF.get(review, "medium"), reviewLabel=review, sourceCmsType=cms or "", sitemap=sitemap or "",
            lastmod=str(lastmod) if lastmod else "", headings=(heads or "")[:240], forms=forms, embeds=embeds,
            fetchError=err or "", pageType=page_type or ""))
    out.append(dict(short=short, client=client, url=url, workbook=fname, baseQty=base_qty, blocks=blocks,
                    migration=mig_vals, migrationComments=mig_comments, extensions=ext_qty, notes=notes, entries=entries,
                    workbookDate="2026-10-06"))
json.dump(dict(examples=out, blocksReferenced=all_blocks), open(OUT, "w"))
print(len(all_blocks), "unique AAIF blocks referenced:", all_blocks)
for e in out:
    print(e["short"], len(e["entries"]), "urls")
