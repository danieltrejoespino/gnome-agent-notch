// Pruebas de modules/dockerstate.js (lógica pura del módulo Docker).
//     gjs -m scripts/test-dockerstate.js

import System from 'system';

import {
    actionOk, apiUrl, errorMessage, eventsUrl, formatPorts, groupAction, groupByProject,
    groupPlan, isRunning, parseContainers, parseDependsOn, socketPath, startOrder, stateText,
} from '../extension/agent-notch@daniel.local/modules/dockerstate.js';

let failed = 0;
let passed = 0;

function eq(actual, expected, what) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
    } else {
        failed++;
        printerr(`FALLA ${what}\n   obtenido: ${a}\n   esperado: ${e}`);
    }
}

// --- socket y URLs -----------------------------------------------------------
eq(socketPath(null), '/var/run/docker.sock', 'socket por defecto');
eq(socketPath('unix:///run/user/1000/docker.sock'), '/run/user/1000/docker.sock', 'DOCKER_HOST unix');
eq(socketPath('tcp://1.2.3.4:2375'), '/var/run/docker.sock', 'DOCKER_HOST tcp: se ignora');
eq(socketPath('unix://'), '/var/run/docker.sock', 'DOCKER_HOST vacío');
eq(apiUrl('/containers/json'), 'http://docker/v1.40/containers/json', 'url');
eq(decodeURIComponent(eventsUrl().split('filters=')[1]).startsWith('{"type":["container"]'), true, 'filtro de eventos');

// --- depends_on ------------------------------------------------------------------
eq(parseDependsOn('jellyfin:service_started:false'), ['jellyfin'], 'una dependencia');
eq(parseDependsOn('db:service_healthy:true,cache:service_started:false'), ['db', 'cache'], 'varias');
eq(parseDependsOn(''), [], 'vacía');
eq(parseDependsOn(undefined), [], 'sin etiqueta');

// --- lista de la API ---------------------------------------------------------------
const api = [
    {
        Id: 'a1', Names: ['/anime'], Image: 'anime-local', State: 'exited',
        Ports: [{PrivatePort: 8010, PublicPort: 8010, Type: 'tcp', IP: '0.0.0.0'},
            {PrivatePort: 8010, PublicPort: 8010, Type: 'tcp', IP: '::'}],
        Labels: {
            'com.docker.compose.project': 'medios', 'com.docker.compose.service': 'anime',
            'com.docker.compose.depends_on': 'jellyfin:service_started:false',
            'com.docker.compose.project.working_dir': '/home/u/jellyfin',
        },
    },
    {
        Id: 'j1', Names: ['/jellyfin'], Image: 'jellyfin/jellyfin:12.4', State: 'running',
        Ports: [{PrivatePort: 8096, PublicPort: 8096, Type: 'tcp'}, {PrivatePort: 1900, Type: 'udp'}],
        Labels: {'com.docker.compose.project': 'medios', 'com.docker.compose.service': 'jellyfin'},
    },
    {Id: 's1', Names: ['/suelto'], Image: 'nginx', State: 'exited', Ports: [], Labels: {}},
    {Id: 'p1', Names: ['/api-db'], Image: 'postgres', State: 'exited', Labels: {'com.docker.compose.project': 'api'}},
    {Names: ['/sin-id']},
    null,
];
const list = parseContainers(JSON.stringify(api));
eq(list.length, 4, 'descarta los que no tienen Id');
eq(list[0], {
    id: 'a1', name: 'anime', image: 'anime-local', state: 'exited', ports: [8010],
    project: 'medios', service: 'anime', dependsOn: ['jellyfin'], workingDir: '/home/u/jellyfin',
}, 'contenedor completo (puertos sin repetir)');
eq(list[1].ports, [8096], 'solo puertos publicados');
eq(list[2].project, '', 'sin proyecto');
eq(list[2].service, 'suelto', 'sin servicio: el nombre');
eq(list[3].ports, [], 'sin Ports');
eq(parseContainers('no es json'), null, 'JSON roto');
eq(parseContainers('{"message":"x"}'), null, 'no es una lista');
eq(parseContainers('[{"Id":"abcdef0123456789"}]')[0].name, 'abcdef012345', 'sin nombre: Id corto');

// --- grupos ---------------------------------------------------------------------------
const groups = groupByProject(list);
eq(groups.map(g => g.project), ['api', 'medios', ''], 'por nombre, sin proyecto al final');
eq(groups[1].containers.map(c => c.name), ['anime', 'jellyfin'], 'dentro, por nombre');
eq(groupByProject([]), [], 'sin contenedores');

// --- orden de dependencias ------------------------------------------------------------
const C = (service, dependsOn = [], state = 'exited') => ({name: service, service, dependsOn, state});
eq(startOrder([C('anime', ['jellyfin']), C('jellyfin')]).map(c => c.name), ['jellyfin', 'anime'], 'jellyfin antes que anime');
eq(startOrder([C('web', ['api']), C('api', ['db']), C('db')]).map(c => c.name), ['db', 'api', 'web'], 'cadena');
eq(startOrder([C('a', ['b']), C('b', ['a'])]).map(c => c.name), ['a', 'b'], 'ciclo: por nombre, sin colgarse');
eq(startOrder([C('a', ['fuera'])]).map(c => c.name), ['a'], 'dependencia fuera del grupo');
eq(startOrder([C('a', ['a'])]).map(c => c.name), ['a'], 'depende de sí mismo');

// --- botón del grupo --------------------------------------------------------------------
const medios = [C('anime', ['jellyfin']), C('jellyfin')];
eq(groupAction(medios), 'start', 'todo parado: iniciar');
eq(groupPlan(medios, 'start').map(c => c.name), ['jellyfin', 'anime'], 'iniciar en orden');
const mitad = [C('anime', ['jellyfin']), C('jellyfin', [], 'running')];
eq(groupAction(mitad), 'start', 'a medias: iniciar');
eq(groupPlan(mitad, 'start').map(c => c.name), ['anime'], 'solo los que faltan');
const todos = [C('anime', ['jellyfin'], 'running'), C('jellyfin', [], 'running')];
eq(groupAction(todos), 'stop', 'todo en marcha: detener');
eq(groupPlan(todos, 'stop').map(c => c.name), ['anime', 'jellyfin'], 'detener en orden inverso');

// --- textos ------------------------------------------------------------------------------
eq(isRunning('running'), true, 'running');
eq(isRunning('paused'), true, 'paused cuenta como en marcha');
eq(isRunning('exited'), false, 'exited');
eq(stateText('exited'), 'parado', 'texto parado');
eq(stateText('raro'), 'raro', 'estado desconocido');
eq(formatPorts([8010, 8096]), ':8010 :8096', 'puertos');
eq(errorMessage(404, '{"message":"No such container: x"}'), 'No such container: x', 'mensaje de Docker');
eq(errorMessage(500, 'basura'), 'Error 500', 'sin mensaje');
eq(actionOk(204), true, '204');
eq(actionOk(304), true, '304');
eq(actionOk(500), false, '500');

print(`${passed} pruebas OK, ${failed} fallos`);
if (failed)
    System.exit(1);
