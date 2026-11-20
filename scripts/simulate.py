#!/usr/bin/env python3
"""Fake agent sessions to try the island without Claude Code.

They write the common format (docs/03-formato-estado.md) with agent
"simulador". By default they go to the test GNOME's bus
($XDG_RUNTIME_DIR/agent-notch-dev, the one scripts/dev-shell.sh uses), not to
the real desktop's.

Uso:
    scripts/simulate.py demo         # one session's cycle: inactivo → pensando → trabajando
                                     #   → atencion → trabajando → terminado → inactivo
    scripts/simulate.py multi 4      # 4 sessions in different states, in the background
    scripts/simulate.py atencion     # one session asking for attention, in the background
    scripts/simulate.py list         # shows the simulated sessions and their PID
    scripts/simulate.py clear        # removes all the simulated sessions

Opciones:
    --real        use the real desktop's bus ($XDG_RUNTIME_DIR/agent-notch)
    --paso S      seconds between states in demo (2 by default)

Each multi/atencion session has its own sleeping process, whose PID goes in
the file: killing it (kill PID) simulates an agent that dies, and the island
must remove the session. Those processes quit on their own after an hour.
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

PROJECTS = ["my-app", "agent-notch", "payments-api", "blog", "dotfiles", "web-shop", "scraper", "telegram-bot"]
ACTIONS = {
    "inactivo": [None],
    "pensando": ["Pensando…"],
    "trabajando": [
        ("Editing main.py", "Edit"), ("Reading README.md", "Read"),
        ("Running npm test", "Bash"), ('Searching "TODO"', "Grep"),
        ("Browsing the web", "WebFetch"), ("Delegating a task", "Agent"),
    ],
    "atencion": ["Asks permission: Bash", "Claude needs your permission to use Bash", "Has a question"],
    "terminado": ["Done"],
    "error": ["API Error: 529 Overloaded"],
}


def default_dir(real):
    """Test bus, unless --real. An AGENT_NOTCH_DIR already set wins."""
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
    """We only kill processes that are this same script."""
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            return b"simulate.py" in f.read()
    except OSError:
        return False


# --- sleeping processes ----------------------------------------------------

def spawn_sleeper(path):
    """Background process that lives until it is killed or CHILD_TTL passes.
    When it exits cleanly (TTL or clear's SIGTERM) it removes its file; with
    SIGKILL it cannot, like an agent that hangs."""
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
    # First the process and then the file: that way the PID it carries already exists.
    pid = spawn_sleeper(path)
    state.write_json(path, session(sid, project, estado, accion, tool, pid=pid))
    return pid


# --- commands -------------------------------------------------------------

def cmd_demo(args):
    sid = "demo"
    path = state.session_path(AGENT, sid)
    steps = [
        ("inactivo", None, None),
        ("pensando", "Thinking…", None),
        ("trabajando", "Reading README.md", "Read"),
        ("trabajando", "Editing main.py", "Edit"),
        ("atencion", "Asks permission: Bash", "Bash"),
        ("trabajando", "Running npm test", "Bash"),
        ("pensando", "Thinking…", None),
        ("terminado", "Done", None),
        ("inactivo", None, None),
    ]
    inicio = time.time()
    print("Demo session in %s (Ctrl+C to stop)" % path)
    try:
        for estado, accion, tool in steps:
            print("  %-10s %s" % (estado, accion or ""), flush=True)
            state.write_json(path, session(sid, "mi-app", estado, accion, tool, inicio=inicio))
            time.sleep(args.paso)
    except KeyboardInterrupt:
        print()
    finally:
        state.remove(path)
        print("Demo session removed.")


def cmd_multi(args):
    estados = list(ACTIONS)
    projects = random.sample(PROJECTS, min(args.n, len(PROJECTS)))
    while len(projects) < args.n:
        projects.append("project-%d" % (len(projects) + 1))
    for i, project in enumerate(projects):
        # Show all the states before repeating.
        estado = estados[i % len(estados)] if i < len(estados) else random.choice(estados)
        sid = "multi-%d" % (i + 1)
        pid = start_background(sid, project, estado)
        print("  PID %-7d %-13s %s" % (pid, project, estado))
    print("Killing one (kill PID) simulates an agent that dies. Remove all: %s clear"
          % os.path.relpath(__file__))


def cmd_atencion(args):
    pid = start_background("atencion", "my-app", "atencion")
    print("  PID %d  my-app  atencion" % pid)


def cmd_list(args):
    files = sim_files()
    if not files:
        print("No simulated sessions.")
    for path in files:
        d = state.read_json(path)
        pid = d.get("pid")
        alive = os.path.exists("/proc/%s" % pid) if pid else False
        print("  PID %-7s %-5s %-13s %-10s %s" % (pid, "alive" if alive else "dead",
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
    # Wait for them to finish: when they exit they remove their file, and if another
    # multi is started afterwards, they would remove the new ones with the same name.
    deadline = time.time() + 2
    while time.time() < deadline and any(os.path.exists("/proc/%d" % p) for p in killed):
        time.sleep(0.02)
    print("Removed %d simulated sessions." % len(files))


def main():
    parser = argparse.ArgumentParser(description="Sesiones de agentes falsas para la isla.")
    parser.add_argument("--real", action="store_true", help="the real desktop's bus, not the test GNOME's")
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
    print("Bus: %s%s" % (os.environ["AGENT_NOTCH_DIR"], " (real desktop)" if args.real else ""))
    {"demo": cmd_demo, "multi": cmd_multi, "atencion": cmd_atencion,
     "list": cmd_list, "clear": cmd_clear}[args.cmd](args)


if __name__ == "__main__":
    main()
