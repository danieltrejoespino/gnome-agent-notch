#!/usr/bin/env python3
"""Añade o quita el hook de agent-notch en la configuración de Claude Code.

    configure.py install     añade el hook (si ya estaba, lo deja al día)
    configure.py uninstall   lo quita
    configure.py status      dice si está (código 0 = sí, 1 = no)

Edita ~/.claude/settings.json ($CLAUDE_CONFIG_DIR/settings.json si está
definida). Solo toca las entradas de este hook: las demás (otros hooks,
permisos, ajustes…) quedan igual. La primera vez que lo cambia guarda una
copia del original en settings.json.agent-notch.bak (no se vuelve a pisar),
y escribe de forma atómica. Si al quitar el hook no queda nada (el archivo
lo creó install), borra settings.json y esa copia: no deja rastro.

--hook RUTA elige qué hook.py usar; por defecto, el que está junto a este
script. Así sirve tanto la copia instalada
(~/.local/share/agent-notch/adapters/) como un repo clonado.

El comando comprueba que hook.py existe antes de lanzarlo: si se borra (p. ej.
al desinstalar agent-notch sin quitar el hook), python3 saldría con 2 y
Claude Code lo tomaría como «bloquear», en cada herramienta y cada prompt.
"""

import argparse
import json
import os
import shlex
import shutil
import sys

# Los eventos que traduce hook.py (docs/04).
EVENTS = (
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse",
    "PostToolUse", "PostToolUseFailure", "Notification", "PermissionRequest",
    "Stop", "StopFailure",
)
TIMEOUT_S = 5
# Así se reconocen las entradas de agent-notch, apunten a donde apunten.
MARKER = "adapters/claude-code/hook.py"


def settings_path():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "settings.json")


def hook_command(hook):
    """[ -f hook ] || exit 0; exec python3 hook

    `exec`: el padre de hook.py es Claude Code (os.getppid() en hook.py).
    """
    q = shlex.quote(hook)
    return "[ -f %s ] || exit 0; exec /usr/bin/python3 %s" % (q, q)


def is_ours(group, hook=None):
    """¿Es un grupo de hooks de agent-notch (de `hook`, o de cualquiera)?"""
    hooks = group.get("hooks") if isinstance(group, dict) else None
    if not isinstance(hooks, list) or not hooks:
        return False
    for h in hooks:
        cmd = h.get("command") if isinstance(h, dict) else None
        if not isinstance(cmd, str) or MARKER not in cmd:
            return False
        if hook is not None and hook not in cmd:
            return False
    return True


def load(path):
    """Ajustes actuales ({} si no hay archivo). Sale con error si no son JSON."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except ValueError as e:
        sys.exit("agent-notch: %s is not valid JSON (%s); leaving it alone." % (path, e))
    if not isinstance(data, dict):
        sys.exit("agent-notch: %s does not contain a JSON object; leaving it alone." % path)
    return data


def backup_path(path):
    return path + ".agent-notch.bak"


def save(path, data):
    """Copia de seguridad y escritura atómica, con los permisos que tuviera.

    La copia se hace solo si no existe: así guarda el original de antes de
    agent-notch y no la versión de un cambio anterior (instalar y luego
    desinstalar la pisaba con la que llevaba el hook).
    """
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    mode = 0o600
    if os.path.exists(path):
        if not os.path.exists(backup_path(path)):
            shutil.copy2(path, backup_path(path))
        mode = os.stat(path).st_mode & 0o777
    tmp = os.path.join(folder, ".settings.json.agent-notch.%d.tmp" % os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def without_ours(data, hook=None):
    """Copia de data sin los grupos de agent-notch. Devuelve (data, cuántos)."""
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return data, 0
    removed = 0
    new_hooks = {}
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            new_hooks[event] = groups
            continue
        kept = [g for g in groups if not is_ours(g, hook)]
        removed += len(groups) - len(kept)
        if kept:
            new_hooks[event] = kept
    data = dict(data)
    if new_hooks:
        data["hooks"] = new_hooks
    else:
        data.pop("hooks", None)
    return data, removed


def with_ours(data, hook):
    """data con el hook en cada evento (quitando antes cualquier otro de agent-notch)."""
    data, _ = without_ours(data)
    hooks = data.get("hooks")
    if hooks is None:
        hooks = {}
    elif not isinstance(hooks, dict):
        sys.exit("agent-notch: \"hooks\" in settings.json is not an object; leaving it alone.")
    hooks = dict(hooks)
    entry = {"hooks": [{"type": "command", "command": hook_command(hook), "timeout": TIMEOUT_S}]}
    for event in EVENTS:
        groups = hooks.get(event)
        if groups is None:
            groups = []
        elif not isinstance(groups, list):
            sys.exit("agent-notch: hooks.%s in settings.json is not a list; leaving it alone." % event)
        hooks[event] = groups + [entry]
    data = dict(data)
    data["hooks"] = hooks
    return data


def is_installed(data, hook):
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return False
    cmd = hook_command(hook)
    for event in EVENTS:
        groups = hooks.get(event)
        if not isinstance(groups, list):
            return False
        if not any(is_ours(g) and g["hooks"][0].get("command") == cmd for g in groups):
            return False
    return True


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="agent-notch hook for Claude Code.")
    parser.add_argument("action", choices=("install", "uninstall", "status"))
    parser.add_argument("--hook", default=os.path.join(here, "hook.py"),
                        help="hook.py to use (by default, the one in this folder)")
    args = parser.parse_args(argv)
    hook = os.path.abspath(args.hook)
    path = settings_path()
    data = load(path)

    if args.action == "status":
        if is_installed(data, hook):
            print("agent-notch: the hook is set up in %s" % path)
            return 0
        print("agent-notch: the hook is not set up in %s" % path)
        return 1

    if args.action == "install":
        if not os.path.isfile(hook):
            sys.exit("agent-notch: %s does not exist" % hook)
        if is_installed(data, hook):
            print("agent-notch: the hook was already set up in %s" % path)
            return 0
        save(path, with_ours(data, hook))
        print("agent-notch: hook set up in %s" % path)
        print("agent-notch: Claude Code sessions already open pick it up on their own or when restarted.")
        return 0

    new, removed = without_ours(data, hook)
    if removed and not new:
        # Solo quedaba el hook: el archivo lo creó install. Sin rastro, ni
        # siquiera la copia si tampoco guarda nada del usuario.
        os.unlink(path)
        bak = backup_path(path)
        if os.path.exists(bak) and not without_ours(load(bak))[0]:
            os.unlink(bak)
        print("agent-notch: hook removed; %s only had the hook and was deleted" % path)
    elif removed:
        save(path, new)
        print("agent-notch: hook removed from %s" % path)
    else:
        print("agent-notch: the hook was not in %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
