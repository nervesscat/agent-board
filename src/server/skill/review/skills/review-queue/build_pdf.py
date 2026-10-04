#!/usr/bin/env python3
"""Build the review-queue PDF from per-PR summary.md files.

usage: python build_pdf.py --out report.pdf --title "Review queue 2026-09-07" a/summary.md b/summary.md

Renders a single HTML document (cover table + one page per PR), converts it with a
headless Edge/Chrome, and falls back to fpdf2 when no browser is found. Images referenced
from a summary are resolved relative to that summary's directory.
"""
import argparse
import datetime as dt
import html
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

# Which answer is the reassuring one for each of the three checks.
CHECKS = [
    ("reliable", "Is this reliable?", "YES"),
    ("works", "Did you make sure this works and is running?", "YES"),
    ("base", "Will this have any issue with the latest version of the base branch?", "NO"),
]

CSS = """
@page { size: A4; margin: 18mm 16mm; }
body { font: 11pt/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; }
h1 { font-size: 20pt; margin: 0 0 4pt; }
h2 { font-size: 12.5pt; margin: 16pt 0 4pt; border-bottom: 1px solid #ccc; padding-bottom: 2pt; }
h3 { font-size: 11pt; margin: 10pt 0 2pt; }
p { margin: 4pt 0 8pt; }
ul, ol { margin: 2pt 0 8pt 18pt; padding: 0; }
li { margin: 2pt 0; }
code { font: 9.5pt Consolas, Menlo, monospace; background: #f2f2f2; padding: 0 3px; border-radius: 3px; }
table { border-collapse: collapse; width: 100%; margin: 4pt 0 10pt; font-size: 10pt; page-break-inside: avoid; }
th, td { border: 1px solid #bbb; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #eee; }
h2, h3 { page-break-after: avoid; }
img { max-width: 100%; max-height: 90mm; display: block; margin: 6pt 0; border: 1px solid #ddd; page-break-inside: avoid; }
.meta { color: #555; font-size: 9.5pt; margin-bottom: 10pt; }
.pr { page-break-before: always; }
.good { color: #0b6b2e; font-weight: 700; }
.bad { color: #b00020; font-weight: 700; }
.cover h1 { font-size: 24pt; }
.cover .date { color: #555; margin-bottom: 14pt; }
"""

INLINE_PATTERNS = [
    (re.compile(r"\*\*(.+?)\*\*"), r"<b>\1</b>"),
    (re.compile(r"`([^`]+)`"), r"<code>\1</code>"),
    (re.compile(r"\[([^\]]+)\]\(([^)]+)\)"), r'<a href="\2">\1</a>'),
]


def inline(text):
    out = html.escape(text, quote=False)
    for pat, rep in INLINE_PATTERNS:
        out = pat.sub(rep, out)
    return out


def parse_blocks(md_path):
    """Parse the small markdown subset used by summary.md into a list of blocks."""
    base = pathlib.Path(md_path).parent
    blocks, para, items, list_tag, rows = [], [], [], None, []

    def flush_para():
        nonlocal para
        if para:
            blocks.append(("p", " ".join(para)))
            para = []

    def flush_list():
        nonlocal items, list_tag
        if items:
            blocks.append((list_tag, items))
            items, list_tag = [], None

    def flush_table():
        nonlocal rows
        if rows:
            blocks.append(("table", rows))
            rows = []

    for raw in pathlib.Path(md_path).read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        if not line.strip():
            flush_para(); flush_list(); flush_table()
            continue
        m = re.match(r"^(#{1,3})\s+(.*)$", line)
        if m:
            flush_para(); flush_list(); flush_table()
            blocks.append((f"h{len(m.group(1))}", m.group(2).strip()))
            continue
        m = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)\s*$", line)
        if m:
            flush_para(); flush_list(); flush_table()
            blocks.append(("img", m.group(1), str((base / m.group(2)).resolve())))
            continue
        if line.lstrip().startswith("|"):
            flush_para(); flush_list()
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                continue
            rows.append(cells)
            continue
        m = re.match(r"^\s*[-*]\s+(.*)$", line)
        if m:
            flush_para(); flush_table()
            if list_tag and list_tag != "ul":
                flush_list()
            list_tag = "ul"; items.append(m.group(1))
            continue
        m = re.match(r"^\s*\d+[.)]\s+(.*)$", line)
        if m:
            flush_para(); flush_table()
            if list_tag and list_tag != "ol":
                flush_list()
            list_tag = "ol"; items.append(m.group(1))
            continue
        flush_list(); flush_table()
        para.append(line.strip())
    flush_para(); flush_list(); flush_table()
    return blocks


def extract_checks(blocks):
    """Return {key: (answer, why)} from the table under the '## Checks' heading."""
    found, in_checks = {}, False
    for b in blocks:
        if b[0] == "h2":
            in_checks = b[1].strip().lower().startswith("checks")
        elif in_checks and b[0] == "table":
            for row in b[1]:
                if len(row) < 2 or row[0].lower() == "check":
                    continue
                label = row[0].lower()
                key = ("reliable" if "reliab" in label else
                       "works" if "works" in label or "running" in label else
                       "base" if "base" in label or "merge" in label else None)
                if key:
                    answer = row[1].strip().upper()
                    found[key] = ("YES" if answer.startswith("Y") else "NO",
                                  row[2].strip() if len(row) > 2 else "")
    return found


def render_blocks(blocks, img_src):
    out = []
    for b in blocks:
        kind = b[0]
        if kind in ("h1", "h2", "h3"):
            out.append(f"<{kind}>{inline(b[1])}</{kind}>")
        elif kind == "p":
            out.append(f"<p>{inline(b[1])}</p>")
        elif kind in ("ul", "ol"):
            out.append(f"<{kind}>" + "".join(f"<li>{inline(i)}</li>" for i in b[1]) + f"</{kind}>")
        elif kind == "img":
            caption, path = b[1], b[2]
            if os.path.isfile(path):
                out.append(f'<img src="{img_src(path)}" alt="{html.escape(caption)}">')
                if caption:
                    out.append(f'<p class="meta">{inline(caption)}</p>')
            else:
                out.append(f'<p class="meta">[missing image: {html.escape(caption or path)}]</p>')
        elif kind == "table":
            rows = b[1]
            head = "".join(f"<th>{inline(c)}</th>" for c in rows[0])
            body = ""
            for r in rows[1:]:
                cells = []
                for i, c in enumerate(r):
                    cls = ""
                    if i == 1 and c.strip().upper() in ("YES", "NO"):
                        good = next((g for k, lbl, g in CHECKS
                                     if (k == "reliable" and "reliab" in r[0].lower())
                                     or (k == "works" and ("works" in r[0].lower() or "running" in r[0].lower()))
                                     or (k == "base" and ("base" in r[0].lower() or "merge" in r[0].lower()))), None)
                        if good:
                            cls = ' class="good"' if c.strip().upper() == good else ' class="bad"'
                    cells.append(f"<td{cls}>{inline(c)}</td>")
                body += "<tr>" + "".join(cells) + "</tr>"
            out.append(f"<table><tr>{head}</tr>{body}</table>")
    return "\n".join(out)


def build_html(summaries, title, img_src):
    parsed = [(p, parse_blocks(p)) for p in summaries]
    cover_rows = []
    for path, blocks in parsed:
        h1 = next((b[1] for b in blocks if b[0] == "h1"), pathlib.Path(path).parent.name)
        checks = extract_checks(blocks)
        cells = [f"<td>{inline(h1)}</td>"]
        for key, _label, good in CHECKS:
            ans, _why = checks.get(key, ("?", ""))
            cls = "good" if ans == good else "bad"
            cells.append(f'<td class="{cls}">{html.escape(ans)}</td>')
        cover_rows.append("<tr>" + "".join(cells) + "</tr>")
    cover = (
        f'<section class="cover"><h1>{html.escape(title)}</h1>'
        f'<p class="date">{dt.date.today().isoformat()} &middot; {len(parsed)} pull request(s)</p>'
        "<table><tr><th>Pull request</th><th>Reliable?</th><th>Works and running?</th>"
        "<th>Issue with latest base?</th></tr>" + "".join(cover_rows) + "</table></section>"
    )
    sections = "".join(f'<section class="pr">{render_blocks(b, img_src)}</section>' for _p, b in parsed)
    return (f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title>"
            f"<style>{CSS}</style></head><body>{cover}{sections}</body></html>")


def find_browser():
    cands = [os.environ.get("PDF_BROWSER")]
    cands += [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    for name in ("msedge", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        p = shutil.which(name)
        if p:
            return p
    return None


def render_with_browser(exe, html_path, pdf_path):
    with tempfile.TemporaryDirectory() as profile:
        cmd = [exe, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
               f"--user-data-dir={profile}", "--no-pdf-header-footer", "--print-to-pdf-no-header",
               f"--print-to-pdf={pdf_path}", pathlib.Path(html_path).resolve().as_uri()]
        subprocess.run(cmd, timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return os.path.isfile(pdf_path) and os.path.getsize(pdf_path) > 0


def render_with_fpdf(html_doc, pdf_path):
    from fpdf import FPDF  # fpdf2
    # Core fonts are latin-1; keep only the body and drop what they cannot print.
    doc = re.search(r"<body>(.*)</body>", html_doc, flags=re.S).group(1)
    doc = re.sub(r"<section[^>]*>", "", doc).replace("</section>", "<br>")
    doc = doc.encode("latin-1", "replace").decode("latin-1")
    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    pdf.set_font("helvetica", size=10)
    pdf.write_html(doc)
    pdf.output(pdf_path)
    return os.path.isfile(pdf_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="Review queue")
    ap.add_argument("--html-only", action="store_true", help="write the HTML next to --out and stop")
    ap.add_argument("summaries", nargs="+")
    a = ap.parse_args()

    out = pathlib.Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    html_path = out.with_suffix(".html")
    html_path.write_text(build_html(a.summaries, a.title, lambda p: pathlib.Path(p).as_uri()), encoding="utf-8")
    if a.html_only:
        print(html_path)
        return 0

    exe = find_browser()
    if exe and render_with_browser(exe, html_path, str(out)):
        print(out)
        return 0
    try:
        plain = build_html(a.summaries, a.title, lambda p: p)
        if render_with_fpdf(plain, str(out)):
            print(f"{out} (fpdf2 fallback)")
            return 0
    except ImportError:
        pass
    print(f"No PDF renderer found. HTML written to {html_path}; open it and print to PDF, "
          f"or set PDF_BROWSER to a Chrome/Edge executable.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
