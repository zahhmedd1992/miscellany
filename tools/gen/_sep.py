"""Every literal U+2028 in JS source becomes its escape.

U+2028 LINE SEPARATOR terminates a line in JavaScript source. It is legal in a
string literal since ES2019 and still illegal in a regex literal, and it makes
every reported line number after it wrong. The escape is the only safe
spelling, and this runs over the files that talk about soft breaks.
"""
import pathlib

SEP, PSEP = chr(0x2028), chr(0x2029)
FILES = [
    "src/core/text/layout.js", "src/core/text/render.js", "src/core/text/metrics.js",
    "src/core/ooxml/docx.js", "src/core/ooxml/docxedit.js",
    "src/apps/doc/doc.js", "src/apps/doc/app.js", "src/apps/doc/model.js",
    "src/doc.js", "src/compose.js",
]
total = 0
for f in FILES:
    p = pathlib.Path(f)
    if not p.exists():
        continue
    s = p.read_bytes().decode("utf-8")
    n = s.count(SEP) + s.count(PSEP)
    if n:
        p.write_bytes(s.replace(SEP, "\\u2028").replace(PSEP, "\\u2029").encode("utf-8"))
        print(f"  {f}: {n}")
    total += n
print(f"escaped {total} literal line separators")
