// Adaptador de OpenCode 2 para agent-notch (docs/08-otros-agentes.md).
//
// Plugin de OpenCode: traduce sus eventos al formato común
// (docs/03-formato-estado.md) y escribe sessions/opencode-<sesion>.json.
// Se instala en ~/.config/opencode/plugins/ (lo hace configure.py).
//
// ✅ Verificado el 19-11-2026 con OpenCode 2.2.6:
//   - El plugin se exporta como {id, setup}; OpenCode llama a setup(ctx) en su
//     SERVICIO de fondo (`opencode serve --service`), no en la terminal, y
//     ese servicio sigue vivo al cerrar OpenCode. El PID útil es el de la
//     INTERFAZ: un proceso `opencode` (sin `serve`) cuya carpeta de trabajo
//     es la de la sesión. Se busca en /proc (findClientPid); si hay dos en la
//     misma carpeta no se sabe cuál es y no se pone (la sesión se da por
//     muerta a los 30 min sin novedades, docs/03). Con ese PID, la isla quita
//     la sesión al cerrar la terminal y el clic la trae al frente.
//   - Eventos: ctx.event.subscribe() → {type, data}. Las sesiones de
//     subagentes traen parentID: no se muestran aparte, su estado de atención
//     sube a la sesión principal.
//
// Reglas (docs/02): nunca romper OpenCode (todo en try/catch), escritura
// atómica, sin contenidos (solo nombres de archivo y comandos recortados).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT = "opencode";
const FORMAT_VERSION = 1;
const MAX_ACTION = 60;
const MAX_COMMAND = 40;
const MAX_PATTERN = 30;
const PID_RETRY_S = 10;

// --- Bus de archivos (como adapters/common/state.py) ------------------------

export function baseDir(env = process.env) {
  if (env.AGENT_NOTCH_DIR) return env.AGENT_NOTCH_DIR;
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && fs.existsSync(runtime)) return path.join(runtime, "agent-notch");
  const cache = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cache, "agent-notch");
}

function ensureDir(dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}

export function safeName(text) {
  const clean = String(text ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return clean || "desconocida";
}

function writeAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// --- Textos (como describe() de hook.py) ------------------------------------

export function clip(text, limit) {
  const t = String(text ?? "").split(/\s+/).filter(Boolean).join(" ");
  return t.length <= limit ? t : t.slice(0, limit - 1).trimEnd() + "…";
}

export function describe(tool, input) {
  const inp = input && typeof input === "object" ? input : {};
  // Al empezar la herramienta aún no hay entrada: texto genérico.
  const known = (v) => typeof v === "string" && v.trim() !== "";
  const name = (p) => path.basename(String(p ?? "").replace(/\/+$/, "")) || "file";
  const file = inp.path ?? inp.filePath ?? inp.file_path;
  switch (String(tool ?? "").toLowerCase()) {
    case "read": return "Reading " + name(file);
    case "edit": case "write": case "patch": case "multiedit": case "apply_patch":
      return "Editing " + name(file);
    case "bash": case "shell":
      return known(inp.command) ? "Running " + clip(inp.command, MAX_COMMAND) : "Running a command";
    case "grep": case "glob": case "search":
      return known(inp.pattern) ? `Searching "${clip(inp.pattern, MAX_PATTERN)}"` : "Searching…";
    case "webfetch": case "websearch": case "fetch": return "Browsing the web";
    case "task": case "subagent": return "Delegating a task";
    default: return "Using " + clip(tool || "tool", 40);
  }
}

// --- PID de la interfaz (la terminal) ----------------------------------------

/**
 * PID del proceso de la interfaz de OpenCode que trabaja en `dir`, o null si
 * no hay ninguno o hay varios (no se sabría cuál es). Lee /proc: solo los
 * procesos del mismo usuario dejan leer su carpeta de trabajo.
 */
export function findClientPid(dir, procRoot = "/proc") {
  if (!dir) return null;
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = fs.readFileSync(path.join(procRoot, name, "cmdline"), "utf8").split("\0");
      if (path.basename(argv[0] ?? "") !== "opencode" || argv[1] === "serve") continue;
      if (fs.readlinkSync(path.join(procRoot, name, "cwd")) !== dir) continue;
      found.push(Number(name));
    } catch {
      // Proceso de otro usuario o que acaba de terminar.
    }
  }
  return found.length === 1 ? found[0] : null;
}

// --- Estado de las sesiones --------------------------------------------------

/**
 * Traduce eventos de OpenCode a archivos de sesión. Sin dependencias de
 * OpenCode: se prueba con eventos falsos (adapters/opencode/test-plugin.mjs).
 */
export class Tracker {
  constructor({ dir = baseDir(), now = () => Date.now() / 1000, findPid = findClientPid } = {}) {
    this.dir = path.join(dir, "sessions");
    this.now = now;
    this.findPid = findPid;         // carpeta → PID de la interfaz, o null
    this.sessions = new Map();      // sesión principal → estado
    this.rootOf = new Map();        // sesión de subagente → principal
  }

  file(sid) {
    return path.join(this.dir, `${AGENT}-${safeName(sid)}.json`);
  }

  root(sid) {
    return this.rootOf.get(sid) ?? sid;
  }

  get(sid, info = {}) {
    let s = this.sessions.get(sid);
    if (!s) {
      const cwd = String(info.directory ?? "");
      s = {
        cwd,
        proyecto: path.basename(cwd.replace(/\/+$/, "")) || "?",
        estado: "inactivo", accion: null, herramienta: null,
        inicio: this.now(), tools: new Map(), written: null,
        pid: null, pidCheckedAt: -Infinity,
      };
      this.sessions.set(sid, s);
    }
    return s;
  }

  set(sid, estado, accion = null, herramienta = null) {
    const s = this.get(sid);
    s.estado = estado;
    s.accion = accion ? clip(accion, MAX_ACTION) : null;
    s.herramienta = herramienta;
    this.write(sid);
  }

  write(sid) {
    const s = this.sessions.get(sid);
    if (!s) return;
    // Buscar la interfaz al crear la sesión y, mientras no se encuentre, como
    // mucho cada 10 s (leer /proc cuesta unos milisegundos).
    if (s.pid === null && this.now() - s.pidCheckedAt >= PID_RETRY_S) {
      s.pidCheckedAt = this.now();
      s.pid = this.findPid(s.cwd);
    }
    const pid = s.pid;
    const data = {
      v: FORMAT_VERSION, agente: AGENT, sesion: safeName(sid),
      proyecto: s.proyecto, cwd: s.cwd,
      estado: s.estado, accion: s.accion, herramienta: s.herramienta,
      inicio: s.inicio, actualizado: this.now(),
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    };
    // Sin cambios (salvo la hora): no reescribir.
    const key = JSON.stringify({ ...data, actualizado: 0 });
    if (key === s.written) return;
    ensureDir(this.dir);
    writeAtomic(this.file(sid), data);
    s.written = key;
  }

  remove(sid) {
    this.sessions.delete(sid);
    try { fs.unlinkSync(this.file(sid)); } catch {}
  }

  removeAll() {
    for (const sid of [...this.sessions.keys()]) this.remove(sid);
  }

  /** Un evento de OpenCode ({type, data}). */
  handle(type, d = {}) {
    const raw = d.sessionID;
    if (!raw) return;

    if (type === "session.created") {
      if (d.parentID) {
        // Subagente: no sale aparte; su principal ya muestra «Delegando tarea».
        this.rootOf.set(raw, this.root(d.parentID));
        return;
      }
      this.get(raw, d.location ?? {});
      this.write(raw);
      return;
    }

    const sid = this.root(raw);
    const isChild = sid !== raw;

    switch (type) {
      case "session.deleted":
        if (isChild) this.rootOf.delete(raw);
        else this.remove(sid);
        return;
      case "session.execution.started":
        if (!isChild) this.set(sid, "pensando", "Thinking…");
        return;
      case "session.tool.input.started": {
        if (isChild) return;
        const s = this.get(sid);
        s.tools.set(d.id, d.name);
        this.set(sid, "trabajando", describe(d.name, null), d.name ?? null);
        return;
      }
      case "session.tool.called": {
        if (isChild) return;
        const s = this.get(sid);
        const name = s.tools.get(d.id);
        this.set(sid, "trabajando", describe(name, d.input), name ?? null);
        return;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        if (isChild) return;
        const s = this.get(sid);
        s.tools.delete(d.id);
        if (s.tools.size === 0 && s.estado !== "atencion") this.set(sid, "pensando", "Thinking…");
        return;
      }
      case "session.execution.succeeded":
        if (!isChild) this.set(sid, "terminado", "Done");
        return;
      case "session.execution.failed":
        if (!isChild) this.set(sid, "error", "Error");
        return;
      case "session.execution.interrupted":
        if (!isChild) this.set(sid, "inactivo");
        return;
      case "permission.asked":
        this.set(sid, "atencion", "Asks permission: " + clip(d.action || "tool", 40));
        return;
      case "form.created":
        this.set(sid, "atencion", "Has a question");
        return;
      case "permission.replied":
      case "form.replied":
      case "form.cancelled":
        if (this.sessions.get(sid)?.estado === "atencion") this.set(sid, "pensando", "Thinking…");
        return;
      default:
    }
  }
}

// --- Plugin -----------------------------------------------------------------

async function setup(ctx) {
  const noop = async () => {};
  try {
    if (typeof ctx?.event?.subscribe !== "function") return noop;
    const tracker = new Tracker();
    const controller = new AbortController();

    const consume = async () => {
      for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) break;
        const data = input?.data ?? {};
        // Sesión que ya existía al cargar el plugin: pedir su carpeta y si es
        // de un subagente, una vez.
        if (data.sessionID && input.type !== "session.created" &&
            !tracker.sessions.has(data.sessionID) && !tracker.rootOf.has(data.sessionID)) {
          try {
            const info = await ctx.session.get({ sessionID: data.sessionID });
            tracker.handle("session.created", {
              sessionID: data.sessionID, parentID: info?.parentID, location: info?.location,
            });
          } catch {}
        }
        try {
          tracker.handle(input.type, data);
        } catch {
          // Un evento raro o un fallo de escritura no debe romper nada.
        }
      }
    };
    const consuming = consume().catch(() => {});

    return async () => {
      try {
        controller.abort();
        await consuming;
      } finally {
        // El servicio se cierra: las sesiones dejan de existir para la isla.
        tracker.removeAll();
      }
    };
  } catch {
    return noop;
  }
}

export default { id: "agent-notch", setup };
