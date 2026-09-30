import glob, re, sys
import markdown
from pygments.formatters import HtmlFormatter
from playwright.sync_api import sync_playwright

src = "\n\n".join(open(f).read() for f in sorted(glob.glob("0*.md")))
md = markdown.Markdown(extensions=["fenced_code", "codehilite", "tables", "toc", "md_in_html", "attr_list"],
                       extension_configs={"codehilite": {"guess_lang": False, "css_class": "codehilite"}})
body = md.convert(src)
# number chapters (every h1 except the cover title and Contents)
body = re.sub(r'<h1 id="(?!contents|ticket-mng)', '<h1 class="chapter" id="', body)

css = HtmlFormatter(style="friendly").get_style_defs(".codehilite") + open("style.css").read()
html = f"""<!doctype html><html><head><meta charset="utf-8"><title>ticket-mng: a beginner's guide</title>
<style>{css}</style></head><body>{body}</body></html>"""
open("guide.html", "w").write(html)

out = sys.argv[1] if len(sys.argv) > 1 else "guide.pdf"
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium")
    page = b.new_page()
    page.goto("file://" + __import__("os").path.abspath("guide.html"))
    page.pdf(path=out, format="A4", print_background=True, display_header_footer=True,
             header_template="<span></span>",
             footer_template='<div style="font-size:8px;width:100%;text-align:center;color:#888;font-family:DejaVu Sans,sans-serif">ticket-mng · a beginner\'s guide · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
             margin={"top": "18mm", "bottom": "18mm", "left": "16mm", "right": "16mm"})
    b.close()
print("wrote", out)
