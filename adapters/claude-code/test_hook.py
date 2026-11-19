"""Pruebas de hook.py, lanzándolo como lo hace Claude Code (stdin → proceso).

    python3 -m unittest discover -s adapters/claude-code -v
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hook.py")


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.runtime = os.path.join(self.tmp.name, "run")
        os.mkdir(self.runtime, 0o700)
        self.sessions = os.path.join(self.runtime, "agent-notch", "sessions")

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, payload, env_extra=None):
        env = dict(os.environ, XDG_RUNTIME_DIR=self.runtime, HOME=self.tmp.name)
        env.pop("AGENT_NOTCH_DEBUG", None)
        env.pop("AGENT_NOTCH_DIR", None)
        env.update(env_extra or {})
        data = payload if isinstance(payload, (str, bytes)) else json.dumps(payload)
        if isinstance(data, str):
            data = data.encode()
        p = subprocess.run([sys.executable, HOOK], input=data, env=env,
                           capture_output=True, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout, b"")  # nunca imprime en stdout
        return p

    def event(self, name, sid="s1", **kw):
        ev = {"session_id": sid, "cwd": "/tmp/demo/mi-app", "hook_event_name": name}
        ev.update(kw)
        return self.run_hook(ev)

    def read(self, sid="s1"):
        with open(os.path.join(self.sessions, "claude-code-%s.json" % sid), encoding="utf-8") as f:
            return json.load(f)

    def files(self):
        return sorted(os.listdir(self.sessions)) if os.path.isdir(self.sessions) else []

    # --- recorrido de una sesión -----------------------------------------

    def test_sesion_completa(self):
        self.event("SessionStart", source="startup")
        d = self.read()
        self.assertEqual(d["v"], 1)
        self.assertEqual(d["agente"], "claude-code")
        self.assertEqual(d["sesion"], "s1")
        self.assertEqual(d["proyecto"], "mi-app")
        self.assertEqual(d["cwd"], "/tmp/demo/mi-app")
        self.assertEqual(d["estado"], "inactivo")
        self.assertIsNone(d["accion"])
        self.assertEqual(d["pid"], os.getpid())  # el padre del hook
        inicio = d["inicio"]
        self.assertAlmostEqual(inicio, time.time(), delta=5)

        self.event("UserPromptSubmit", prompt="secreto: no debe guardarse")
        d = self.read()
        self.assertEqual((d["estado"], d["accion"]), ("pensando", "Pensando…"))
        self.assertNotIn("secreto", json.dumps(d))

        self.event("PreToolUse", tool_name="Edit",
                   tool_input={"file_path": "/tmp/demo/mi-app/src/main.py", "new_string": "CONTENIDO"})
        d = self.read()
        self.assertEqual((d["estado"], d["accion"], d["herramienta"]),
                         ("trabajando", "Editando main.py", "Edit"))
        self.assertNotIn("CONTENIDO", json.dumps(d))

        self.event("PostToolUse", tool_name="Edit")
        d = self.read()
        self.assertEqual((d["estado"], d["accion"], d["herramienta"]), ("pensando", "Pensando…", None))

        self.event("Stop")
        d = self.read()
        self.assertEqual((d["estado"], d["accion"]), ("terminado", "Listo"))
        self.assertEqual(d["inicio"], inicio)  # se conserva
        self.assertGreaterEqual(d["actualizado"], inicio)

        self.event("SessionEnd", reason="exit")
        self.assertEqual(self.files(), [])

    # --- textos de acción -------------------------------------------------

    def test_acciones(self):
        cases = [
            ("Read", {"file_path": "/a/b/notas.md"}, "Leyendo notas.md"),
            ("Write", {"file_path": "/a/nuevo.txt"}, "Editando nuevo.txt"),
            ("NotebookEdit", {"notebook_path": "/a/x.ipynb"}, "Editando x.ipynb"),
            ("Edit", {}, "Editando archivo"),
            ("Bash", {"command": "npm test"}, "Ejecutando npm test"),
            ("Bash", {"command": "echo " + "a" * 100}, "Ejecutando echo " + "a" * 34 + "…"),
            ("Bash", {"command": "ls\n  -la"}, "Ejecutando ls -la"),
            ("Grep", {"pattern": "TODO"}, 'Buscando "TODO"'),
            ("Glob", {"pattern": "**/*.js"}, 'Buscando "**/*.js"'),
            ("WebFetch", {"url": "https://x"}, "Consultando la web"),
            ("Agent", {"prompt": "x"}, "Delegando tarea"),
            ("mcp__srv__tool", {}, "Usando mcp__srv__tool"),
            ("Read", "no es un objeto", "Leyendo archivo"),
        ]
        for tool, inp, expected in cases:
            self.event("PreToolUse", tool_name=tool, tool_input=inp)
            self.assertEqual(self.read()["accion"], expected, tool)
        self.assertLessEqual(len(self.read()["accion"]), 60)

    # --- atención y errores -----------------------------------------------

    def test_notificacion_que_pide_atencion(self):
        self.event("Stop")
        self.event("Notification", notification_type="permission_prompt",
                   message="Claude needs your permission to use Bash")
        d = self.read()
        self.assertEqual((d["estado"], d["accion"]),
                         ("atencion", "Claude needs your permission to use Bash"))

    def test_idle_prompt_no_cambia_nada(self):
        self.event("Stop")
        antes = self.read()
        self.event("Notification", notification_type="idle_prompt", message="waiting")
        self.assertEqual(self.read(), antes)

    def test_permission_request(self):
        self.event("PermissionRequest", tool_name="Bash", tool_input={"command": "rm x"})
        d = self.read()
        self.assertEqual((d["estado"], d["accion"]), ("atencion", "Pide permiso: Bash"))

    def test_stop_failure(self):
        self.event("StopFailure", last_assistant_message="API Error: 529 " + "x" * 100)
        d = self.read()
        self.assertEqual(d["estado"], "error")
        self.assertTrue(d["accion"].startswith("API Error: 529"))
        self.assertLessEqual(len(d["accion"]), 60)

    def test_evento_desconocido_no_crea_nada(self):
        self.event("PreCompact")
        self.event("SubagentStop")
        self.assertEqual(self.files(), [])

    # --- entradas malas: siempre salida 0 y sin efecto -------------------

    def test_entradas_malas(self):
        for bad in ("", "{roto", "[1,2]", "null", '"texto"', b"\xff\xfe", "{}"):
            self.run_hook(bad)
        self.assertEqual(self.files(), [])

    def test_sesion_con_id_peligroso(self):
        self.event("SessionStart", sid="../../etc/x")
        self.assertEqual(self.files(), ["claude-code-______etc_x.json"])
        self.assertEqual(self.read("______etc_x")["sesion"], "______etc_x")

    def test_carpeta_sin_permiso(self):
        os.chmod(self.runtime, 0o500)
        try:
            p = self.event("SessionStart")
        finally:
            os.chmod(self.runtime, 0o700)
        self.assertEqual(p.stderr, b"")  # sin AGENT_NOTCH_DEBUG no dice nada

    def test_dos_sesiones_dos_archivos(self):
        self.event("SessionStart", sid="a")
        self.event("SessionStart", sid="b")
        self.assertEqual(self.files(), ["claude-code-a.json", "claude-code-b.json"])

    def test_rapido(self):
        ev = json.dumps({"session_id": "t", "cwd": "/x", "hook_event_name": "PreToolUse",
                         "tool_name": "Read", "tool_input": {"file_path": "/x/a"}}).encode()
        env = dict(os.environ, XDG_RUNTIME_DIR=self.runtime)
        best = min(self._time(ev, env) for _ in range(5))
        self.assertLess(best, 0.1)

    def _time(self, data, env):
        t = time.perf_counter()
        subprocess.run([sys.executable, HOOK], input=data, env=env, check=True)
        return time.perf_counter() - t


if __name__ == "__main__":
    unittest.main()
