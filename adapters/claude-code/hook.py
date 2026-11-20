#!/usr/bin/env python3
"""Claude Code adapter for agent-notch (docs/04-adaptador-claude-code.md).

Claude Code runs it on every event with a JSON on stdin. It translates the event
into the common format (docs/03-formato-estado.md) and writes it to
sessions/claude-code-<sesion>.json.

Phase 1 rules:
- It ALWAYS exits with 0 (2 would block Claude Code) and prints nothing on
  stdout (on some events it would be added to Claude's context).
- It finishes in under 100 ms: it only imports os, sys, json, time and re.

configure.py adds it to settings.json with `exec python3 hook.py`: that way the
parent of this process is Claude Code and os.getppid() lets the island
detect dead sessions.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "common"))
import state  # noqa: E402

AGENT = "claude-code"
MAX_ACTION = 60
MAX_COMMAND = 40
MAX_PATTERN = 30

# Notification types that really need the user. idle_prompt and the
# others do not change the state (docs/04).
ATTENTION_NOTIFICATIONS = ("permission_prompt", "elicitation_dialog", "agent_needs_input")


def clip(text, limit):
    """One line, without extra spaces, cut with "…"."""
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def describe(tool, inp):
    """Short phrase of what the tool does, without contents (docs/03)."""
    if not isinstance(inp, dict):
        inp = {}

    def name(p):
        return os.path.basename(str(p or "").rstrip("/")) or "file"

    if tool == "Read":
        return "Reading " + name(inp.get("file_path"))
    if tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return "Editing " + name(inp.get("file_path") or inp.get("notebook_path"))
    if tool == "Bash":
        return "Running " + clip(inp.get("command"), MAX_COMMAND)
    if tool in ("Grep", "Glob"):
        return 'Searching "%s"' % clip(inp.get("pattern"), MAX_PATTERN)
    if tool in ("WebFetch", "WebSearch"):
        return "Browsing the web"
    if tool in ("Task", "Agent"):
        return "Delegating a task"
    return "Using " + clip(tool or "tool", 40)


def handle(ev):
    if not isinstance(ev, dict):
        return
    event = ev.get("hook_event_name")
    path = state.session_path(AGENT, ev.get("session_id"))

    if event == "SessionEnd":
        state.remove(path)
        return

    prev = state.read_json(path)
    estado = prev.get("estado", "inactivo")
    accion = prev.get("accion")
    tool = prev.get("herramienta")

    if event == "SessionStart":
        estado, accion, tool = "inactivo", None, None
    elif event == "UserPromptSubmit":
        estado, accion, tool = "pensando", "Thinking…", None
    elif event == "PreToolUse":
        tool = ev.get("tool_name")
        estado, accion = "trabajando", describe(tool, ev.get("tool_input"))
    elif event in ("PostToolUse", "PostToolUseFailure"):
        estado, accion, tool = "pensando", "Thinking…", None
    elif event == "Notification":
        if ev.get("notification_type") not in ATTENTION_NOTIFICATIONS:
            return
        estado, accion = "atencion", clip(ev.get("message") or "Needs you", MAX_ACTION)
    elif event == "PermissionRequest":
        tool = ev.get("tool_name")
        estado, accion = "atencion", "Asks permission: " + clip(tool or "tool", 40)
    elif event == "Stop":
        estado, accion, tool = "terminado", "Done", None
    elif event == "StopFailure":
        estado, tool = "error", None
        accion = clip(ev.get("last_assistant_message") or "Error", MAX_ACTION)
    else:
        return  # SubagentStop, PreCompact…: no change

    now = time.time()
    cwd = str(ev.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or "")
    data = {
        "v": state.FORMAT_VERSION,
        "agente": AGENT,
        "sesion": state.safe_name(ev.get("session_id")),  # same as in the file name
        "proyecto": os.path.basename(cwd.rstrip("/")) or "?",
        "cwd": cwd,
        "estado": estado,
        "accion": accion,
        "herramienta": tool,
        "inicio": prev.get("inicio", now),
        "actualizado": now,
        "pid": os.getppid(),
    }
    state.write_json(path, data)


def main():
    try:
        handle(json.loads(sys.stdin.read()))
    except Exception:
        # Never bother Claude Code. To debug by hand:
        # AGENT_NOTCH_DEBUG=1 shows the error on stderr.
        if os.environ.get("AGENT_NOTCH_DEBUG"):
            import traceback
            traceback.print_exc(file=sys.stderr)
    sys.exit(0)


if __name__ == "__main__":
    main()
