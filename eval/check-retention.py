"""Validate manually annotated retention evidence; aggregate labels, never invent grades.
Run from repo root. Private source/checkpoint files stay under eval/private.
"""
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path

root = Path("eval/private")
gold = json.loads((root / "work-state-gold.json").read_text())
grades = json.loads((root / "work-state-grades.json").read_text())

def message_text(message):
    content = message["content"]
    if isinstance(content, str):
        return content
    return "\n".join(part.get("text", json.dumps(part.get("arguments", {}), ensure_ascii=False)) for part in content)

def digest(path):
    return sha256(path.read_bytes()).hexdigest()

cases = {}
for case in gold["cases"]:
    source_path = root / case["sourceFile"]
    source = json.loads(source_path.read_text())
    assert 0 < case["endExclusive"] <= len(source["messages"])
    checks = {check["id"]: check for check in case["checks"]}
    assert len(checks) == len(case["checks"]), "Duplicate gold check IDs"
    for check in checks.values():
        assert check["evidence"], "Every expected fact needs source evidence"
        for ref in check["evidence"]:
            assert 0 <= ref["message"] < case["endExclusive"], "Future evidence leakage"
            assert ref["quote"] in message_text(source["messages"][ref["message"]]), (case["id"], check["id"], ref)
    cases[case["id"]] = {"checks": checks, "sourceSha256": source["sha256"], "normalizedSha256": digest(source_path)}

rows = []
for output in grades["outputs"]:
    path = root / output["file"]
    text = path.read_text()
    checks = cases[grades["case"]]["checks"]
    assert set(g["check"] for g in output["grades"]) == set(checks)
    assert len(output["grades"]) == len(checks)
    for grade in output["grades"]:
        assert grade["status"] in {"preserved", "contradicted", "unsupported", "omitted"}
        assert grade["quotes"]
        for quote in grade["quotes"]:
            assert quote in text, (output["variant"], grade["check"], quote)
    rows.append({"variant": output["variant"], "case": grades["case"], "checkpointSha256": digest(path),
                 "labels": {g["check"]: g["status"] for g in output["grades"]},
                 "counts": dict(Counter(g["status"] for g in output["grades"]))})

source = json.loads((root / "real-session-normalized.json").read_text())
prefix = "\n".join(message_text(m) for m in source["messages"][:151])
unsupported = ["671624a", "retry.model-not-loaded", "100% coverage", "All 14284 declarations", "vite v7.2.4"]
assert all(term not in prefix for term in unsupported), "Unsupported-evidence label needs re-review"
result = {"method": grades["method"],
          "goldCases": len(cases), "goldChecks": sum(len(c["checks"]) for c in cases.values()),
          "sourceHashes": {name: {k: v for k, v in case.items() if k != "checks"} for name, case in cases.items()},
          "rows": rows, "unscoredCases": ["review-final"],
          "limitations": ["Development set already examined while diagnosing failures; not blind holdout.",
                         "Two final candidates from one session, following three synthetic compaction rounds.",
                         "These archived candidates predate the duplicate-heading guard and are now rejected.",
                         "Review-session gold is prepared; no valid full review checkpoint was available.",
                         "No new model inference, training, or downstream coding execution in this audit."]}
Path("eval/results/work-state-retention.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
