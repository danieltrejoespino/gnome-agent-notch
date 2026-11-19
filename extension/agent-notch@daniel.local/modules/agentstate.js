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

export function sameSummary(a, b) {
    return a === b ||
        (a !== null && b !== null && a.state === b.state && a.title === b.title && a.detail === b.detail);
}
