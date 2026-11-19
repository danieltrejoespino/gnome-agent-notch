"""Pruebas de state.py:  python3 -m unittest discover -s adapters/common -v"""

import json
import multiprocessing
import os
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import state  # noqa: E402


def _writer(path, n, size):
    for i in range(n):
        state.write_json(path, {"i": i, "relleno": "x" * size})


class StateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.runtime = os.path.join(self.tmp.name, "run")
        os.mkdir(self.runtime, 0o700)
        env = {"XDG_RUNTIME_DIR": self.runtime, "HOME": os.path.join(self.tmp.name, "home")}
        self.env = mock.patch.dict(os.environ, env)
        self.env.start()
        os.environ.pop("XDG_CACHE_HOME", None)
        os.environ.pop("AGENT_NOTCH_DIR", None)

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def mode(self, path):
        return stat.S_IMODE(os.stat(path).st_mode)

    # --- carpetas ---------------------------------------------------------

    def test_carpetas_en_runtime_con_0700(self):
        old = os.umask(0o022)
        try:
            path = state.session_path("claude-code", "abc")
        finally:
            os.umask(old)
        root = os.path.join(self.runtime, "agent-notch")
        self.assertEqual(path, os.path.join(root, "sessions", "claude-code-abc.json"))
        self.assertEqual(self.mode(root), 0o700)
        self.assertEqual(self.mode(os.path.join(root, "sessions")), 0o700)

    def test_carpeta_existente_no_se_toca(self):
        root = os.path.join(self.runtime, "agent-notch")
        os.mkdir(root, 0o755)
        state.ensure_dir("sessions")
        self.assertEqual(self.mode(root), 0o755)

    def test_sin_runtime_usa_cache(self):
        del os.environ["XDG_RUNTIME_DIR"]
        self.assertEqual(state.base_dir(),
                         os.path.join(self.tmp.name, "home", ".cache", "agent-notch"))
        os.environ["XDG_CACHE_HOME"] = os.path.join(self.tmp.name, "cache")
        self.assertEqual(state.base_dir(), os.path.join(self.tmp.name, "cache", "agent-notch"))

    def test_agent_notch_dir_manda(self):
        os.environ["AGENT_NOTCH_DIR"] = os.path.join(self.runtime, "agent-notch-dev")
        path = state.session_path("simulador", "x")
        self.assertEqual(path, os.path.join(self.runtime, "agent-notch-dev", "sessions", "simulador-x.json"))
        self.assertEqual(self.mode(os.path.dirname(path)), 0o700)

    def test_runtime_que_no_existe_usa_cache(self):
        os.environ["XDG_RUNTIME_DIR"] = os.path.join(self.tmp.name, "no-existe")
        self.assertTrue(state.base_dir().startswith(os.path.join(self.tmp.name, "home")))

    def test_sin_runtime_crea_cache(self):
        del os.environ["XDG_RUNTIME_DIR"]
        path = state.session_path("claude-code", "abc")
        self.assertTrue(os.path.isdir(os.path.dirname(path)))
        self.assertEqual(self.mode(os.path.dirname(path)), 0o700)

    # --- nombre seguro ----------------------------------------------------

    def test_nombre_seguro(self):
        self.assertEqual(state.safe_name("3f2a-9c1e_X"), "3f2a-9c1e_X")
        self.assertEqual(state.safe_name("../../etc/passwd"), "______etc_passwd")
        self.assertEqual(state.safe_name("a b/c.json"), "a_b_c_json")
        self.assertEqual(state.safe_name("ñ"), "_")
        self.assertEqual(len(state.safe_name("x" * 500)), 80)

    def test_nombre_vacio(self):
        for value in ("", None):
            self.assertEqual(state.safe_name(value), "desconocida")

    def test_ruta_no_sale_de_sessions(self):
        path = state.session_path("../x", "../../../tmp/evil")
        sessions = os.path.join(self.runtime, "agent-notch", "sessions")
        self.assertEqual(os.path.dirname(path), sessions)

    # --- escritura y lectura ---------------------------------------------

    def test_escribir_y_leer(self):
        path = state.session_path("claude-code", "abc")
        data = {"v": 1, "accion": "Editando año.py"}
        state.write_json(path, data)
        self.assertEqual(state.read_json(path), data)
        self.assertEqual(self.mode(path), 0o600)
        with open(path, encoding="utf-8") as f:
            self.assertIn("año", f.read())  # sin escapar

    def test_sobrescribir_no_deja_temporales(self):
        path = state.session_path("claude-code", "abc")
        for i in range(5):
            state.write_json(path, {"i": i})
        self.assertEqual(state.read_json(path), {"i": 4})
        self.assertEqual(os.listdir(os.path.dirname(path)), ["claude-code-abc.json"])

    def test_error_al_escribir_no_deja_temporal_ni_pisa(self):
        path = state.session_path("claude-code", "abc")
        state.write_json(path, {"bueno": True})
        with self.assertRaises(TypeError):
            state.write_json(path, {"malo": object()})
        self.assertEqual(state.read_json(path), {"bueno": True})
        self.assertEqual(os.listdir(os.path.dirname(path)), ["claude-code-abc.json"])

    def test_leer_casos_malos(self):
        folder = state.ensure_dir("sessions")
        self.assertEqual(state.read_json(os.path.join(folder, "no-existe.json")), {})
        for name, content in (("roto", "{a"), ("lista", "[1]"), ("vacio", ""), ("bin", b"\xff\xfe")):
            p = os.path.join(folder, name + ".json")
            with open(p, "wb") as f:
                f.write(content if isinstance(content, bytes) else content.encode())
            self.assertEqual(state.read_json(p), {}, name)

    def test_lectores_nunca_ven_json_a_medias(self):
        path = state.session_path("claude-code", "abc")
        state.write_json(path, {"i": -1})
        ctx = multiprocessing.get_context("fork")
        writers = [ctx.Process(target=_writer, args=(path, 200, 20000)) for _ in range(3)]
        for w in writers:
            w.start()
        reads = 0
        while any(w.is_alive() for w in writers):
            with open(path, encoding="utf-8") as f:
                json.loads(f.read())  # falla si está a medias
            reads += 1
        for w in writers:
            w.join()
            self.assertEqual(w.exitcode, 0)
        self.assertGreater(reads, 10)
        self.assertEqual(os.listdir(os.path.dirname(path)), ["claude-code-abc.json"])

    # --- borrado ----------------------------------------------------------

    def test_borrar(self):
        path = state.session_path("claude-code", "abc")
        state.write_json(path, {})
        state.remove(path)
        self.assertFalse(os.path.exists(path))
        state.remove(path)  # otra vez: sin error


if __name__ == "__main__":
    unittest.main()
