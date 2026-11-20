// Pure logic of the Agents module: validate the session files and decide
// what to show. It does not depend on GNOME Shell, so it is tested with gjs:
//     gjs -m scripts/test-agentstate.js
//
// File format: docs/03-formato-estado.md.

export const FORMAT_VERSION = 1;

// From highest to lowest priority (docs/03).
export const STATES = ['atencion', 'error', 'trabajando', 'pensando', 'terminado', 'inactivo'];

// `terminado` shows as `inactivo` after these seconds (visual only).
export const DONE_VISIBLE_S = 5;

const STATE_TEXT = {
    atencion: 'Needs you',
    error: 'Error',
    trabajando: 'Working',
    pensando: 'Thinking…',
    terminado: 'Done',
    inactivo: 'Waiting',
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

/** Is it a session file name? (temporary files start with a dot). */
export function isSessionFile(name) {
    return typeof name === 'string' && !name.startsWith('.') && name.endsWith('.json');
}

/**
 * Session file text → normalized session, or null if it is not valid
 * (broken JSON, another format version, required fields missing…).
 * Unknown fields are ignored.
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
        cwd: text(d.cwd, 200),   // folder, in the Agents tab (docs/09)
        estado: d.estado,
        accion: text(d.accion, 80),
        herramienta: text(d.herramienta, 40),
        inicio: number(d.inicio) ?? actualizado,
        actualizado,
        pid: pid !== null && pid > 0 && Number.isInteger(pid) ? pid : null,
    };
}

/** State shown: `terminado` turns into `inactivo` after 5 s. */
export function shownState(session, now) {
    if (session.estado === 'terminado' && now - session.actualizado >= DONE_VISIBLE_S)
        return 'inactivo';
    return session.estado;
}

/**
 * Seconds until some `terminado` session starts showing as
 * `inactivo`, or null if none is pending. To schedule ONE single
 * timer, and only while needed.
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
    case 'atencion': return plural(n, 'needs you', 'need you');
    case 'error': return plural(n, 'with an error', 'with errors');
    case 'trabajando': return plural(n, 'working', 'working');
    case 'pensando': return plural(n, 'thinking', 'thinking');
    case 'terminado': return plural(n, 'done', 'done');
    default: return plural(n, 'waiting', 'waiting');
    }
}

/**
 * What to show in the compact pill, or null if there is nothing to show
 * (no sessions, or all waiting).
 *
 *   1 session doing something: {state, title: 'my-app', detail: 'Editing main.py'}
 *   several:                   {state, title: '3 agents', detail: '1 needs you'}
 *
 * `state` is the highest-priority one (it gives the dot's color).
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
        title: `${busy.length} agents`,
        detail: groupText(top.state, sameState),
    };
}

/**
 * Summary of all sessions, for the Home card (title + detail)
 * and the tab header (`text`) (docs/09, review of 19-11-2026):
 *   none:    {state: null, title: 'Agents', detail: 'None running', text: 'None running'}
 *   one:     {state: 'trabajando', title: '1 agent', detail: 'working', text: '1 agent · working'}
 *   several: {state: 'atencion', title: '3 agents', detail: '1 needs you · 2 waiting', text: …}
 * `state` is the highest-priority one (it gives the eyes' expression and color).
 */
export function overview(sessions, now) {
    if (sessions.length === 0)
        return {state: null, title: 'Agents', detail: 'None running', text: 'None running'};
    const counts = new Map();
    for (const s of sessions) {
        const state = shownState(s, now);
        counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    const states = [...counts.keys()].sort((a, b) => rank(a) - rank(b));
    const title = plural(sessions.length, 'agent', 'agents');
    const detail = sessions.length === 1
        ? groupText(states[0], 1).replace(/^1 /, '')
        : states.map(st => groupText(st, counts.get(st))).join(' · ');
    return {state: states[0], title, detail, text: `${title} · ${detail}`};
}

/** '/home/ana/projects/x' with home '/home/ana' → '~/projects/x'. */
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

// --- Expanded view (step 6) --------------------------------------------

export const STALE_S = 30 * 60;

// Label of each agent in the rows (step 15, decided on 19-11-2026):
// short name and a tint of its own (CSS class `agente-<tinte>`). Those not
// listed here show their name as is and the neutral tint `otro`.
const AGENT_LABELS = {
    'claude-code': {name: 'Claude', tint: 'claude'},
    'opencode': {name: 'OpenCode', tint: 'opencode'},
    'codex': {name: 'Codex', tint: 'otro'},
    'gemini-cli': {name: 'Gemini', tint: 'otro'},
};
export const AGENT_TINTS = ['claude', 'opencode', 'otro'];
const AGENT_NAME_MAX = 12;

/** 'claude-code' → {name: 'Claude', tint: 'claude'}; unknown → its name, tint 'otro'. */
export function agentLabel(agente) {
    if (Object.hasOwn(AGENT_LABELS, agente))
        return AGENT_LABELS[agente];
    const name = String(agente ?? '').trim() || '?';
    return {
        name: name.length > AGENT_NAME_MAX ? `${name.slice(0, AGENT_NAME_MAX - 1)}…` : name,
        tint: 'otro',
    };
}

// Eyes with expression (docs/09, approved on 19-11-2026): the shape of the eyes
// that replace the dot in the compact view. The expressions are drawn by `Eyes`
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

/** State → expression of the eyes; unknown → 'abiertos'. */
export function eyesFor(state) {
    return Object.hasOwn(STATE_EYES, state) ? STATE_EYES[state] : 'abiertos';
}

/** Short text for each state, for rows without `accion`. */
export function stateText(state) {
    return STATE_TEXT[state] ?? state;
}

/**
 * Is it dead? (docs/03, with a nuance decided on 19-11-2026)
 *   - With `pid`: dead only if that process no longer exists. A Claude Code
 *     open and waiting for an hour is still alive: it is not removed.
 *   - Without `pid`: dead if it has gone more than 30 min without news and is not
 *     asking for attention.
 * `pidAlive(pid)` is given by the caller (in GNOME: /proc/<pid> exists).
 */
export function isDead(session, now, pidAlive) {
    if (session.pid !== null)
        return !pidAlive(session.pid);
    return session.estado !== 'atencion' && now - session.actualizado > STALE_S;
}

/** Sessions for the list: first those with the highest-priority state, then the most recent. */
export function sortSessions(sessions, now) {
    return [...sessions].sort((a, b) =>
        rank(shownState(a, now)) - rank(shownState(b, now)) ||
        b.actualizado - a.actualizado);
}

/** Time since the session started: "<1 min", "12 min", "1 h 05". */
export function formatAge(seconds) {
    const m = Math.floor(Math.max(0, seconds) / 60);
    if (m < 1)
        return '<1 min';
    if (m < 60)
        return `${m} min`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** Parent PID from the contents of /proc/<pid>/stat, or null. */
export function parentPid(statText) {
    // "pid (comm) state ppid …": comm can contain spaces and parentheses,
    // so it is cut after the LAST ")".
    const rest = statText.slice(statText.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ppid = Number(rest[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

/**
 * Terminal window of a session, or null if it is not known for sure.
 *
 *   ancestors: PIDs from the agent upwards (the agent, its shell, the
 *              terminal…), the closest first.
 *   windows:   [{pid, title, window}] of the normal windows open.
 *
 * It looks for the closest ancestor that has windows. If it has one, it is
 * that one. If it has several (GNOME Terminal and Ptyxis use a single process for
 * all of them), it only counts if exactly one has the project name in its
 * title; otherwise null: better do nothing than bring the wrong window.
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
