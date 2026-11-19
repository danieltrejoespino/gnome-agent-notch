// Lógica pura del módulo Docker (docs/19-modulo-docker.md): interpretar la
// respuesta de la API, agrupar por proyecto de Compose y ordenar por
// dependencias. Sin GNOME Shell, para poder probarla con
//     gjs -m scripts/test-dockerstate.js

// Versión fija de la API: la mínima que acepta Docker 29 (✅ 19-11-2026).
export const API_VERSION = 'v1.40';
export const DEFAULT_SOCKET = '/var/run/docker.sock';

// Eventos de contenedor que cambian lo que se ve en la pestaña.
export const EVENTS = ['create', 'destroy', 'start', 'die', 'pause', 'unpause', 'rename'];

const PROJECT = 'com.docker.compose.project';
const SERVICE = 'com.docker.compose.service';
const DEPENDS_ON = 'com.docker.compose.depends_on';
const WORKING_DIR = 'com.docker.compose.project.working_dir';

/** Ruta del socket: DOCKER_HOST=unix://… si lo hay, si no el de siempre. */
export function socketPath(dockerHost) {
    if (dockerHost?.startsWith('unix://') && dockerHost.length > 'unix://'.length)
        return dockerHost.slice('unix://'.length);
    return DEFAULT_SOCKET;
}

/** URL de la API para una ruta («/containers/json»). */
export function apiUrl(path) {
    return `http://docker/${API_VERSION}${path}`;
}

/** URL del flujo de eventos de contenedores. */
export function eventsUrl() {
    const filters = JSON.stringify({type: ['container'], event: EVENTS});
    return apiUrl(`/events?filters=${encodeURIComponent(filters)}`);
}

/** 'jellyfin:service_started:false,db:service_healthy:true' → ['jellyfin', 'db']. */
export function parseDependsOn(label) {
    if (typeof label !== 'string' || !label)
        return [];
    return label.split(',').map(part => part.split(':')[0].trim()).filter(Boolean);
}

/** «En marcha» para la pestaña: lo que hay que detener, no iniciar. */
export function isRunning(state) {
    return state === 'running' || state === 'restarting' || state === 'paused';
}

function publicPorts(ports) {
    if (!Array.isArray(ports))
        return [];
    const set = new Set();
    for (const p of ports) {
        if (Number.isInteger(p?.PublicPort))
            set.add(p.PublicPort);
    }
    return [...set].sort((a, b) => a - b);
}

/**
 * Respuesta de GET /containers/json?all=true (texto) → lista de
 * contenedores normalizada. Lo que no tenga Id ni nombre se descarta.
 */
export function parseContainers(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!Array.isArray(raw))
        return null;

    const out = [];
    for (const c of raw) {
        if (typeof c?.Id !== 'string' || !c.Id)
            continue;
        const name = Array.isArray(c.Names) && typeof c.Names[0] === 'string'
            ? c.Names[0].replace(/^\//, '') : c.Id.slice(0, 12);
        const labels = c.Labels && typeof c.Labels === 'object' ? c.Labels : {};
        out.push({
            id: c.Id,
            name,
            image: typeof c.Image === 'string' ? c.Image : '',
            state: typeof c.State === 'string' ? c.State : 'unknown',
            ports: publicPorts(c.Ports),
            project: typeof labels[PROJECT] === 'string' ? labels[PROJECT] : '',
            service: typeof labels[SERVICE] === 'string' ? labels[SERVICE] : name,
            dependsOn: parseDependsOn(labels[DEPENDS_ON]),
            workingDir: typeof labels[WORKING_DIR] === 'string' ? labels[WORKING_DIR] : '',
        });
    }
    return out;
}

const byName = (a, b) => a.name.localeCompare(b.name);

/**
 * Agrupa por proyecto de Compose: grupos por nombre, y los que no son de
 * Compose (project '') al final. Dentro, por nombre.
 */
export function groupByProject(containers) {
    const map = new Map();
    for (const c of containers) {
        if (!map.has(c.project))
            map.set(c.project, []);
        map.get(c.project).push(c);
    }
    const groups = [...map].map(([project, list]) => ({project, containers: list.sort(byName)}));
    groups.sort((a, b) => {
        if (!a.project !== !b.project)
            return a.project ? -1 : 1;
        return a.project.localeCompare(b.project);
    });
    return groups;
}

/**
 * Orden para iniciar un grupo: antes los servicios de los que dependen
 * otros (depends_on de Compose). Las dependencias fuera de la lista se
 * ignoran. Si hay un ciclo, el resto va por nombre (nunca se cuelga).
 * Para detener, el inverso.
 */
export function startOrder(containers) {
    const pending = [...containers].sort(byName);
    const inList = new Set(pending.map(c => c.service));
    const done = new Set();
    const order = [];
    while (pending.length > 0) {
        const i = pending.findIndex(c =>
            c.dependsOn.every(d => !inList.has(d) || done.has(d) || d === c.service));
        const [next] = pending.splice(i === -1 ? 0 : i, 1);
        order.push(next);
        done.add(next.service);
    }
    return order;
}

/**
 * Qué hace el botón de un grupo: 'start' si hay alguno parado (inicia los
 * que faltan), 'stop' si están todos en marcha.
 */
export function groupAction(containers) {
    return containers.some(c => !isRunning(c.state)) ? 'start' : 'stop';
}

/** Contenedores del grupo a los que afecta la acción, en el orden en que se hace. */
export function groupPlan(containers, action) {
    const order = startOrder(containers);
    if (action === 'start')
        return order.filter(c => !isRunning(c.state));
    return order.reverse().filter(c => isRunning(c.state));
}

/** Texto del estado, en español. */
export function stateText(state) {
    switch (state) {
    case 'running': return 'en marcha';
    case 'restarting': return 'reiniciando';
    case 'paused': return 'en pausa';
    case 'created': return 'creado';
    case 'exited': return 'parado';
    case 'dead': return 'muerto';
    case 'removing': return 'borrando';
    default: return state;
    }
}

/** Puertos publicados como «:8096 :8010». */
export function formatPorts(ports) {
    return ports.map(p => `:${p}`).join(' ');
}

/** Mensaje de error de Docker ({"message": "…"}) o uno genérico con el código. */
export function errorMessage(status, text) {
    try {
        const msg = JSON.parse(text)?.message;
        if (typeof msg === 'string' && msg)
            return msg;
    } catch {
        // No era JSON.
    }
    return `Error ${status}`;
}

/** true si la respuesta a start/stop es un éxito (204 hecho, 304 ya estaba). */
export function actionOk(status) {
    return status === 204 || status === 304;
}
