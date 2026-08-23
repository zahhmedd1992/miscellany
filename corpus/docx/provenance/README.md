# provenance — the inputs behind the report's auditable claims

Not a deliverable. These are the URL manifests and the validation script that back
specific claims in `../../DOCX_CORPUS_REPORT.md`, kept so those claims stay re-runnable
rather than becoming assertions about a directory that no longer exists.

| File | Backs |
|---|---|
| `cands_a1.txt` | §2 "guessing filenames: 2 hits from 32" — the 32 guessed URLs |
| `cands_a2.txt`, `cands_a3.txt` | §2 "34 of 36 probed returned real PK-zip `.docx`" |
| `pages1.txt` | §2 "scraping landing pages: 2 hits from 15" — the 15 pages |
| `pool1.txt` … `pool4b.txt` | §4 the 107-file staging pool scanned for a drawing canvas |
| `word_validate.ps1` | §5 the Word COM validation table, and every `validatedBy` in `docx.json` |

The staging pool binaries themselves were transient and are not kept; re-download them
with the manifests above if the canvas scan needs repeating.
