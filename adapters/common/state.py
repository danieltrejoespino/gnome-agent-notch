"""Bus de archivos de agent-notch: lo comparten todos los adaptadores.

Formato y ubicación en docs/03-formato-estado.md; arquitectura en
docs/02-arquitectura.md.

    $XDG_RUNTIME_DIR/agent-notch/
    ├── sessions/<agente>-<sesion>.json   estado de cada sesión (Fase 1)
    ├── requests/<id>.json                peticiones de permiso (Fase 2)
    └── responses/<id>.json               respuestas de la isla (Fase 2)

Sin $XDG_RUNTIME_DIR se usa ~/.cache/agent-notch/. Las carpetas se crean
con permisos 0700 y los archivos con 0600.

Los hooks se lanzan en cada evento del agente y deben terminar en menos de
100 ms: este módulo solo importa os, json y re (nada de pathlib).
"""

import json
import os
import re

FORMAT_VERSION = 1

# Ordenados de más a menos prioritario para la píldora compacta (docs/03).
STATES = ("atencion", "error", "trabajando", "pensando", "terminado", "inactivo")

_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")
_MAX_NAME = 80


def base_dir():
    """Raíz del bus. No la crea.

    AGENT_NOTCH_DIR la cambia: el GNOME de prueba (scripts/dev-shell.sh) y
    scripts/simulate.py usan $XDG_RUNTIME_DIR/agent-notch-dev, para que las
    sesiones de prueba no salgan en la isla del escritorio real.
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
    """Crea <base>/<sub> (y <base>) con permisos 0700 y devuelve la ruta."""
    root = base_dir()
    path = os.path.join(root, sub)
    # El padre (~/.cache en un usuario nuevo) puede no existir: con sus
    # permisos normales, que no son cosa nuestra.
    os.makedirs(os.path.dirname(root), exist_ok=True)
    for d in (root, path):
        try:
            os.mkdir(d, 0o700)
        except FileExistsError:
            pass
        else:
            os.chmod(d, 0o700)  # mkdir aplica la umask; chmod no
    return path


def safe_name(text):
    """Deja solo [A-Za-z0-9_-] para usarlo en un nombre de archivo."""
    cleaned = _UNSAFE.sub("_", str(text or ""))[:_MAX_NAME]
    return cleaned or "desconocida"


def session_path(agent, session_id):
    """Ruta de sessions/<agente>-<sesion>.json, creando la carpeta."""
    name = "%s-%s.json" % (safe_name(agent), safe_name(session_id))
    return os.path.join(ensure_dir("sessions"), name)


def read_json(path):
    """El objeto JSON de path, o {} si no existe, está roto o no es un objeto."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_json(path, data):
    """Escribe data en path de forma atómica.

    Primero en un temporal oculto de la misma carpeta (.<nombre>.<pid>.tmp,
    único por proceso para que dos hooks a la vez no se pisen) y luego
    os.replace: quien lee ve el archivo anterior o el nuevo, nunca uno a
    medias. La extensión ignora los nombres que empiezan por punto.
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
    """Borra path; no pasa nada si ya no existe."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
