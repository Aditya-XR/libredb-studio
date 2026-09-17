# arXiv submission sheet

Everything to paste into the submission form. Nothing here is guesswork; the abstract is
generated from `paper.tex` and is 1,864 characters against arXiv's 1,920 limit.

## Upload

File: `libredb-arxiv-submission.tar.gz` (54 KB)
Contents: `paper.tex` plus `anc/` (verifier, scorer, exporter, argument captures, 160 sweep logs).
Anything under `anc/` is published by arXiv as ancillary files beside the paper and is not compiled.

Submit the SOURCE, not a PDF. arXiv compiles it and typically rejects a PDF built from LaTeX.

## Title

What Stops a Small Language Model From Driving a Database Agent

## Authors

Cevheri Bozoglan, Yusuf Gundogdu, Abdullah Kaya, Koray Sirin

Enter them in the author field comma-separated, in this order. Use ASCII spellings in the metadata
field; the PDF carries the correct Turkish spellings. arXiv's author field is not LaTeX.

## Abstract

Paste the contents of `arxiv-abstract.txt`. It is plain ASCII with no TeX markup, because the
metadata field renders literally: a stray \% or 8{,}199 would appear as typed in the announcement.

## Categories

Primary:    cs.SE  (Software Engineering)
Cross-list: cs.DB  (Databases)

Hold cs.AI in reserve and add it after announcement if the paper finds an AI-side readership.
arXiv's guidance is that one or two cross-lists is normal and that bad cross-lists get removed.

Rationale for cs.SE as primary: the contribution is a defect class in a software artifact, found by
measurement and repaired, with the repairs and their effect reported. That is ACM D.2 territory. The
system under test being a database client is what makes cs.DB the right cross-list rather than the
primary.

## Optional metadata fields

| Field | Value |
|---|---|
| Report number | leave blank (institutional technical report numbers only) |
| Journal reference | leave blank (published work only; this is a preprint) |
| External DOI | leave blank |
| ACM class | `D.2.5; D.2.8; H.2` |
| MSC class | leave blank (Mathematics Subject Classification) |

Do NOT put the dataset DOI in External DOI. That field means "DOI to the journal version of this
article", so it would assert a publication that does not exist and would point indexers at a journal
version that is not there. The dataset DOI belongs in Comments, where it already is.

ACM class rationale: D.2.5 Testing and Debugging for the defect work, D.2.8 Metrics for the
measurement protocol and the scoring modes, H.2 Database Management for the system under test.

## Comments field

16 pages, 8 tables. Dataset, scorer and a verifier that regenerates every figure:
https://doi.org/10.57967/hf/10485

## Licence

Recommended: CC BY 4.0.

It is the least restrictive option that still requires attribution, it matches the paper's own
licence statement, and it lets the work be quoted and built on without anyone asking. The arXiv
default (arXiv's own non-exclusive licence) is more restrictive and blocks reuse that this work
would benefit from.

## Endorsement

First-time submitters need an endorsement before their first paper in a category. Start the
submission; arXiv emails a six-character code. The endorser enters it at arxiv.org/auth/endorse.

Finding one: on the abstract page of a related paper in the target category, follow "Which authors
of this paper are endorsers?". That link is authoritative. Eligibility is a window: the endorser
must have submitted in that area between three months and five years ago and hold an active
endorsement there, so a well-known but inactive author may not qualify, and someone whose only
papers are from the last few weeks does not qualify yet.

When asking, say plainly that endorsement is not peer review and that they are attesting to topical
fit only; that is the single thing that most reduces the burden of the ask. Include the title, the
abstract, and a link to anything already public that shows the work is real. Write to one person at
a time, a few days apart. Budget two to four weeks and do not announce a date against it.

For this paper the endorsement was granted on 2026-09-17.
