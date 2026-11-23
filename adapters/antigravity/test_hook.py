"""Tests for hook.py, running it the way Antigravity does (stdin → process).

    python3 -m unittest discover -s adapters/antigravity -v

The payloads copy the ones agy 1.5.14 sent on 22-11-2026 (camelCase keys).
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hook.py")
sys.path.insert(0, os.path.dirname(HOOK))
import hook  # noqa: E402


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.runtime = os.path.join(self.tmp.name, "run")
        os.mkdir(self.runtime, 0o700)
        self.sessions = os.path.join(self.runtime, "agent-notch", "sessions")

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, payload):
        env = dict(os.environ, XDG_RUNTIME_DIR=self.runtime, HOME=self.tmp.name)
        env.pop("AGENT_NOTCH_DEBUG", None)
        env.pop("AGENT_NOTCH_DIR", None)
        data = payload if isinstance(payload, (str, bytes)) else json.dumps(payload)
        if isinstance(data, str):
            data = data.encode()
        p = subprocess.run([sys.executable, HOOK], input=data, env=env,
                           capture_output=True, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        # Never prints on stdout: for agy, `{}` on PreToolUse denies the tool.
        self.assertEqual(p.stdout, b"")
        return p

    def event(self, name, cid="c1", **kw):
        ev = {
            "conversationId": cid,
            "cwd": "/tmp/demo/mi-app",
            "workspacePaths": ["/tmp/demo/mi-app"],
            "hookEventName": name,
            "modelName": "auto",
            "lastUserInput": "secret prompt text",
        }
        ev.update(kw)
        return self.run_hook(ev)

    def tool(self, name, cid="c1", event="PreToolUse", **args):
        return self.event(event, cid, toolCall={"id": "t1", "name": name, "args": args}, stepIdx=2)

    def read(self, cid="c1"):
        with open(os.path.join(self.sessions, "antigravity-%s.json" % cid), encoding="utf-8") as f:
            return json.load(f)

    def files(self):
        return sorted(os.listdir(self.sessions)) if os.path.isdir(self.sessions) else []

    # --- a session's path -----------------------------------------

    def test_sesion_completa(self):
        self.event("SessionStart")
        d = self.read()
        self.assertEqual(d["v"], 1)
        self.assertEqual(d["agente"], "antigravity")
        self.assertEqual(d["sesion"], "c1")
        self.assertEqual(d["proyecto"], "mi-app")
        self.assertEqual(d["cwd"], "/tmp/demo/mi-app")
        self.assertEqual(d["estado"], "inactivo")
        self.assertEqual(d["pid"], os.getpid())  # the parent of the hook
        inicio = d["inicio"]

        self.event("PreInvocation", invocationNum=0)
        self.assertEqual(self.read()["estado"], "pensando")

        self.tool("read_file", Path="/tmp/demo/mi-app/src/main.py")
        d = self.read()
        self.assertEqual(d["estado"], "trabajando")
        self.assertEqual(d["accion"], "Reading main.py")
        self.assertEqual(d["herramienta"], "read_file")

        self.tool("read_file", event="PostToolUse")
        d = self.read()
        self.assertEqual(d["estado"], "pensando")
        self.assertIsNone(d["herramienta"])

        self.event("Stop", terminationReason="NO_TOOL_CALL", error="", fullyIdle=True)
        d = self.read()
        self.assertEqual(d["estado"], "terminado")
        self.assertEqual(d["accion"], "Done")
        self.assertEqual(d["inicio"], inicio)

    def test_no_guarda_el_prompt(self):
        self.event("PreInvocation")
        with open(os.path.join(self.sessions, "antigravity-c1.json"), encoding="utf-8") as f:
            self.assertNotIn("secret", f.read())

    def test_post_invocation_no_cambia_nada(self):
        self.tool("run_command", CommandLine="npm test")
        self.event("PostInvocation")
        self.assertEqual(self.read()["accion"], "Running npm test")

    def test_pregunta_pide_atencion(self):
        self.tool("ask_question", Question="Which one?")
        d = self.read()
        self.assertEqual(d["estado"], "atencion")
        self.assertNotIn("Which one", json.dumps(d))

    def test_stop_cancelado(self):
        self.event("Stop", terminationReason="USER_CANCELED")
        self.assertEqual(self.read()["accion"], "Canceled")
        self.assertEqual(self.read()["estado"], "terminado")

    def test_stop_con_error(self):
        self.event("Stop", terminationReason="ERROR", error="quota exceeded")
        d = self.read()
        self.assertEqual(d["estado"], "error")
        self.assertEqual(d["accion"], "quota exceeded")

    def test_stop_por_limite(self):
        self.event("Stop", terminationReason="MAX_TOKEN_BUDGET_EXCEEDED", error="")
        d = self.read()
        self.assertEqual(d["estado"], "error")
        self.assertEqual(d["accion"], "Stopped: token budget")

    def test_sin_cwd_usa_el_workspace(self):
        self.run_hook({"conversationId": "c1", "hookEventName": "SessionStart",
                       "workspacePaths": ["/w/proyecto"]})
        self.assertEqual(self.read()["proyecto"], "proyecto")

    def test_nueva_conversacion_quita_la_anterior_del_mismo_agy(self):
        self.event("SessionStart", cid="vieja")
        self.event("SessionStart", cid="nueva")
        self.assertEqual(self.files(), ["antigravity-nueva.json"])

    def test_no_quita_otros_agentes_ni_otros_pids(self):
        os.makedirs(self.sessions, mode=0o700)
        for name, pid in (("claude-code-x.json", os.getpid()), ("antigravity-otro.json", 1)):
            with open(os.path.join(self.sessions, name), "w") as f:
                json.dump({"pid": pid}, f)
        self.event("SessionStart")
        self.assertEqual(self.files(), ["antigravity-c1.json", "antigravity-otro.json",
                                        "claude-code-x.json"])

    def test_id_raro_no_escapa_de_la_carpeta(self):
        self.event("SessionStart", cid="../../etc/x")
        self.assertEqual(self.files(), ["antigravity-______etc_x.json"])

    # --- bad input: always 0, nothing on stdout ---------------------------

    def test_entrada_rota(self):
        self.run_hook("not json")
        self.run_hook("")
        self.run_hook("[1, 2]")
        self.assertEqual(self.files(), [])

    def test_evento_desconocido(self):
        self.event("SomethingNew")
        self.assertEqual(self.files(), [])

    def test_toolcall_raro(self):
        self.event("PreToolUse", toolCall="nope")
        self.assertEqual(self.read()["accion"], "Using tool")


class DescribeTest(unittest.TestCase):
    def test_frases(self):
        d = hook.describe
        self.assertEqual(d("run_command", {"CommandLine": "npm test"}), "Running npm test")
        self.assertEqual(d("read_file", {"Path": "/a/b.py"}), "Reading b.py")
        self.assertEqual(d("view_file", {"AbsolutePath": "/a/c.js"}), "Reading c.js")
        self.assertEqual(d("write_to_file", {"TargetFile": "/a/d.md"}), "Editing d.md")
        self.assertEqual(d("replace_file_content", {"TargetFile": "/a/e.go"}), "Editing e.go")
        self.assertEqual(d("grep_search", {"Query": "TODO"}), 'Searching "TODO"')
        self.assertEqual(d("find_by_name", {"Pattern": "*.py"}), 'Searching "*.py"')
        self.assertEqual(d("list_dir", {"Path": "/a/src/"}), "Listing src")
        self.assertEqual(d("search_web", {"Query": "x"}), "Browsing the web")
        self.assertEqual(d("browser_subagent", {}), "Browsing the web")
        self.assertEqual(d("mcp_github_list", {}), "Using mcp_github_list")
        self.assertEqual(d(None, None), "Using tool")

    def test_comando_largo_recortado(self):
        out = hook.describe("run_command", {"CommandLine": "x" * 100})
        self.assertTrue(out.endswith("…"))
        self.assertLessEqual(len(out), len("Running ") + hook.MAX_COMMAND)


if __name__ == "__main__":
    unittest.main()
