"""Normalize one named exported OpenCode JSON member without executing its tools."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument("archive")
parser.add_argument("member")
parser.add_argument("output")
args = parser.parse_args()
with tarfile.open(args.archive) as archive:
    source = archive.extractfile(args.member)
    if source is None:
        raise ValueError("Selected member is not a file")
    raw = source.read()
data = json.loads(raw)
messages = []
for message in data["messages"]:
    timestamp = message.get("time", {}).get("created", 0)
    if message["type"] == "user":
        messages.append({"role": "user", "content": message.get("text", ""), "timestamp": timestamp})
        continue
    if message["type"] != "assistant":
        continue
    content, results = [], []
    for part in message.get("content", []):
        if part["type"] == "text":
            content.append({"type": "text", "text": part["text"]})
        elif part["type"] == "tool":
            state = part.get("state", {})
            content.append({"type": "toolCall", "id": part["id"], "name": part["name"], "arguments": state.get("input", {})})
            results.append({"role": "toolResult", "toolCallId": part["id"], "toolName": part["name"],
                            "content": state.get("content", []), "isError": state.get("status") == "error", "timestamp": timestamp})
    messages.append({"role": "assistant", "content": content, "timestamp": timestamp})
    messages.extend(results)
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({"source": args.member, "sha256": hashlib.sha256(raw).hexdigest(), "messages": messages}, ensure_ascii=False))
