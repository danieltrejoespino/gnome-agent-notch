"""agent-notch file bus: shared by all the adapters.

Format and location in docs/03-formato-estado.md; architecture in
docs/02-arquitectura.md.

    $XDG_RUNTIME_DIR/agent-notch/
    ├── sessions/<agente>-<sesion>.json   state of each session (Phase 1)
    ├── requests/<id>.json                permission requests (Phase 2)
    └── responses/<id>.json               the island's answers (Phase 2)

Without $XDG_RUNTIME_DIR, ~/.cache/agent-notch/ is used. Folders are created
with 0700 permissions and files with 0600.

The hooks run on every agent event and must finish in under
100 ms: this module only imports os, json and re (no pathlib).
"""

import json
import os
import re

FORMAT_VERSION = 1

# Sorted from highest to lowest priority for the compact pill (docs/03).
STATES = ("atencion", "error", "trabajando", "pensando", "terminado", "inactivo")

_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")
_MAX_NAME = 80


def base_dir():
    """Root of the bus. It does not create it.

    AGENT_NOTCH_DIR changes it: the test GNOME (scripts/dev-shell.sh) and
    scripts/simulate.py use $XDG_RUNTIME_DIR/agent-notch-dev, so the
    test sessions do not show up on the real desktop's island.
    """
    override = os.environ.get("AGENT_NOTCH_DIR")
    if override:
        return override
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime and os.path.isdir(runtime):
        return os.path.join(runtime, "agent-notch")
    cache = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(cache, "agent-notch")


def ensure_dir(sub):
    """Creates <base>/<sub> (and <base>) with 0700 permissions and returns the path."""
    root = base_dir()
    path = os.path.join(root, sub)
    # The parent (~/.cache for a new user) may not exist: with its
    # normal permissions, which are not our business.
    os.makedirs(os.path.dirname(root), exist_ok=True)
    for d in (root, path):
        try:
            os.mkdir(d, 0o700)
        except FileExistsError:
            pass
        else:
            os.chmod(d, 0o700)  # mkdir applies the umask; chmod does not
    return path


def safe_name(text):
    """Keeps only [A-Za-z0-9_-] to use it in a file name."""
    cleaned = _UNSAFE.sub("_", str(text or ""))[:_MAX_NAME]
    return cleaned or "desconocida"


def session_path(agent, session_id):
    """Path of sessions/<agente>-<sesion>.json, creating the folder."""
    name = "%s-%s.json" % (safe_name(agent), safe_name(session_id))
    return os.path.join(ensure_dir("sessions"), name)


def read_json(path):
    """The JSON object at path, or {} if it does not exist, is broken or is not an object."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_json(path, data):
    """Writes data to path atomically.

    First to a hidden temporary file in the same folder (.<name>.<pid>.tmp,
    unique per process so two hooks at once do not step on each other) and then
    os.replace: readers see the old file or the new one, never a
    half-written one. The extension ignores names starting with a dot.
    """
    folder, name = os.path.split(path)
    tmp = os.path.join(folder, ".%s.%d.tmp" % (name, os.getpid()))
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def remove(path):
    """Removes path; nothing happens if it no longer exists."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
