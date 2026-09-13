# Validate manually authored evidence bookkeeping, not semantic truth.
from pathlib import Path
import hashlib, json

def strings(v):
 if isinstance(v,str):return [v]
 if isinstance(v,list):return [s for x in v for s in strings(x)]
 if isinstance(v,dict):return [s for x in v.values() for s in strings(x)]
 return []
rows=json.loads(Path("eval/private/continuation-findings.json").read_text())
for row in rows:
 raw=Path(row["artifact"]).read_text()
 output="\n".join(strings(json.loads(raw))) if row["artifact"].endswith(".json") else raw
 assert row["outputQuote"] in output, row["finding"]
 fixture=json.loads(Path("eval/private/"+("real" if row["case"]=="cron" else "review")+"-session-normalized.json").read_text())
 for source in row["sources"]:
  assert source["message"] < row["cutoff"]
  message=fixture["messages"][source["message"]]
  assert message["role"]==source["role"]
  assert source["quote"] in "\n".join(strings(message["content"])),source
 row["artifactSha256"]=hashlib.sha256(raw.encode()).hexdigest()
 row["sourceMessageIds"]=[s["message"] for s in row.pop("sources")]
Path("eval/results/continuation-findings.json").write_text(json.dumps({"method":"Manual source-based assessments; exact output/source excerpts and roles checked offline. Not automatic semantic grading or a held-out accuracy score.","findings":rows},indent=2)+"\n")
print(f"Validated {len(rows)} source-linked findings")
