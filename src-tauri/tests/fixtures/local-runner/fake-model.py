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
  --spawn-child F   starts a long-running child and writes its pid to F
  --allocate N      takes N bytes of memory before greeting
  --read-all        reads every page (otherwise the first page only)
  --cut-first       reads only the start of the first page
  --last-page N     names page N as the last read, whatever was sent
  --head-tail       reads the first page and the last one, named as read after a gap
  --tail-page N     names page N as that last page, whatever was sent
  --quote-unread    adds a sentence quoting a page it did not read
  --read-fd         explains with the first bytes of descriptor 3
  --greet-after S   waits that long before greeting (for the lock-during-start test)
"""
import json
import sys
import time

args = sys.argv[1:]
slow = float(args[args.index("--slow") + 1]) if "--slow" in args else 0.0
if "--allocate" in args:
    try:
        held = bytearray(int(args[args.index("--allocate") + 1]))
    except MemoryError:
        sys.exit(3)
if "--spawn-child" in args:
    import subprocess

    child = subprocess.Popen(["sleep", "600"])
    with open(args[args.index("--spawn-child") + 1], "w") as pid_file:
        pid_file.write(str(child.pid))
if "--mute" in args:
    time.sleep(3600)
    sys.exit(0)
if "--greet-after" in args:
    time.sleep(float(args[args.index("--greet-after") + 1]))

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
        pages = request.get("pages", [])
        read = pages if "--read-all" in args else pages[:1]
        tail = None
        if "--head-tail" in args and len(pages) > 1:
            read, tail = pages[:1], pages[-1]["index"]
            if "--tail-page" in args:
                tail = int(args[args.index("--tail-page") + 1])
        text = "\n\n".join(page["text"] for page in read + [p for p in pages[1:] if p["index"] == tail])
        last = read[-1]["index"] if read else 0
        if "--last-page" in args:
            last = int(args[args.index("--last-page") + 1])
        sentences = [s.strip() for s in text.replace("\n", " ").split(". ") if s.strip()]
        answer = []
        for sentence in sentences[: request.get("maxSentences", 5)]:
            words = sentence.split()
            quote = " ".join(words[:3])
            if "--unlocated" in args:
                quote = "FAKE words the document never says"
            answer.append({"text": f"In short: {sentence.rstrip('.')}.", "quote": quote})
        if "--quote-unread" in args and len(pages) > 1:
            answer.append({"text": "In short: the clinic phoned.", "quote": pages[1]["text"][:20]})
        reply = {"id": request["id"], "sentences": answer, "lastPage": last,
                 "lastPageCut": "--cut-first" in args}
        if tail is not None:
            reply["tailPage"] = tail
        print(json.dumps(reply), flush=True)
    elif request.get("tool") == "explain":
        if "--read-fd" in args:
            import os
            text = os.read(3, 64).decode()
        else:
            text = f"FAKE: {request.get('term', '')} means something plain."
        print(json.dumps({"id": request["id"], "text": text}), flush=True)
    else:
        print(json.dumps({"id": request.get("id"), "error": "unknown tool"}), flush=True)
