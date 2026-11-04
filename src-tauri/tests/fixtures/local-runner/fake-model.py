#!/usr/bin/env python3
"""A fake AI model for src-tauri/src/local_runner.rs's tests (#172).

Speaks the runner's line contract and nothing else: one hello line on
start, then one JSON answer line per JSON request line. It never reads a
file or opens a connection. Modes, by argument:
  (none)            answers at once
  --slow SECONDS    waits that long before each answer (for cancel tests)
  --mute            never greets (for the start timeout test)
  --unlocated       answers with a quote the document does not contain
  --long-line       answers with one line far over the runner's limit
  --refuse          answers every request with a long error text
"""
import json
import sys
import time

args = sys.argv[1:]
slow = float(args[args.index("--slow") + 1]) if "--slow" in args else 0.0
if "--mute" in args:
    time.sleep(3600)
    sys.exit(0)

print(json.dumps({"hello": "mycarlos-model/1",
                  "model": {"name": "FAKE model", "sha256": "0" * 64}}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if slow:
        time.sleep(slow)
    if "--long-line" in args:
        print(json.dumps({"id": request["id"], "text": "x" * (5 * 1024 * 1024)}), flush=True)
        continue
    if "--refuse" in args:
        print(json.dumps({"id": request["id"], "error": "FAKE refusal " + "y" * 1000}),
              flush=True)
        continue
    if request.get("tool") == "summary":
        text = request.get("text", "")
        sentences = [s.strip() for s in text.replace("\n", " ").split(". ") if s.strip()]
        answer = []
        for sentence in sentences[: request.get("maxSentences", 5)]:
            words = sentence.split()
            quote = " ".join(words[:3])
            if "--unlocated" in args:
                quote = "FAKE words the document never says"
            answer.append({"text": f"In short: {sentence.rstrip('.')}.", "quote": quote})
        print(json.dumps({"id": request["id"], "sentences": answer}), flush=True)
    elif request.get("tool") == "explain":
        print(json.dumps({"id": request["id"],
                          "text": f"FAKE: {request.get('term', '')} means something plain."}),
              flush=True)
    else:
        print(json.dumps({"id": request.get("id"), "error": "unknown tool"}), flush=True)
