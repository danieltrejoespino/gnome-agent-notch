// Pruebas del adaptador de OpenCode, con el Bun que trae OpenCode:
//     BUN_BE_BUN=1 ~/.opencode/bin/opencode test adapters/opencode

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import plugin, { Tracker, baseDir, describe, findClientPid, safeName } from "./agent-notch.js";

let tmp, now, pidOf;
const read = (sid) => JSON.parse(fs.readFileSync(path.join(tmp, "sessions", `opencode-${sid}.json`), "utf8"));
const files = () => (fs.existsSync(path.join(tmp, "sessions")) ? fs.readdirSync(path.join(tmp, "sessions")).sort() : []);
const tracker = () => new Tracker({ dir: tmp, now: () => now, findPid: (dir) => pidOf(dir) });
const created = (t, sid = "ses_1", dir = "/home/u/mi-app", extra = {}) =>
  t.handle("session.created", { sessionID: sid, location: { directory: dir }, ...extra });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "an-oc-"));
  now = 1_800_000_000;
  pidOf = () => null;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("recorrido de una sesión", () => {
  const t = tracker();
  created(t);
  let d = read("ses_1");
  expect(d).toMatchObject({ v: 1, agente: "opencode", sesion: "ses_1", proyecto: "mi-app", cwd: "/home/u/mi-app", estado: "inactivo", pid: null });
  t.handle("session.execution.started", { sessionID: "ses_1" });
  expect(read("ses_1")).toMatchObject({ estado: "pensando", accion: "Thinking…" });
  t.handle("session.tool.input.started", { sessionID: "ses_1", id: "t1", name: "read" });
  expect(read("ses_1")).toMatchObject({ estado: "trabajando", accion: "Reading file", herramienta: "read" });
  t.handle("session.tool.called", { sessionID: "ses_1", id: "t1", input: { path: "/home/u/mi-app/src/main.py" } });
  expect(read("ses_1").accion).toBe("Reading main.py");
  t.handle("session.tool.success", { sessionID: "ses_1", id: "t1", content: "SECRETO" });
  d = read("ses_1");
  expect(d).toMatchObject({ estado: "pensando", herramienta: null });
  expect(JSON.stringify(d)).not.toContain("SECRETO");
  now += 5;
  t.handle("session.execution.succeeded", { sessionID: "ses_1" });
  d = read("ses_1");
  expect(d).toMatchObject({ estado: "terminado", accion: "Done", inicio: 1_800_000_000, actualizado: 1_800_000_005 });
  t.handle("session.deleted", { sessionID: "ses_1" });
  expect(files()).toEqual([]);
});

test("dos herramientas a la vez: sigue trabajando hasta que acaban las dos", () => {
  const t = tracker();
  created(t);
  t.handle("session.tool.input.started", { sessionID: "ses_1", id: "a", name: "read" });
  t.handle("session.tool.input.started", { sessionID: "ses_1", id: "b", name: "grep" });
  t.handle("session.tool.failed", { sessionID: "ses_1", id: "a" });
  expect(read("ses_1").estado).toBe("trabajando");
  t.handle("session.tool.success", { sessionID: "ses_1", id: "b" });
  expect(read("ses_1").estado).toBe("pensando");
});

test("errores e interrupciones", () => {
  const t = tracker();
  created(t);
  t.handle("session.execution.failed", { sessionID: "ses_1" });
  expect(read("ses_1")).toMatchObject({ estado: "error", accion: "Error" });
  t.handle("session.execution.interrupted", { sessionID: "ses_1" });
  expect(read("ses_1")).toMatchObject({ estado: "inactivo", accion: null });
});

test("permisos y preguntas", () => {
  const t = tracker();
  created(t);
  t.handle("permission.asked", { sessionID: "ses_1", action: "bash", resources: ["rm x"] });
  expect(read("ses_1")).toMatchObject({ estado: "atencion", accion: "Asks permission: bash" });
  // Una herramienta que acaba mientras tanto no quita la atención.
  t.handle("session.tool.success", { sessionID: "ses_1", id: "zz" });
  expect(read("ses_1").estado).toBe("atencion");
  t.handle("permission.replied", { sessionID: "ses_1" });
  expect(read("ses_1").estado).toBe("pensando");
  t.handle("form.created", { sessionID: "ses_1", form: {} });
  expect(read("ses_1")).toMatchObject({ estado: "atencion", accion: "Has a question" });
  t.handle("form.cancelled", { sessionID: "ses_1" });
  expect(read("ses_1").estado).toBe("pensando");
});

test("subagentes: no salen aparte y su atención sube a la principal", () => {
  const t = tracker();
  created(t);
  t.handle("session.tool.input.started", { sessionID: "ses_1", id: "s", name: "subagent" });
  expect(read("ses_1").accion).toBe("Delegating a task");
  created(t, "ses_hijo", "/home/u/mi-app", { parentID: "ses_1" });
  t.handle("session.execution.started", { sessionID: "ses_hijo" });
  t.handle("session.tool.input.started", { sessionID: "ses_hijo", id: "r", name: "read" });
  expect(files()).toEqual(["opencode-ses_1.json"]);
  expect(read("ses_1").accion).toBe("Delegating a task");
  t.handle("permission.asked", { sessionID: "ses_hijo", action: "edit" });
  expect(read("ses_1")).toMatchObject({ estado: "atencion", accion: "Asks permission: edit" });
  t.handle("session.deleted", { sessionID: "ses_hijo" });
  expect(files()).toEqual(["opencode-ses_1.json"]);
});

test("eventos raros o sin sesión no rompen ni escriben", () => {
  const t = tracker();
  t.handle("session.text.delta", { sessionID: "x", delta: "hola" });
  t.handle("algo.nuevo", {});
  t.handle("session.created", {});
  expect(files()).toEqual([]);
});

test("sin cambios no reescribe; con PID nuevo sí", () => {
  const t = tracker();
  created(t);
  const file = path.join(tmp, "sessions", "opencode-ses_1.json");
  const ino = fs.statSync(file).ino;
  now += 1;
  t.handle("session.execution.started", { sessionID: "ses_1" });
  const ino2 = fs.statSync(file).ino;
  expect(ino2).not.toBe(ino);
  t.handle("session.execution.started", { sessionID: "ses_1" });
  expect(fs.statSync(file).ino).toBe(ino2);
  // La interfaz aparece: se busca como mucho cada 10 s.
  pidOf = () => 4242;
  now += 3;
  t.handle("session.execution.started", { sessionID: "ses_1" });
  expect(read("ses_1").pid).toBe(null);
  now += 10;
  t.handle("session.execution.started", { sessionID: "ses_1" });
  expect(read("ses_1").pid).toBe(4242);
});

test("archivos privados y sin temporales", () => {
  const t = tracker();
  created(t, "../../etc/x");
  expect(files()).toEqual(["opencode-______etc_x.json"]);
  expect(fs.statSync(path.join(tmp, "sessions")).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(tmp, "sessions", files()[0])).mode & 0o777).toBe(0o600);
  t.removeAll();
  expect(files()).toEqual([]);
});

test("textos", () => {
  expect(describe("bash", { command: "npm test\n  --watch" })).toBe("Running npm test --watch");
  expect(describe("bash", { command: "echo " + "a".repeat(100) })).toBe("Running echo " + "a".repeat(34) + "…");
  expect(describe("edit", { filePath: "/x/y/z.ts" })).toBe("Editing z.ts");
  expect(describe("glob", { pattern: "**/*.js" })).toBe('Searching "**/*.js"');
  expect(describe("webfetch", {})).toBe("Browsing the web");
  expect(describe("mcp_github_issues", {})).toBe("Using mcp_github_issues");
  expect(describe(undefined, null)).toBe("Using tool");
  expect(describe("bash", null)).toBe("Running a command");
  expect(describe("grep", {})).toBe("Searching…");
  expect(safeName("")).toBe("desconocida");
});

test("carpeta del bus", () => {
  expect(baseDir({ AGENT_NOTCH_DIR: "/x" })).toBe("/x");
  expect(baseDir({ XDG_RUNTIME_DIR: tmp })).toBe(path.join(tmp, "agent-notch"));
  expect(baseDir({ XDG_RUNTIME_DIR: "/no/existe", XDG_CACHE_HOME: "/c" })).toBe("/c/agent-notch");
});

test("findClientPid con un /proc falso", () => {
  const proc = path.join(tmp, "proc");
  const proj = fs.mkdtempSync(path.join(tmp, "proj-"));
  const other = fs.mkdtempSync(path.join(tmp, "otro-"));
  const fake = (pid, argv, cwd) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), "cmdline"), argv.join("\0") + "\0");
    fs.symlinkSync(cwd, path.join(proc, String(pid), "cwd"));
  };
  fake(10, ["/home/u/.opencode/bin/opencode", "serve", "--service"], proj);  // el servicio
  fake(11, ["/bin/bash", "-c", "opencode"], proj);                           // no es opencode
  fake(12, ["/home/u/.opencode/bin/opencode"], other);                       // otra carpeta
  fs.mkdirSync(path.join(proc, "self"));
  expect(findClientPid(proj, proc)).toBe(null);
  fake(13, ["/home/u/.opencode/bin/opencode"], proj);                        // la interfaz
  expect(findClientPid(proj, proc)).toBe(13);
  fake(14, ["opencode", "run", "hola"], proj);                               // otra más: ambiguo
  expect(findClientPid(proj, proc)).toBe(null);
  expect(findClientPid("", proc)).toBe(null);
  expect(findClientPid(proj, "/no/existe")).toBe(null);
});

test("plugin: sin API de eventos devuelve un cierre que no hace nada", async () => {
  expect(plugin.id).toBe("agent-notch");
  const dispose = await plugin.setup({});
  await dispose();
});

test("plugin: consume eventos y al cerrarse borra sus sesiones", async () => {
  process.env.AGENT_NOTCH_DIR = tmp;
  const events = [
    { type: "session.created", data: { sessionID: "ses_9", location: { directory: "/x/proj" } } },
    { type: "session.execution.started", data: { sessionID: "ses_9" } },
  ];
  let release;
  const ctx = {
    session: { get: async () => ({}) },
    event: {
      subscribe: async function* ({ signal }) {
        for (const e of events) yield e;
        await new Promise((r) => { release = r; signal.addEventListener("abort", r); });
      },
    },
  };
  const dispose = await plugin.setup(ctx);
  await new Promise((r) => setTimeout(r, 50));
  expect(read("ses_9").estado).toBe("pensando");
  await dispose();
  expect(files()).toEqual([]);
  delete process.env.AGENT_NOTCH_DIR;
});
