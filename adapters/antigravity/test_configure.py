"""Tests for configure.py: it edits ~/.gemini/config/hooks.json under a fake HOME.

    python3 -m unittest discover -s adapters/antigravity -v
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


class ConfigureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, ".gemini", "config", "hooks.json")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cfg(self, *args, ok=True):
        env = dict(os.environ, HOME=self.tmp.name)
        p = subprocess.run([sys.executable, CONFIGURE, *args], env=env,
                           capture_output=True, text=True, timeout=10)
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr)
        return p

    def write(self, data, raw=None):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(raw if raw is not None else json.dumps(data))

    def read(self):
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)

    OTHER = {"lint": {"PostToolUse": [{"matcher": "run_command",
                                       "hooks": [{"command": "./lint.sh"}]}]}}

    def test_install_sin_archivo_lo_crea(self):
        self.run_cfg("install")
        d = self.read()
        self.assertEqual(list(d), ["agent-notch"])
        entry = d["agent-notch"]
        self.assertEqual(sorted(entry), ["PostToolUse", "PreInvocation", "PreToolUse",
                                         "SessionStart", "Stop"])
        self.assertEqual(entry["PreToolUse"][0]["matcher"], "*")
        self.assertIn(HOOK, entry["SessionStart"][0]["command"])
        self.assertEqual(self.run_cfg("status").returncode, 0)

    def test_install_respeta_lo_demas(self):
        self.write(self.OTHER)
        self.run_cfg("install")
        d = self.read()
        self.assertEqual(d["lint"], self.OTHER["lint"])
        self.assertIn("agent-notch", d)

    def test_install_dos_veces_igual(self):
        self.run_cfg("install")
        first = self.read()
        p = self.run_cfg("install")
        self.assertIn("already", p.stdout)
        self.assertEqual(self.read(), first)

    def test_install_sustituye_otra_ruta(self):
        other = os.path.join(self.tmp.name, "repo", "adapters", "antigravity", "hook.py")
        self.write({"agent-notch": configure.spec(other)})
        self.run_cfg("install")
        self.assertEqual(self.read()["agent-notch"], configure.spec(HOOK))

    def test_nombre_ajeno_no_se_toca(self):
        self.write({"agent-notch": {"Stop": [{"command": "./mine.sh"}]}})
        p = self.run_cfg("install", ok=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.read()["agent-notch"]["Stop"][0]["command"], "./mine.sh")

    def test_json_roto_no_se_toca(self):
        self.write(None, raw="{ broken")
        p = self.run_cfg("install", ok=False)
        self.assertNotEqual(p.returncode, 0)
        with open(self.path) as f:
            self.assertEqual(f.read(), "{ broken")

    def test_acepta_bom(self):
        self.write(None, raw="﻿" + json.dumps(self.OTHER))
        self.run_cfg("install")
        self.assertIn("lint", self.read())

    def test_hook_inexistente(self):
        p = self.run_cfg("install", "--hook", "/no/existe/hook.py", ok=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse(os.path.exists(self.path))

    def test_status_sin_instalar(self):
        self.assertEqual(self.run_cfg("status", ok=False).returncode, 1)

    def test_uninstall_deja_lo_demas(self):
        self.write(self.OTHER)
        self.run_cfg("install")
        self.run_cfg("uninstall")
        self.assertEqual(self.read(), self.OTHER)

    def test_sin_archivo_previo_no_deja_rastro(self):
        self.run_cfg("install")
        self.run_cfg("uninstall")
        self.assertEqual(os.listdir(os.path.dirname(self.path)), [])

    def test_copia_guarda_el_original(self):
        self.write(self.OTHER)
        self.run_cfg("install")
        self.run_cfg("install", "--hook", HOOK)
        with open(self.path + ".agent-notch.bak") as f:
            self.assertEqual(json.load(f), self.OTHER)

    def test_uninstall_solo_su_ruta(self):
        other = os.path.join(self.tmp.name, "repo", "adapters", "antigravity", "hook.py")
        self.write({"agent-notch": configure.spec(other)})
        p = self.run_cfg("uninstall")
        self.assertIn("another copy", p.stdout)
        self.assertIn("agent-notch", self.read())

    def test_uninstall_sin_nada(self):
        p = self.run_cfg("uninstall")
        self.assertIn("was not", p.stdout)

    def test_comando_sin_hook_no_imprime(self):
        cmd = configure.hook_command("/no/existe/hook.py")
        p = subprocess.run(["sh", "-c", cmd], input=b"{}", capture_output=True, timeout=10)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout, b"")

    def test_comando_lanza_el_hook(self):
        runtime = os.path.join(self.tmp.name, "run")
        os.mkdir(runtime, 0o700)
        env = dict(os.environ, XDG_RUNTIME_DIR=runtime, HOME=self.tmp.name)
        env.pop("AGENT_NOTCH_DIR", None)
        ev = {"conversationId": "c9", "hookEventName": "SessionStart", "cwd": "/w/app"}
        p = subprocess.run(["sh", "-c", configure.hook_command(HOOK)], env=env,
                           input=json.dumps(ev).encode(), capture_output=True, timeout=10)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout, b"")
        path = os.path.join(runtime, "agent-notch", "sessions", "antigravity-c9.json")
        with open(path) as f:
            d = json.load(f)
        # `exec`: the hook's parent is the process that ran `sh -c` (agy).
        self.assertEqual(d["pid"], os.getpid())

    def test_comando_con_espacios(self):
        cmd = configure.hook_command("/a b/it's/hook.py")
        self.assertIn("'/a b/it'\"'\"'s/hook.py'", cmd)


if __name__ == "__main__":
    unittest.main()
