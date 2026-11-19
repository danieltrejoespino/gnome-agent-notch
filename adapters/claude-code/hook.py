#!/usr/bin/env python3
"""Adaptador de Claude Code para agent-notch (docs/04-adaptador-claude-code.md).

Claude Code lo lanza en cada evento con un JSON por stdin. Traduce el evento
al formato común (docs/03-formato-estado.md) y lo escribe en
sessions/claude-code-<sesion>.json.

Reglas de la Fase 1:
- Sale SIEMPRE con 0 (el 2 bloquearía a Claude Code) y no imprime nada en
  stdout (en algunos eventos se añadiría al contexto de Claude).
- Termina en menos de 100 ms: solo importa os, sys, json, time y re.

configure.py lo añade a settings.json con `exec python3 hook.py`: así el
padre de este proceso es Claude Code y os.getppid() sirve para que la isla
detecte sesiones muertas.
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

# Tipos de Notification que de verdad necesitan al usuario. idle_prompt y los
# demás no cambian el estado (docs/04).
ATTENTION_NOTIFICATIONS = ("permission_prompt", "elicitation_dialog", "agent_needs_input")


def clip(text, limit):
    """Una línea, sin espacios de sobra, recortada con «…»."""
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def describe(tool, inp):
    """Frase corta de lo que hace la herramienta, sin contenidos (docs/03)."""
    if not isinstance(inp, dict):
        inp = {}

    def name(p):
        return os.path.basename(str(p or "").rstrip("/")) or "archivo"

    if tool == "Read":
        return "Leyendo " + name(inp.get("file_path"))
    if tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return "Editando " + name(inp.get("file_path") or inp.get("notebook_path"))
    if tool == "Bash":
        return "Ejecutando " + clip(inp.get("command"), MAX_COMMAND)
    if tool in ("Grep", "Glob"):
        return 'Buscando "%s"' % clip(inp.get("pattern"), MAX_PATTERN)
    if tool in ("WebFetch", "WebSearch"):
        return "Consultando la web"
    if tool in ("Task", "Agent"):
        return "Delegando tarea"
    return "Usando " + clip(tool or "herramienta", 40)


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
        estado, accion, tool = "pensando", "Pensando…", None
    elif event == "PreToolUse":
        tool = ev.get("tool_name")
        estado, accion = "trabajando", describe(tool, ev.get("tool_input"))
    elif event in ("PostToolUse", "PostToolUseFailure"):
        estado, accion, tool = "pensando", "Pensando…", None
    elif event == "Notification":
        if ev.get("notification_type") not in ATTENTION_NOTIFICATIONS:
            return
        estado, accion = "atencion", clip(ev.get("message") or "Te necesita", MAX_ACTION)
    elif event == "PermissionRequest":
        tool = ev.get("tool_name")
        estado, accion = "atencion", "Pide permiso: " + clip(tool or "herramienta", 40)
    elif event == "Stop":
        estado, accion, tool = "terminado", "Listo", None
    elif event == "StopFailure":
        estado, tool = "error", None
        accion = clip(ev.get("last_assistant_message") or "Error", MAX_ACTION)
    else:
        return  # SubagentStop, PreCompact…: sin cambio

    now = time.time()
    cwd = str(ev.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or "")
    data = {
        "v": state.FORMAT_VERSION,
        "agente": AGENT,
        "sesion": state.safe_name(ev.get("session_id")),  # igual que en el nombre del archivo
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
        # Nunca molestar a Claude Code. Para depurar a mano:
        # AGENT_NOTCH_DEBUG=1 muestra el error en stderr.
        if os.environ.get("AGENT_NOTCH_DEBUG"):
            import traceback
            traceback.print_exc(file=sys.stderr)
    sys.exit(0)


if __name__ == "__main__":
    main()
