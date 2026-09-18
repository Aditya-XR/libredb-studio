#!/usr/bin/env python3
"""Regenerate every number in the paper from the released dataset and assert it matches.

Usage:  python3 verify.py runs.jsonl [sweep-logs-dir]
Exit 0 means every figure in the paper reproduces from the released data.

The second argument is optional. Given the sweep-log directory, this also rebuilds the intervention
table by joining each log's run identifiers against the corpus, which is the check that catches a
score copied from a log's `status=` field rather than from the run's verdict.
"""
import json, collections, io, statistics, sys

CLOCK = {"model-timeout", "turn-limit", "deadline-exceeded"}
ok = fail = 0

def check(label, got, want):
    global ok, fail
    good = got == want
    ok, fail = ok + good, fail + (not good)
    print(f"  [{'OK ' if good else 'FAIL'}] {label:<50} got={got!r:>12} want={want!r}")

def ntools(r): return sum((r.get("tools") or {}).values())

def classify(r, clock_first=True):
    no_tool, clock = ntools(r) == 0, r["stop_reason"] in CLOCK
    if clock_first:
        if clock: return "clock"
        if no_tool: return "capability"
    else:
        if no_tool: return "capability"
        if clock: return "clock"
    return "verification" if r["stop_reason"] == "report-composed" else "transport"

path = sys.argv[1] if len(sys.argv) > 1 else "runs.jsonl"
R = [json.loads(l) for l in io.open(path, encoding="utf-8")]
named = [r for r in R if r.get("model")]
L = [r for r in named if r["outcome"] == "unanswered"]
A = [r for r in R if r["outcome"] == "unanswered"]

print("\nCorpus")
check("runs", len(R), 8199)
check("named models", len({r["model"] for r in named}), 40)
check("model-attributed runs", len(named), 4951)
check("unattributed runs", len(R) - len(named), 3248)
check("answered", sum(r["outcome"] == "answered" for r in R), 4983)
check("unanswered", len(A), 3142)
check("no verdict", sum(not r["outcome"] for r in R), 74)
check("refused calls", sum(v for r in R for v in (r.get("refusals") or {}).values()), 14008)
rp = collections.Counter(r["model"] for r in named)
check("min runs per model", min(rp.values()), 3)
check("max runs per model", max(rp.values()), 629)
check("models with >=20 runs", sum(v >= 20 for v in rp.values()), 35)

print("\nPass rate by surface (model-attributed)")
for s, a, n in [("planning",466,560),("investigation",389,550),("operations",404,612),
                ("database-assessment",342,614),("query-optimization",639,1360),("data-analysis",468,1206)]:
    sub = [r for r in named if r.get("surface") == s]
    check(s, (sum(r["outcome"] == "answered" for r in sub), len(sub)), (a, n))

print("\nTaxonomy over ALL losses (secondary figure)")
check("model-attributed losses", len(L), 2194)
c_all = collections.Counter(classify(r) for r in L)
for k, v in [("transport",761),("clock",626),("verification",434),("capability",373)]:
    check(k, c_all[k], v)
check("agrees with released loss_class", sum(classify(r) == r.get("loss_class") for r in L), 2194)

print("\nPlanning is toolless, so it cannot enter transport")
PL = [r for r in R if r.get("mode") == "planning"]
check("planning runs", len(PL), 986)
check("planning runs invoking a tool", sum(ntools(r) > 0 for r in PL), 0)
plL = [r for r in PL if r["outcome"] == "unanswered"]
check("planning losses", len(plL), 182)
check("planning losses in transport", sum(classify(r) == "transport" for r in plL), 0)

AG = [r for r in named if r.get("mode") == "agent" and r["outcome"] == "unanswered"]
print("\nTaxonomy, agent mode only, clock-first (PRIMARY)")
check("agent-mode model-attributed losses", len(AG), 2100)
c = collections.Counter(classify(r) for r in AG)
for k, v in [("transport",761),("clock",542),("verification",434),("capability",363)]:
    check(k, c[k], v)
for k, v in [("transport",36.2),("clock",25.8),("verification",20.7),("capability",17.3)]:
    check(f"{k} share %", round(100*c[k]/len(AG), 1), v)

print("\nEngagement, the claim the abstract leads on")
eng = sum(ntools(r) > 0 for r in AG)
check("losses that invoked >=1 tool", eng, 1590)
check("engagement share %", round(100*eng/len(AG), 1), 75.7)
bym = collections.defaultdict(list)
for r in AG: bym[r["model"]].append(r)
check("models contributing agent-mode losses", len(bym), 33)
big = [m for m in bym if len(bym[m]) >= 20]
check("models with >=20 losses", len(big), 22)
check("of those, engagement majority holds in",
      sum(sum(ntools(r) > 0 for r in bym[m]) / len(bym[m]) > 0.5 for m in big), 15)
check("of those, transport is largest in",
      sum(collections.Counter(classify(r) for r in bym[m])["transport"]
          == max(collections.Counter(classify(r) for r in bym[m]).values()) for m in big), 10)

print("\nTaxonomy, agent mode only, capability-first (sensitivity)")
c2 = collections.Counter(classify(r, False) for r in AG)
for k, v in [("transport",761),("clock",395),("verification",434),("capability",510)]:
    check(k, c2[k], v)
check("capability share % under alternative", round(100*c2["capability"]/len(AG), 1), 24.3)
amb = [r for r in L if ntools(r) == 0 and r["stop_reason"] in CLOCK]
check("overlapping (clock AND no tool)", len(amb), 231)
check("of those, emitted no text", sum(r["stopped_saying_chars"] == 0 for r in amb), 225)

print("\nWhole corpus")
ca = collections.Counter(classify(r) for r in A)
for k, v in [("transport",33.3),("clock",26.5),("verification",20.6),("capability",19.7)]:
    check(f"{k} share %", round(100*ca[k]/len(A), 1), v)
# The paper withdrew the "two independent subsets agree" claim: the attributed losses are a
# SUBSET of all losses, so agreement between them is not evidence of stability. No check here.

print("\nTransport engagement")
tr = [r for r in L if classify(r) == "transport"]
check("median tools invoked", statistics.median(ntools(r) for r in tr), 2)
check("total tool invocations", sum(ntools(r) for r in tr), 1926)

print("\nRefusals")
ref = collections.Counter()
for r in R:
    for k, v in (r.get("refusals") or {}).items(): ref[k] += v
for k, v in [("compose_report:INVALID_TOOL_INPUT",6243),("compose_report:UNVERIFIABLE_EVIDENCE",3464),
             ("tool:database-error",1110),("present_answer:INVALID_TOOL_INPUT",1032),
             ("present_answer:ANSWER_NOT_A_DATA_READ",696),("recommend_change:INVALID_TOOL_INPUT",613),
             ("recommend_change:RECOMMENDATION_SHAPE_MISMATCH",248),("compare_plans:INVALID_TOOL_INPUT",152),
             ("compare_plans:UNVERIFIABLE_PLAN",139)]:
    check(k, ref[k], v)
cr = ref["compose_report:INVALID_TOOL_INPUT"] + ref["compose_report:UNVERIFIABLE_EVIDENCE"]
check("compose_report refusals", cr, 9707)
check("compose_report share %", round(100*cr/sum(ref.values()), 1), 69.3)

print("\nProcess-exit inflation claim")
ms = [r for r in R if r["stop_reason"] == "model-stopped"]
check("model-stopped runs", len(ms), 2204)
check("of those unanswered", sum(r["outcome"] == "unanswered" for r in ms), 1405)

if len(sys.argv) > 2:
    import glob, os, re
    print("\nIntervention table, rebuilt from the sweep logs by run-id join")
    by_id = {r["run_id"]: r for r in R}
    for model, prefix, want in [("granite4.2:3b","uz-granite4.2-3b",(28,30)),
                                ("mistral-nemo:12b","uz-mistral-nemo-12b",(26,30)),
                                ("llama3.1:8b","h2-llama3.1-8b",(24,30)),
                                ("cogito:8b","uz-cogito-8b",(21,30)),
                                ("glm4:latest","uz-glm4-latest",(16,30)),
                                ("deepseek-r1:8b","h2-deepseek-r1-8b",(24,28))]:
        ids = []
        for f in sorted(glob.glob(os.path.join(sys.argv[2], prefix + "-*.log"))):
            ids += re.findall(r"run=(\w+)", io.open(f, encoding="utf-8").read())
        got = (sum(by_id.get(i, {}).get("outcome") == "answered" for i in ids), len(ids))
        check(model, got, want)

print(f"\n{'='*70}\n  {ok} checks passed, {fail} failed\n{'='*70}")
sys.exit(1 if fail else 0)
