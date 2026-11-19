#!/usr/bin/env python3
"""Sesiones de agentes falsas para probar la isla sin Claude Code.

Escriben el formato común (docs/03-formato-estado.md) con agente
"simulador". Por defecto van al bus del GNOME de prueba
($XDG_RUNTIME_DIR/agent-notch-dev, el que usa scripts/dev-shell.sh), no al
del escritorio real.

Uso:
    scripts/simulate.py demo         # ciclo de una sesión: inactivo → pensando → trabajando
                                     #   → atencion → trabajando → terminado → inactivo
    scripts/simulate.py multi 4      # 4 sesiones con estados variados, en segundo plano
    scripts/simulate.py atencion     # una sesión pidiendo atención, en segundo plano
    scripts/simulate.py list         # muestra las sesiones simuladas y su PID
    scripts/simulate.py clear        # borra todas las sesiones simuladas

Opciones:
    --real        usar el bus del escritorio real ($XDG_RUNTIME_DIR/agent-notch)
    --paso S      segundos entre estados en demo (por defecto 2)

Cada sesión de multi/atencion tiene su propio proceso dormido, cuyo PID va en
el archivo: matarlo (kill PID) simula un agente que se cierra mal, y la isla
debe quitar la sesión. Esos procesos se cierran solos a la hora.
"""

import argparse
import os
import random
import signal
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "adapters", "common"))
import state  # noqa: E402

AGENT = "simulador"
CHILD_TTL = 3600

PROJECTS = ["mi-app", "agent-notch", "api-pagos", "blog", "dotfiles", "tienda-web", "scraper", "bot-telegram"]
ACTIONS = {
    "inactivo": [None],
    "pensando": ["Pensando…"],
    "trabajando": [
        ("Editando main.py", "Edit"), ("Leyendo README.md", "Read"),
        ("Ejecutando npm test", "Bash"), ('Buscando "TODO"', "Grep"),
        ("Consultando la web", "WebFetch"), ("Delegando tarea", "Agent"),
    ],
    "atencion": ["Pide permiso: Bash", "Claude needs your permission to use Bash", "Tiene una pregunta"],
    "terminado": ["Listo"],
    "error": ["API Error: 529 Overloaded"],
}


def default_dir(real):
    """Bus de pruebas, salvo --real. Un AGENT_NOTCH_DIR ya puesto manda."""
    if not real and os.environ.get("AGENT_NOTCH_DIR"):
        return os.environ["AGENT_NOTCH_DIR"]
    runtime = os.environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid()
    return os.path.join(runtime, "agent-notch" if real else "agent-notch-dev")


def session(sid, project, estado, accion=None, tool=None, pid=None, inicio=None):
    now = time.time()
    return {
        "v": state.FORMAT_VERSION,
        "agente": AGENT,
        "sesion": sid,
        "proyecto": project,
        "cwd": "/home/usuario/proyectos/" + project,
        "estado": estado,
        "accion": accion,
        "herramienta": tool,
        "inicio": inicio or now,
        "actualizado": now,
        "pid": pid or os.getpid(),
    }


def pick(estado):
    choice = random.choice(ACTIONS[estado])
    return choice if isinstance(choice, tuple) else (choice, None)


def sim_files():
    folder = state.ensure_dir("sessions")
    return sorted(os.path.join(folder, n) for n in os.listdir(folder)
                  if n.startswith(AGENT + "-") and n.endswith(".json"))


def is_our_child(pid):
    """Solo matamos procesos que sean este mismo script."""
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            return b"simulate.py" in f.read()
    except OSError:
        return False


# --- procesos dormidos ----------------------------------------------------

def spawn_sleeper(path):
    """Proceso en segundo plano que vive hasta que lo maten o pase CHILD_TTL.
    Al salir por las buenas (TTL o SIGTERM de clear) borra su archivo; con
    SIGKILL no puede, como un agente que se cuelga."""
    pid = os.fork()
    if pid:
        return pid
    os.setsid()
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)

    def bye(*_):
        state.remove(path)
        os._exit(0)

    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    time.sleep(CHILD_TTL)
    bye()


def start_background(sid, project, estado):
    path = state.session_path(AGENT, sid)
    accion, tool = pick(estado)
    # Primero el proceso y después el archivo: así el PID que lleva ya existe.
    pid = spawn_sleeper(path)
    state.write_json(path, session(sid, project, estado, accion, tool, pid=pid))
    return pid


# --- comandos -------------------------------------------------------------

def cmd_demo(args):
    sid = "demo"
    path = state.session_path(AGENT, sid)
    steps = [
        ("inactivo", None, None),
        ("pensando", "Pensando…", None),
        ("trabajando", "Leyendo README.md", "Read"),
        ("trabajando", "Editando main.py", "Edit"),
        ("atencion", "Pide permiso: Bash", "Bash"),
        ("trabajando", "Ejecutando npm test", "Bash"),
        ("pensando", "Pensando…", None),
        ("terminado", "Listo", None),
        ("inactivo", None, None),
    ]
    inicio = time.time()
    print("Sesión demo en %s (Ctrl+C para cortar)" % path)
    try:
        for estado, accion, tool in steps:
            print("  %-10s %s" % (estado, accion or ""), flush=True)
            state.write_json(path, session(sid, "mi-app", estado, accion, tool, inicio=inicio))
            time.sleep(args.paso)
    except KeyboardInterrupt:
        print()
    finally:
        state.remove(path)
        print("Sesión demo borrada.")


def cmd_multi(args):
    estados = list(ACTIONS)
    projects = random.sample(PROJECTS, min(args.n, len(PROJECTS)))
    while len(projects) < args.n:
        projects.append("proyecto-%d" % (len(projects) + 1))
    for i, project in enumerate(projects):
        # Que salgan todos los estados antes de repetir.
        estado = estados[i % len(estados)] if i < len(estados) else random.choice(estados)
        sid = "multi-%d" % (i + 1)
        pid = start_background(sid, project, estado)
        print("  PID %-7d %-13s %s" % (pid, project, estado))
    print("Matar uno (kill PID) simula un agente que se cierra mal. Borrar todo: %s clear"
          % os.path.relpath(__file__))


def cmd_atencion(args):
    pid = start_background("atencion", "mi-app", "atencion")
    print("  PID %d  mi-app  atencion" % pid)


def cmd_list(args):
    files = sim_files()
    if not files:
        print("No hay sesiones simuladas.")
    for path in files:
        d = state.read_json(path)
        pid = d.get("pid")
        alive = os.path.exists("/proc/%s" % pid) if pid else False
        print("  PID %-7s %-5s %-13s %-10s %s" % (pid, "vivo" if alive else "muerto",
                                                d.get("proyecto"), d.get("estado"), d.get("accion") or ""))


def cmd_clear(args):
    files = sim_files()
    killed = []
    for path in files:
        pid = state.read_json(path).get("pid")
        if isinstance(pid, int) and pid != os.getpid() and is_our_child(pid):
            try:
                os.kill(pid, signal.SIGTERM)
                killed.append(pid)
            except OSError:
                pass
        state.remove(path)
    # Esperar a que terminen: al salir borran su archivo, y si después se
    # lanza otro multi, borrarían los nuevos que se llamen igual.
    deadline = time.time() + 2
    while time.time() < deadline and any(os.path.exists("/proc/%d" % p) for p in killed):
        time.sleep(0.02)
    print("Borradas %d sesiones simuladas." % len(files))


def main():
    parser = argparse.ArgumentParser(description="Sesiones de agentes falsas para la isla.")
    parser.add_argument("--real", action="store_true", help="bus del escritorio real, no el del GNOME de prueba")
    parser.add_argument("--paso", type=float, default=2.0, help="segundos entre estados en demo")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("demo")
    p = sub.add_parser("multi")
    p.add_argument("n", type=int, nargs="?", default=4)
    sub.add_parser("atencion")
    sub.add_parser("list")
    sub.add_parser("clear")
    args = parser.parse_args()
    if args.cmd == "multi" and not 1 <= args.n <= 20:
        parser.error("multi: entre 1 y 20 sesiones")

    os.environ["AGENT_NOTCH_DIR"] = default_dir(args.real)
    print("Bus: %s%s" % (os.environ["AGENT_NOTCH_DIR"], " (escritorio real)" if args.real else ""))
    {"demo": cmd_demo, "multi": cmd_multi, "atencion": cmd_atencion,
     "list": cmd_list, "clear": cmd_clear}[args.cmd](args)


if __name__ == "__main__":
    main()
