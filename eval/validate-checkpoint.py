import json, sys

def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate key: " + key)
        result[key] = value
    return result

def validate(text, end):
    text = text.strip()
    # Accept only a single complete Markdown fence; no prose or guessed repairs.
    if text.startswith("```json\n") and text.endswith("\n```"):
        text = text[8:-4]
    state = json.loads(text, object_pairs_hook=unique)
    assert set(state) == {"goal", "priorities", "constraints", "work", "next_actions", "unknowns"}
    assert isinstance(state["goal"], str) and state["goal"].strip()
    for field in ["priorities", "constraints", "next_actions", "unknowns"]:
        assert isinstance(state[field], list)
        assert all(isinstance(v, str) and v.strip() for v in state[field])
    assert isinstance(state["work"], list)
    for item in state["work"]:
        assert set(item) == {"item", "status", "source_ids"}
        assert isinstance(item["item"], str) and item["item"].strip()
        assert item["status"] in {"planned", "applied", "verified", "unverified", "cancelled", "unknown"}
        assert isinstance(item["source_ids"], list) and item["source_ids"]
        assert all(type(i) is int and 0 <= i < end for i in item["source_ids"])
    return state

if __name__ == "__main__":
    print(json.dumps(validate(sys.stdin.read(), int(sys.argv[1])), ensure_ascii=False))
