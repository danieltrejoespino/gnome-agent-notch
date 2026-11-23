#!/usr/bin/env python3
"""Adds or removes the agent-notch hook in the Antigravity CLI (`agy`).

    configure.py install     adds the hook (if it was already there, updates it)
    configure.py uninstall   removes it
    configure.py status      tells whether it is there (exit code 0 = yes, 1 = no)

Edits ~/.gemini/config/hooks.json, the global hooks file that `agy` and its
/hooks command share (checked against agy 1.5.14 on 22-11-2026). Each top-level
key of that file is a named hook; agent-notch only touches its own,
"agent-notch": other hooks stay the same. The first time it changes the file it
saves a copy of the original in hooks.json.agent-notch.bak (never overwritten
again), and writes atomically. If nothing is left after removing the hook (the
file was created by install), it deletes hooks.json and that copy.

--hook PATH picks which hook.py to use; by default, the one next to this
script. That way it works both for the installed copy
(~/.local/share/agent-notch/adapters/) and for a cloned repo.

The command checks that hook.py exists before running it, and prints nothing
if it does not: Antigravity takes the hook's stdout as its answer, and an empty
one means "no opinion".
"""

import argparse
import json
import os
import shlex
import shutil
import sys

NAME = "agent-notch"
# Events hook.py translates (docs/08). PostInvocation is left out: it adds
# nothing and every hook makes agy wait.
FLAT_EVENTS = ("SessionStart", "PreInvocation", "Stop")
TOOL_EVENTS = ("PreToolUse", "PostToolUse")
TIMEOUT_S = 5
MARKER = "adapters/antigravity/hook.py"


def hooks_path():
    return os.path.join(os.path.expanduser("~"), ".gemini", "config", "hooks.json")


def hook_command(hook):
    """[ -f hook ] || exit 0; exec python3 hook

    `exec`: the parent of hook.py is agy (os.getppid() in hook.py).
    """
    q = shlex.quote(hook)
    return "[ -f %s ] || exit 0; exec /usr/bin/python3 %s" % (q, q)


def spec(hook):
    """agent-notch's entry in hooks.json."""
    handler = {"type": "command", "command": hook_command(hook), "timeout": TIMEOUT_S}
    entry = {}
    for event in FLAT_EVENTS:
        entry[event] = [dict(handler)]
    for event in TOOL_EVENTS:
        entry[event] = [{"matcher": "*", "hooks": [dict(handler)]}]
    return entry


def is_ours(entry):
    """Is it an agent-notch entry (pointing to any copy)?"""
    return isinstance(entry, dict) and MARKER in json.dumps(entry)


def load(path):
    """Current hooks ({} if there is no file). Exits with an error if they are not JSON."""
    try:
        # utf-8-sig: agy accepts files saved with a BOM, so should we.
        with open(path, encoding="utf-8-sig") as f:
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
    """Backup copy (only the first time) and atomic write, keeping the permissions."""
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    mode = 0o600
    if os.path.exists(path):
        if not os.path.exists(backup_path(path)):
            shutil.copy2(path, backup_path(path))
        mode = os.stat(path).st_mode & 0o777
    tmp = os.path.join(folder, ".hooks.json.agent-notch.%d.tmp" % os.getpid())
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


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="agent-notch hook for the Antigravity CLI.")
    parser.add_argument("action", choices=("install", "uninstall", "status"))
    parser.add_argument("--hook", default=os.path.join(here, "hook.py"),
                        help="hook.py to use (by default, the one in this folder)")
    args = parser.parse_args(argv)
    hook = os.path.abspath(args.hook)
    path = hooks_path()
    data = load(path)
    current = data.get(NAME)

    if args.action == "status":
        if current == spec(hook):
            print("agent-notch: the hook is set up in %s" % path)
            return 0
        print("agent-notch: the hook is not set up in %s" % path)
        return 1

    if args.action == "install":
        if not os.path.isfile(hook):
            sys.exit("agent-notch: %s does not exist" % hook)
        if current is not None and not is_ours(current):
            sys.exit("agent-notch: %s has a hook named \"%s\" that is not ours; leaving it alone."
                     % (path, NAME))
        if current == spec(hook):
            print("agent-notch: the hook was already set up in %s" % path)
            return 0
        new = dict(data)
        new[NAME] = spec(hook)
        save(path, new)
        print("agent-notch: hook set up in %s" % path)
        print("agent-notch: Antigravity sessions pick it up when they start.")
        return 0

    if not is_ours(current):
        print("agent-notch: the hook was not in %s" % path)
    elif hook_command(hook) not in json.dumps(current):
        # It points to another copy (e.g. a cloned repo): leave it, like the
        # OpenCode plugin.
        print("agent-notch: the hook points to another copy; leaving it (%s)" % path)
    else:
        new = {k: v for k, v in data.items() if k != NAME}
        if new:
            save(path, new)
            print("agent-notch: hook removed from %s" % path)
        else:
            # Only the hook was left: the file was created by install.
            os.unlink(path)
            bak = backup_path(path)
            if os.path.exists(bak) and not {k: v for k, v in load(bak).items() if k != NAME}:
                os.unlink(bak)
            print("agent-notch: hook removed; %s only had the hook and was deleted" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
