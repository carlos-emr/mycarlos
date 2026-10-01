"""Real GTK dialog probe. Run in a PRIVATE dbus/Xvfb session with openbox.
Usage: linux.py /absolute/installed-app /absolute/WebKitWebDriver /new/evidence-dir
Requires python3-gi, gir1.2-atspi-2.0, at-spi2-core, xdotool, openbox.
"""
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

app, driver, destination = map(Path, sys.argv[1:])
assert app.is_absolute() and driver.is_absolute() and destination.is_absolute()
destination.mkdir(parents=True, exist_ok=False)
env = os.environ.copy()
for name in ("XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"):
    folder = destination / name
    folder.mkdir()
    env[name] = str(folder)
env.update(TAURI_WEBVIEW_AUTOMATION="true", WEBKIT_DISABLE_DMABUF_RENDERER="1", NO_AT_BRIDGE="0")
vault = Path(env["XDG_DATA_HOME"]) / "ca.carlos.mycarlos/vault-home/vault-v1"
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
log = (destination / "driver.log").open("w")
proc = subprocess.Popen([str(driver), f"--port={port}", "--host=local"], env=env, stdout=log, stderr=log, start_new_session=True)
sid = None
state = {}

def call(method, path, data=None, timeout=20):
    request = urllib.request.Request(f"http://127.0.0.1:{port}" + path, data=None if data is None else json.dumps(data).encode(), method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        value = json.load(response)["value"]
    if isinstance(value, dict) and value.get("error") and "message" in value:
        raise RuntimeError(value)
    return value

def execute(script, *args):
    return call("POST", f"/session/{sid}/execute/sync", {"script": script, "args": list(args)})

def xd(*args):
    return subprocess.check_output(["xdotool", *map(str, args)], text=True, timeout=5).strip()

def descendants(node, depth=0):
    if depth > 20:
        return
    yield node
    for i in range(node.get_child_count()):
        child = node.get_child_at_index(i)
        if child:
            yield from descendants(child, depth + 1)

def native(request):
    title = request["title"]
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        desktop = Atspi.get_desktop(0)
        for application in [desktop.get_child_at_index(i) for i in range(desktop.get_child_count())]:
            if application.get_process_id() != app_pid:
                continue
            for node in descendants(application):
                if node.get_role_name() not in ("dialog", "file chooser", "alert"):
                    continue
                if any(child.get_name() == title for child in descendants(node)) or (title.startswith("FILE_") and node.get_role_name() == "file chooser"):
                    dialog = node
                    break
            else:
                continue
            break
        else:
            time.sleep(.1)
            continue
        break
    else:
        dump = []
        for node in descendants(Atspi.get_desktop(0)):
            dump.append({"pid": node.get_process_id(), "role": node.get_role_name(), "name": node.get_name()})
        (destination / "accessibility-tree.json").write_text(json.dumps(dump, indent=2))
        raise RuntimeError(f"Native dialog not found: {title}")
    nodes = list(descendants(dialog))
    evidence = {"title": dialog.get_name(), "action": request["action"], "buttons": [n.get_name() for n in nodes if n.get_role_name() == "push button"], "focus": [n.get_name() for n in nodes if n.get_state_set().contains(Atspi.StateType.FOCUSED)]}
    # X11 window and AT-SPI dialog must both belong to our launched process.
    candidates = xd("search", "--all", "--onlyvisible", "--pid", app_pid, "--name", "^" + re.escape(dialog.get_name() if title.startswith("FILE_") else title) + "$").splitlines()
    assert len(candidates) == 1, candidates
    window = candidates[0]
    xd("windowactivate", "--sync", window)
    assert xd("getactivewindow") == window
    assert int(xd("getwindowpid", window)) == app_pid
    evidence["focus"] = [n.get_name() for n in nodes if n.get_state_set().contains(Atspi.StateType.FOCUSED)]
    action = request["action"]
    if action in ("enter", "space", "escape"):
        xd("key", {"enter": "Return", "space": "space", "escape": "Escape"}[action])
    elif action == "close":
        # Ask the window manager for its normal close action (WM_DELETE_WINDOW).
        xd("key", "alt+F4")
    elif action == "button":
        buttons = [n for n in nodes if n.get_role_name() == "push button" and n.get_name() == request["value"]]
        assert len(buttons) == 1, evidence
        assert buttons[0].get_action_iface().do_action(0)
    elif action == "file":
        xd("key", "ctrl+l")
        xd("key", "ctrl+a")
        xd("type", "--clearmodifiers", request["value"])
        xd("key", "Return")
        time.sleep(.4)
        # GTK may populate the filename before requiring explicit activation.
        if dialog.get_state_set().contains(Atspi.StateType.SHOWING):
            for n in nodes:
                if n.get_role_name() == "push button" and n.get_name() == ("Save" if title == "FILE_SAVE" else "Open"):
                    n.get_action_iface().do_action(0)
                    break
    else:
        raise RuntimeError(action)
    return evidence

try:
    for _ in range(100):
        try:
            call("GET", "/status")
            break
        except Exception:
            time.sleep(.1)
    session = call("POST", "/session", {"capabilities": {"alwaysMatch": {"webkitgtk:browserOptions": {"binary": str(app), "args": []}}}}, timeout=45)
    sid = session["sessionId"]
    for _ in range(100):
        if execute('return !!window.__TAURI_INTERNALS__ && document.body.innerText.includes("Create");'):
            break
        time.sleep(.1)
    # Main window PID is also checked against its executable before any keypress.
    main_window = xd("search", "--onlyvisible", "--name", "^myCarlos").splitlines()
    assert len(main_window) == 1, main_window
    app_pid = int(xd("getwindowpid", main_window[0]))
    assert Path(f"/proc/{app_pid}/exe").resolve() == app.resolve()
    source = Path(__file__).with_name("scenarios.mjs").read_text().replace("export async function", "async function", 1)
    execute(source + "\nrunDialogScenarios({backupPath: arguments[0]});", str(destination / "synthetic.mycarlosbackup"))
    last = None
    deadline = time.monotonic() + 420
    while time.monotonic() < deadline:
        state = execute("return window.__nativeDialogTest;")
        (destination / "results.json").write_text(json.dumps(state, indent=2) + "\n")
        if state["done"]:
            assert not state.get("error"), state.get("error")
            print("PASS", len(state["results"]), "native operations", flush=True)
            break
        request = state.get("request")
        if request and request["id"] != last:
            last = request["id"]
            try:
                if request["action"] == "fingerprint":
                    assert vault.is_dir(), f"Vault not found: {vault}"
                    value = [[str(p.relative_to(vault)), hashlib.sha256(p.read_bytes()).hexdigest()] for p in sorted(vault.rglob("*")) if p.is_file()]
                    assert value, "Empty vault fingerprint"
                else:
                    value = native(request)
                    print(json.dumps(value), flush=True)
                reply = {"id": last, "value": value}
            except Exception as error:
                reply = {"id": last, "error": str(error)}
            execute("window.__nativeDialogTest.reply = arguments[0];", reply)
        time.sleep(.1)
    else:
        raise RuntimeError("Overall native test timeout")
finally:
    if sid:
        try:
            screenshot = call("GET", f"/session/{sid}/screenshot")
            (destination / "webview.png").write_bytes(base64.b64decode(screenshot))
        except Exception:
            pass
        try:
            call("DELETE", f"/session/{sid}", timeout=5)
        except Exception:
            pass
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
    log.close()
