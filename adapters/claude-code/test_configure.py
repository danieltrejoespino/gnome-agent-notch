"""Pruebas de configure.py, lanzándolo como un usuario (proceso aparte).

    python3 -m unittest discover -s adapters/claude-code -v
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIGURE = os.path.join(HERE, "configure.py")
HOOK = os.path.join(HERE, "hook.py")

sys.path.insert(0, HERE)
import configure  # noqa: E402

OTHER_HOOK = {"hooks": [{"type": "command", "command": "otro-programa --hook"}]}


class ConfigureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = os.path.join(self.tmp.name, "claude")
        self.settings = os.path.join(self.config, "settings.json")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cfg(self, *args, code=0):
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.config, HOME=self.tmp.name)
        p = subprocess.run([sys.executable, CONFIGURE, *args], env=env,
                           capture_output=True, text=True, timeout=10)
        self.assertEqual(p.returncode, code, p.stdout + p.stderr)
        return p

    def write(self, data):
        os.makedirs(self.config, exist_ok=True)
        with open(self.settings, "w", encoding="utf-8") as f:
            f.write(data if isinstance(data, str) else json.dumps(data))

    def read(self):
        with open(self.settings, encoding="utf-8") as f:
            return json.load(f)

    def ours(self, data, event):
        return [g for g in data["hooks"].get(event, []) if configure.is_ours(g)]

    # --- install --------------------------------------------------------------

    def test_install_sin_archivo_lo_crea(self):
        self.run_cfg("install")
        data = self.read()
        self.assertEqual(set(data["hooks"]), set(configure.EVENTS))
        for event in configure.EVENTS:
            self.assertEqual(len(self.ours(data, event)), 1)
        self.assertEqual(os.stat(self.settings).st_mode & 0o777, 0o600)
        self.run_cfg("status")

    def test_install_respeta_lo_demas(self):
        self.write({"theme": "dark", "permissions": {"allow": ["Bash(ls)"]},
                    "hooks": {"PreToolUse": [OTHER_HOOK], "PreCompact": [OTHER_HOOK]}})
        os.chmod(self.settings, 0o644)
        self.run_cfg("install")
        data = self.read()
        self.assertEqual(data["theme"], "dark")
        self.assertEqual(data["permissions"], {"allow": ["Bash(ls)"]})
        self.assertEqual(data["hooks"]["PreCompact"], [OTHER_HOOK])
        # El otro hook sigue primero; el nuestro va detrás.
        self.assertEqual(data["hooks"]["PreToolUse"][0], OTHER_HOOK)
        self.assertEqual(len(data["hooks"]["PreToolUse"]), 2)
        self.assertEqual(os.stat(self.settings).st_mode & 0o777, 0o644)
        # Copia de seguridad con el contenido de antes.
        with open(self.settings + ".agent-notch.bak", encoding="utf-8") as f:
            self.assertNotIn(configure.MARKER, f.read())

    def test_install_dos_veces_no_duplica(self):
        self.run_cfg("install")
        before = self.read()
        p = self.run_cfg("install")
        self.assertIn("ya estaba", p.stdout)
        self.assertEqual(self.read(), before)

    def test_install_sustituye_otra_ruta(self):
        # Un hook de agent-notch que apunta a otro sitio (p. ej. un repo clonado).
        old = {"hooks": [{"type": "command",
                          "command": "exec python3 /repo/gnome-agent-notch/adapters/claude-code/hook.py"}]}
        self.write({"hooks": {"Stop": [OTHER_HOOK, old]}})
        self.run_cfg("install")
        stop = self.read()["hooks"]["Stop"]
        self.assertEqual(len(stop), 2)
        self.assertEqual(stop[0], OTHER_HOOK)
        self.assertIn(HOOK, stop[1]["hooks"][0]["command"])

    def test_json_roto_no_se_toca(self):
        self.write("{ esto no es json")
        p = self.run_cfg("install", code=1)
        self.assertIn("no es JSON", p.stderr)
        with open(self.settings, encoding="utf-8") as f:
            self.assertEqual(f.read(), "{ esto no es json")
        self.assertFalse(os.path.exists(self.settings + ".agent-notch.bak"))

    def test_hook_inexistente(self):
        p = self.run_cfg("install", "--hook", "/no/existe/hook.py", code=1)
        self.assertIn("no existe", p.stderr)
        self.assertFalse(os.path.exists(self.settings))

    # --- uninstall / status ---------------------------------------------------

    def test_uninstall_deja_lo_demas(self):
        self.write({"theme": "dark", "hooks": {"PreToolUse": [OTHER_HOOK]}})
        self.run_cfg("install")
        self.run_cfg("uninstall")
        self.assertEqual(self.read(), {"theme": "dark", "hooks": {"PreToolUse": [OTHER_HOOK]}})
        self.run_cfg("status", code=1)

    def test_uninstall_quita_hooks_vacio(self):
        self.write({"theme": "dark"})
        self.run_cfg("install")
        self.run_cfg("uninstall")
        self.assertEqual(self.read(), {"theme": "dark"})

    def test_uninstall_solo_su_ruta(self):
        # Desinstalar la copia instalada no quita el hook de un repo clonado.
        self.run_cfg("install", "--hook", HOOK)
        self.run_cfg("uninstall", "--hook", "/otra/agent-notch/adapters/claude-code/hook.py")
        self.run_cfg("status")

    def test_uninstall_sin_nada(self):
        p = self.run_cfg("uninstall")
        self.assertIn("no estaba", p.stdout)
        self.assertFalse(os.path.exists(self.settings))

    # --- el comando -------------------------------------------------------------

    def test_comando_sin_hook_sale_con_0(self):
        # Si hook.py desaparece, Claude Code no debe ver un 2 (= bloquear).
        cmd = configure.hook_command(os.path.join(self.tmp.name, "borrado", "hook.py"))
        p = subprocess.run(["sh", "-c", cmd], input=b"{}", capture_output=True, timeout=10)
        self.assertEqual(p.returncode, 0)

    def test_comando_lanza_el_hook(self):
        runtime = os.path.join(self.tmp.name, "run")
        os.mkdir(runtime, 0o700)
        env = dict(os.environ, XDG_RUNTIME_DIR=runtime, HOME=self.tmp.name)
        env.pop("AGENT_NOTCH_DIR", None)
        event = {"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": "/x/proyecto"}
        p = subprocess.run(["sh", "-c", configure.hook_command(HOOK)], env=env,
                           input=json.dumps(event).encode(), capture_output=True, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        path = os.path.join(runtime, "agent-notch", "sessions", "claude-code-s1.json")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["estado"], "pensando")
        # Gracias a `exec`, el padre de hook.py es quien lanzó `sh` (este test).
        self.assertEqual(data["pid"], os.getpid())

    def test_comando_con_espacios(self):
        cmd = configure.hook_command("/ruta con espacios/hook.py")
        self.assertIn("'/ruta con espacios/hook.py'", cmd)


if __name__ == "__main__":
    unittest.main()
