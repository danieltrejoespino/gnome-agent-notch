#!/usr/bin/env python3
"""Antigravity CLI (`agy`) adapter for agent-notch (docs/08-otros-agentes.md).

Antigravity runs it on every lifecycle hook with a JSON on stdin (camelCase
keys: conversationId, hookEventName, cwd, toolCall…). It translates the event
into the common format (docs/03-formato-estado.md) and writes it to
sessions/antigravity-<conversationId>.json.

Rules:
- It ALWAYS exits with 0 and prints NOTHING on stdout. Antigravity reads the
  hook's stdout as its answer: on PreToolUse an empty object `{}` DENIES the
  tool, while an empty stdout means "no opinion" (checked against agy 1.5.14
  on 22-11-2026). This hook must never decide anything.
- It finishes in under 100 ms: Antigravity waits for hooks before going on.
  It only imports os, sys, json and time.

configure.py adds it to ~/.gemini/config/hooks.json with `exec python3 hook.py`:
that way the parent of this process is `agy` and os.getppid() lets the island
detect dead sessions (Antigravity has no SessionEnd hook).
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "common"))
import state  # noqa: E402

AGENT = "antigravity"
MAX_ACTION = 60
MAX_COMMAND = 40
MAX_PATTERN = 30

# Stop reasons that are a normal end of the turn. The rest (ERROR,
# MAX_INVOCATIONS, MAX_TOKEN_BUDGET_EXCEEDED…) show as an error.
DONE_REASONS = ("NO_TOOL_CALL", "TERMINAL_STEP_TYPE", "INJECTED_RESPONSE", "TERMINAL_CUSTOM_HOOK", "")
LIMIT_TEXT = {
    "MAX_INVOCATIONS": "Stopped: step limit",
    "MAX_FORCED_INVOCATIONS": "Stopped: step limit",
    "MAX_TOKEN_BUDGET_EXCEEDED": "Stopped: token budget",
}

# Arguments that hold a file path, in the order they are tried.
PATH_ARGS = ("TargetFile", "AbsolutePath", "FilePath", "Path", "File", "SearchPath")


def clip(text, limit):
    """One line, without extra spaces, cut with "…"."""
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def describe(tool, args):
    """Short phrase of what the tool does, without contents (docs/03).

    Antigravity's tool names: read_file and run_command seen on 22-11-2026;
    the rest come from the agy 1.5.14 binary (⚠️ Verificar as they show up).
    """
    if not isinstance(args, dict):
        args = {}
    tool = str(tool or "")

    def name():
        for key in PATH_ARGS:
            if args.get(key):
                return os.path.basename(str(args[key]).rstrip("/")) or "file"
        return "file"

    if tool in ("run_command", "send_command_input"):
        return "Running " + clip(args.get("CommandLine") or args.get("Input"), MAX_COMMAND)
    if tool in ("command_status", "read_terminal"):
        return "Checking a command"
    if tool in ("read_file", "view_file", "view_code_item"):
        return "Reading " + name()
    if tool in ("write_to_file", "write_file", "create_file", "delete_file", "rename_file") \
            or "replace" in tool or "edit" in tool:
        return "Editing " + name()
    if tool == "list_dir":
        return "Listing " + name()
    if tool in ("grep_search", "find_by_name", "codebase_search") or (
            tool.endswith("_search") and tool != "search_web"):
        return 'Searching "%s"' % clip(args.get("Query") or args.get("Pattern"), MAX_PATTERN)
    if tool in ("search_web", "read_url_content") or tool.startswith("browser"):
        return "Browsing the web"
    if "subagent" in tool or tool == "task_boundary":
        return "Delegating a task"
    if tool == "generate_image":
        return "Generating an image"
    return "Using " + clip(tool or "tool", 40)


def forget_older(path, pid):
    """Removes this agy's other sessions: /new or /clear start a conversation
    in the same process, and without SessionEnd the old one would stay until
    agy exits. Only done on SessionStart, so it costs nothing the rest of the time."""
    folder = os.path.dirname(path)
    try:
        names = os.listdir(folder)
    except OSError:
        return
    for name in names:
        other = os.path.join(folder, name)
        if name.startswith(AGENT + "-") and name.endswith(".json") and other != path:
            if state.read_json(other).get("pid") == pid:
                state.remove(other)


def handle(ev):
    if not isinstance(ev, dict):
        return
    event = ev.get("hookEventName")
    path = state.session_path(AGENT, ev.get("conversationId"))
    pid = os.getppid()

    prev = state.read_json(path)
    estado = prev.get("estado", "inactivo")
    accion = prev.get("accion")
    tool = prev.get("herramienta")

    if event == "SessionStart":
        forget_older(path, pid)
        estado, accion, tool = "inactivo", None, None
    elif event == "PreInvocation":
        estado, accion, tool = "pensando", "Thinking…", None
    elif event == "PreToolUse":
        call = ev.get("toolCall") if isinstance(ev.get("toolCall"), dict) else {}
        tool = call.get("name")
        if tool == "ask_question":
            estado, accion = "atencion", "Asks you a question"
        else:
            estado, accion = "trabajando", describe(tool, call.get("args"))
    elif event == "PostToolUse":
        estado, accion, tool = "pensando", "Thinking…", None
    elif event == "Stop":
        reason = str(ev.get("terminationReason") or "")
        tool = None
        if reason in DONE_REASONS:
            estado, accion = "terminado", "Done"
        elif reason == "USER_CANCELED":
            estado, accion = "terminado", "Canceled"
        else:
            estado = "error"
            accion = clip(ev.get("error") or LIMIT_TEXT.get(reason) or "Error", MAX_ACTION)
    else:
        return  # PostInvocation: the next PreInvocation or Stop says more

    now = time.time()
    cwd = ev.get("cwd")
    if not cwd:
        paths = ev.get("workspacePaths")
        cwd = paths[0] if isinstance(paths, list) and paths else ""
    cwd = str(cwd or "")
    data = {
        "v": state.FORMAT_VERSION,
        "agente": AGENT,
        "sesion": state.safe_name(ev.get("conversationId")),  # same as in the file name
        "proyecto": os.path.basename(cwd.rstrip("/")) or "?",
        "cwd": cwd,
        "estado": estado,
        "accion": accion,
        "herramienta": tool,
        "inicio": prev.get("inicio", now),
        "actualizado": now,
        "pid": pid,
    }
    state.write_json(path, data)


def main():
    try:
        handle(json.loads(sys.stdin.read()))
    except Exception:
        # Never bother Antigravity. To debug by hand:
        # AGENT_NOTCH_DEBUG=1 shows the error on stderr (never on stdout).
        if os.environ.get("AGENT_NOTCH_DEBUG"):
            import traceback
            traceback.print_exc(file=sys.stderr)
    sys.exit(0)


if __name__ == "__main__":
    main()
