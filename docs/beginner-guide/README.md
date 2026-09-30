# Beginner's guide: source

Markdown source of [`../BEGINNER-GUIDE.pdf`](../BEGINNER-GUIDE.pdf). The chapters are in `0*.md`, in reading order.

To rebuild the PDF after editing (needs Python with `markdown`, `pygments` and `playwright`, plus a Chromium):

```bash
cd docs/beginner-guide
python3 build.py ../BEGINNER-GUIDE.pdf
```

`build.py` launches Chromium from `/opt/pw-browsers/chromium`; change `executable_path` there if yours is elsewhere.
