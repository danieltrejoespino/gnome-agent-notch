// Lógica pura del módulo Agentes: validar los archivos de sesión y decidir
// qué mostrar. No depende de GNOME Shell, así que se prueba con gjs:
//     gjs -m scripts/test-agentstate.js
//
// Formato de los archivos: docs/03-formato-estado.md.

export const FORMAT_VERSION = 1;

// De más a menos prioritario (docs/03).
export const STATES = ['atencion', 'error', 'trabajando', 'pensando', 'terminado', 'inactivo'];

// `terminado` se ve como `inactivo` pasados estos segundos (solo visual).
export const DONE_VISIBLE_S = 5;

const STATE_TEXT = {
    atencion: 'Te necesita',
    error: 'Error',
    trabajando: 'Trabajando',
    pensando: 'Pensando…',
    terminado: 'Listo',
    inactivo: 'Esperando',
};

const rank = state => STATES.indexOf(state);

const text = (value, max) => {
    if (typeof value !== 'string')
        return null;
    const clean = value.replace(/\s+/g, ' ').trim();
    if (!clean)
        return null;
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** ¿Es un nombre de archivo de sesión? (los temporales empiezan por punto). */
export function isSessionFile(name) {
    return typeof name === 'string' && !name.startsWith('.') && name.endsWith('.json');
}

/**
 * Texto de un archivo de sesión → sesión normalizada, o null si no vale
 * (JSON roto, otra versión del formato, faltan campos obligatorios…).
 * Los campos desconocidos se ignoran.
 */
export function parseSession(raw) {
    let d;
    try {
        d = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!d || typeof d !== 'object' || Array.isArray(d) || d.v !== FORMAT_VERSION)
        return null;
    if (typeof d.agente !== 'string' || !d.agente || typeof d.sesion !== 'string')
        return null;
    if (!STATES.includes(d.estado))
        return null;
    const actualizado = number(d.actualizado);
    if (actualizado === null)
        return null;

    const pid = number(d.pid);
    return {
        agente: d.agente,
        sesion: d.sesion,
        proyecto: text(d.proyecto, 40) ?? '?',
        cwd: text(d.cwd, 200),   // carpeta, en la pestaña Agentes (docs/09)
        estado: d.estado,
        accion: text(d.accion, 80),
        herramienta: text(d.herramienta, 40),
        inicio: number(d.inicio) ?? actualizado,
        actualizado,
        pid: pid !== null && pid > 0 && Number.isInteger(pid) ? pid : null,
    };
}

/** Estado que se muestra: `terminado` pasa a `inactivo` a los 5 s. */
export function shownState(session, now) {
    if (session.estado === 'terminado' && now - session.actualizado >= DONE_VISIBLE_S)
        return 'inactivo';
    return session.estado;
}

/**
 * Segundos hasta que alguna sesión `terminado` pase a verse como
 * `inactivo`, o null si no hay ninguna pendiente. Para programar UN solo
 * temporizador, y solo mientras haga falta.
 */
export function nextChangeIn(sessions, now) {
    let next = null;
    for (const s of sessions) {
        if (s.estado !== 'terminado')
            continue;
        const left = s.actualizado + DONE_VISIBLE_S - now;
        if (left > 0 && (next === null || left < next))
            next = left;
    }
    return next;
}

function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
}

function groupText(state, n) {
    switch (state) {
    case 'atencion': return plural(n, 'te necesita', 'te necesitan');
    case 'error': return plural(n, 'con error', 'con error');
    case 'trabajando': return plural(n, 'trabajando', 'trabajando');
    case 'pensando': return plural(n, 'pensando', 'pensando');
    case 'terminado': return plural(n, 'listo', 'listos');
    default: return plural(n, 'esperando', 'esperando');
    }
}

/**
 * Qué mostrar en la píldora compacta, o null si no hay nada que mostrar
 * (sin sesiones, o todas esperando).
 *
 *   1 sesión con algo:  {state, title: 'mi-app', detail: 'Editando main.py'}
 *   varias:             {state, title: '3 agentes', detail: '1 te necesita'}
 *
 * `state` es el de mayor prioridad (da el color del punto).
 */
export function summarize(sessions, now) {
    const busy = [];
    for (const s of sessions) {
        const state = shownState(s, now);
        if (state !== 'inactivo')
            busy.push({s, state});
    }
    if (busy.length === 0)
        return null;

    busy.sort((a, b) => rank(a.state) - rank(b.state) ||
        b.s.actualizado - a.s.actualizado);
    const top = busy[0];

    if (busy.length === 1) {
        return {
            state: top.state,
            title: top.s.proyecto,
            detail: top.s.accion ?? STATE_TEXT[top.state],
        };
    }
    const sameState = busy.filter(b => b.state === top.state).length;
    return {
        state: top.state,
        title: `${busy.length} agentes`,
        detail: groupText(top.state, sameState),
    };
}

/**
 * Resumen de todas las sesiones, para la tarjeta de Home (título + detalle)
 * y la cabecera de la pestaña (`text`) (docs/09, revisión del 19-11-2026):
 *   ninguna: {state: null, title: 'Agentes', detail: 'Ninguno en marcha', text: 'Ninguno en marcha'}
 *   una:     {state: 'trabajando', title: '1 agente', detail: 'trabajando', text: '1 agente · trabajando'}
 *   varias:  {state: 'atencion', title: '3 agentes', detail: '1 te necesita · 2 esperando', text: …}
 * `state` es el de mayor prioridad (da la expresión y el color de los ojos).
 */
export function overview(sessions, now) {
    if (sessions.length === 0)
        return {state: null, title: 'Agentes', detail: 'Ninguno en marcha', text: 'Ninguno en marcha'};
    const counts = new Map();
    for (const s of sessions) {
        const state = shownState(s, now);
        counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    const states = [...counts.keys()].sort((a, b) => rank(a) - rank(b));
    const title = plural(sessions.length, 'agente', 'agentes');
    const detail = sessions.length === 1
        ? groupText(states[0], 1).replace(/^1 /, '')
        : states.map(st => groupText(st, counts.get(st))).join(' · ');
    return {state: states[0], title, detail, text: `${title} · ${detail}`};
}

/** '/home/ana/proyectos/x' con home '/home/ana' → '~/proyectos/x'. */
export function shortPath(cwd, home) {
    if (typeof cwd !== 'string' || !cwd)
        return '';
    const h = typeof home === 'string' ? home.replace(/\/+$/, '') : '';
    if (h && cwd === h)
        return '~';
    if (h && cwd.startsWith(`${h}/`))
        return `~${cwd.slice(h.length)}`;
    return cwd;
}

export function sameSummary(a, b) {
    return a === b ||
        (a !== null && b !== null && a.state === b.state && a.title === b.title && a.detail === b.detail);
}

// --- Vista expandida (paso 6) --------------------------------------------

export const STALE_S = 30 * 60;

// Etiqueta de cada agente en las filas (paso 15, decidido el 19-11-2026):
// nombre corto y un tinte propio (clase CSS `agente-<tinte>`). Los que no
// están aquí salen con su nombre tal cual y el tinte neutro `otro`.
const AGENT_LABELS = {
    'claude-code': {name: 'Claude', tint: 'claude'},
    'opencode': {name: 'OpenCode', tint: 'opencode'},
    'codex': {name: 'Codex', tint: 'otro'},
    'gemini-cli': {name: 'Gemini', tint: 'otro'},
};
export const AGENT_TINTS = ['claude', 'opencode', 'otro'];
const AGENT_NAME_MAX = 12;

/** 'claude-code' → {name: 'Claude', tint: 'claude'}; desconocido → su nombre, tinte 'otro'. */
export function agentLabel(agente) {
    if (Object.hasOwn(AGENT_LABELS, agente))
        return AGENT_LABELS[agente];
    const name = String(agente ?? '').trim() || '?';
    return {
        name: name.length > AGENT_NAME_MAX ? `${name.slice(0, AGENT_NAME_MAX - 1)}…` : name,
        tint: 'otro',
    };
}

// Ojos con expresión (docs/09, aprobado el 19-11-2026): la forma de los ojos
// que sustituyen al punto en la compacta. Las expresiones las dibuja `Eyes`
// (widgets.js).
export const EYE_EXPRESSIONS = ['abiertos', 'entornados', 'arriba', 'derecha', 'muy-abiertos', 'contentos', 'error'];
const STATE_EYES = {
    pensando: 'arriba',
    trabajando: 'derecha',
    atencion: 'muy-abiertos',
    terminado: 'contentos',
    error: 'error',
    inactivo: 'abiertos',
};

/** Estado → expresión de los ojos; desconocido → 'abiertos'. */
export function eyesFor(state) {
    return Object.hasOwn(STATE_EYES, state) ? STATE_EYES[state] : 'abiertos';
}

/** Texto corto de cada estado, para las filas sin `accion`. */
export function stateText(state) {
    return STATE_TEXT[state] ?? state;
}

/**
 * ¿Está muerta? (docs/03, con un matiz decidido el 19-11-2026)
 *   - Con `pid`: muerta solo si ese proceso ya no existe. Un Claude Code
 *     abierto y esperando una hora sigue vivo: no se quita.
 *   - Sin `pid`: muerta si lleva más de 30 min sin novedades y no está
 *     pidiendo atención.
 * `pidAlive(pid)` lo da quien llama (en GNOME: existe /proc/<pid>).
 */
export function isDead(session, now, pidAlive) {
    if (session.pid !== null)
        return !pidAlive(session.pid);
    return session.estado !== 'atencion' && now - session.actualizado > STALE_S;
}

/** Sesiones para la lista: primero las de estado más prioritario, luego las más recientes. */
export function sortSessions(sessions, now) {
    return [...sessions].sort((a, b) =>
        rank(shownState(a, now)) - rank(shownState(b, now)) ||
        b.actualizado - a.actualizado);
}

/** Tiempo desde que empezó la sesión: «<1 min», «12 min», «1 h 05». */
export function formatAge(seconds) {
    const m = Math.floor(Math.max(0, seconds) / 60);
    if (m < 1)
        return '<1 min';
    if (m < 60)
        return `${m} min`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** PID del padre a partir del contenido de /proc/<pid>/stat, o null. */
export function parentPid(statText) {
    // «pid (comm) estado ppid …»: comm puede llevar espacios y paréntesis,
    // así que se corta tras el ÚLTIMO «)».
    const rest = statText.slice(statText.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ppid = Number(rest[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

/**
 * Ventana de la terminal de una sesión, o null si no se sabe con certeza.
 *
 *   ancestors: PIDs desde el agente hacia arriba (el agente, su shell, la
 *              terminal…), el más cercano primero.
 *   windows:   [{pid, title, window}] de las ventanas normales abiertas.
 *
 * Se busca el ancestro más cercano que tenga ventanas. Si tiene una, es
 * esa. Si tiene varias (GNOME Terminal y Ptyxis usan un solo proceso para
 * todas), solo vale si exactamente una lleva el nombre del proyecto en el
 * título; si no, null: mejor no hacer nada que traer la ventana equivocada.
 */
export function pickWindow(ancestors, windows, project) {
    for (const pid of ancestors) {
        const mine = windows.filter(w => w.pid === pid);
        if (mine.length === 0)
            continue;
        if (mine.length === 1)
            return mine[0].window;
        const byTitle = project && project !== '?'
            ? mine.filter(w => (w.title ?? '').includes(project))
            : [];
        return byTitle.length === 1 ? byTitle[0].window : null;
    }
    return null;
}
