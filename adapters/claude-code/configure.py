#!/usr/bin/env python3
"""Adds or removes the agent-notch hook in Claude Code's configuration.

    configure.py install     adds the hook (if it was already there, updates it)
    configure.py uninstall   removes it
    configure.py status      tells whether it is there (exit code 0 = yes, 1 = no)

Edits ~/.claude/settings.json ($CLAUDE_CONFIG_DIR/settings.json if it is
set). It only touches this hook's entries: the rest (other hooks,
permissions, settings…) stay the same. The first time it changes it, it saves a
copy of the original in settings.json.agent-notch.bak (never overwritten again),
and writes atomically. If nothing is left after removing the hook (the file
was created by install), it deletes settings.json and that copy: it leaves no trace.

--hook PATH picks which hook.py to use; by default, the one next to this
script. That way it works both for the installed copy
(~/.local/share/agent-notch/adapters/) and for a cloned repo.

The command checks that hook.py exists before running it: if it is deleted (e.g.
when uninstalling agent-notch without removing the hook), python3 would exit with 2 and
Claude Code would take it as "block", on every tool and every prompt.
"""

import argparse
import json
import os
import shlex
import shutil
import sys

# The events hook.py translates (docs/04).
EVENTS = (
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse",
    "PostToolUse", "PostToolUseFailure", "Notification", "PermissionRequest",
    "Stop", "StopFailure",
)
TIMEOUT_S = 5
# This is how agent-notch's entries are recognized, wherever they point.
MARKER = "adapters/claude-code/hook.py"


def settings_path():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "settings.json")


def hook_command(hook):
    """[ -f hook ] || exit 0; exec python3 hook

    `exec`: the parent of hook.py is Claude Code (os.getppid() in hook.py).
    """
    q = shlex.quote(hook)
    return "[ -f %s ] || exit 0; exec /usr/bin/python3 %s" % (q, q)


def is_ours(group, hook=None):
    """Is it a group of agent-notch hooks (of `hook`, or of any)?"""
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
    """Current settings ({} if there is no file). Exits with an error if they are not JSON."""
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
    """Backup copy and atomic write, keeping whatever permissions it had.

    The copy is only made if it does not exist: that way it keeps the original from before
    agent-notch and not the version of an earlier change (installing and then
    uninstalling overwrote it with the one that had the hook).
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
    """Copy of data without the agent-notch groups. Returns (data, how many)."""
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
    """data with the hook on each event (removing any other agent-notch one first)."""
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
        # Only the hook was left: the file was created by install. No trace, not
        # even the copy if it does not keep anything of the user's either.
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
