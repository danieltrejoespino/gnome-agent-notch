// Pure logic of the Docker module (docs/19-modulo-docker.md): interpret the
// API answer, group by Compose project and sort by
// dependencies. Without GNOME Shell, so it can be tested with
//     gjs -m scripts/test-dockerstate.js

// Fixed API version: the minimum Docker 29 accepts (✅ 19-11-2026).
export const API_VERSION = 'v1.40';
export const DEFAULT_SOCKET = '/var/run/docker.sock';

// Container events that change what is shown in the tab.
export const EVENTS = ['create', 'destroy', 'start', 'die', 'pause', 'unpause', 'rename'];

const PROJECT = 'com.docker.compose.project';
const SERVICE = 'com.docker.compose.service';
const DEPENDS_ON = 'com.docker.compose.depends_on';
const WORKING_DIR = 'com.docker.compose.project.working_dir';

/** Socket path: DOCKER_HOST=unix://… if set, otherwise the usual one. */
export function socketPath(dockerHost) {
    if (dockerHost?.startsWith('unix://') && dockerHost.length > 'unix://'.length)
        return dockerHost.slice('unix://'.length);
    return DEFAULT_SOCKET;
}

/** API URL for a path ("/containers/json"). */
export function apiUrl(path) {
    return `http://docker/${API_VERSION}${path}`;
}

/** URL of the container event stream. */
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

/** "Running" for the tab: what needs stopping, not starting. */
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
 * Answer of GET /containers/json?all=true (text) → normalized list of
 * containers. Anything without an Id or a name is dropped.
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
 * Groups by Compose project: groups by name, and the non-Compose ones
 * (project '') at the end. Inside, by name.
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
 * Order to start a group: first the services others depend on
 * (Compose's depends_on). Dependencies outside the list are
 * ignored. If there is a cycle, the rest goes by name (it never hangs).
 * To stop, the reverse.
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
 * What a group's button does: 'start' if any is stopped (starts the
 * missing ones), 'stop' if they are all running.
 */
export function groupAction(containers) {
    return containers.some(c => !isRunning(c.state)) ? 'start' : 'stop';
}

/** Containers of the group the action affects, in the order it is done. */
export function groupPlan(containers, action) {
    const order = startOrder(containers);
    if (action === 'start')
        return order.filter(c => !isRunning(c.state));
    return order.reverse().filter(c => isRunning(c.state));
}

/** Text of the state. */
export function stateText(state) {
    switch (state) {
    case 'running': return 'running';
    case 'restarting': return 'restarting';
    case 'paused': return 'paused';
    case 'created': return 'created';
    case 'exited': return 'stopped';
    case 'dead': return 'dead';
    case 'removing': return 'removing';
    default: return state;
    }
}

/** Published ports as ":8096 :8010". */
export function formatPorts(ports) {
    return ports.map(p => `:${p}`).join(' ');
}

/** Docker error message ({"message": "…"}) or a generic one with the code. */
export function errorMessage(status, text) {
    try {
        const msg = JSON.parse(text)?.message;
        if (typeof msg === 'string' && msg)
            return msg;
    } catch {
        // It was not JSON.
    }
    return `Error ${status}`;
}

/** true if the answer to start/stop is a success (204 done, 304 already like that). */
export function actionOk(status) {
    return status === 204 || status === 304;
}
