// Tests for modules/dockerstate.js (pure logic of the Docker module).
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
        printerr(`FAIL ${what}\n   got:      ${a}\n   expected: ${e}`);
    }
}

// --- socket and URLs -----------------------------------------------------------
eq(socketPath(null), '/var/run/docker.sock', 'default socket');
eq(socketPath('unix:///run/user/1000/docker.sock'), '/run/user/1000/docker.sock', 'DOCKER_HOST unix');
eq(socketPath('tcp://1.2.3.4:2375'), '/var/run/docker.sock', 'DOCKER_HOST tcp: ignored');
eq(socketPath('unix://'), '/var/run/docker.sock', 'empty DOCKER_HOST');
eq(apiUrl('/containers/json'), 'http://docker/v1.40/containers/json', 'url');
eq(decodeURIComponent(eventsUrl().split('filters=')[1]).startsWith('{"type":["container"]'), true, 'event filter');

// --- depends_on ------------------------------------------------------------------
eq(parseDependsOn('jellyfin:service_started:false'), ['jellyfin'], 'one dependency');
eq(parseDependsOn('db:service_healthy:true,cache:service_started:false'), ['db', 'cache'], 'several');
eq(parseDependsOn(''), [], 'empty');
eq(parseDependsOn(undefined), [], 'no label');

// --- API list ---------------------------------------------------------------
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
eq(list.length, 4, 'drops the ones without Id');
eq(list[0], {
    id: 'a1', name: 'anime', image: 'anime-local', state: 'exited', ports: [8010],
    project: 'medios', service: 'anime', dependsOn: ['jellyfin'], workingDir: '/home/u/jellyfin',
}, 'full container (ports without repeats)');
eq(list[1].ports, [8096], 'only published ports');
eq(list[2].project, '', 'no project');
eq(list[2].service, 'suelto', 'no service: the name');
eq(list[3].ports, [], 'no Ports');
eq(parseContainers('no es json'), null, 'broken JSON');
eq(parseContainers('{"message":"x"}'), null, 'not a list');
eq(parseContainers('[{"Id":"abcdef0123456789"}]')[0].name, 'abcdef012345', 'no name: short Id');

// --- groups ---------------------------------------------------------------------------
const groups = groupByProject(list);
eq(groups.map(g => g.project), ['api', 'medios', ''], 'by name, no project at the end');
eq(groups[1].containers.map(c => c.name), ['anime', 'jellyfin'], 'inside, by name');
eq(groupByProject([]), [], 'no containers');

// --- dependency order ------------------------------------------------------------
const C = (service, dependsOn = [], state = 'exited') => ({name: service, service, dependsOn, state});
eq(startOrder([C('anime', ['jellyfin']), C('jellyfin')]).map(c => c.name), ['jellyfin', 'anime'], 'jellyfin before anime');
eq(startOrder([C('web', ['api']), C('api', ['db']), C('db')]).map(c => c.name), ['db', 'api', 'web'], 'chain');
eq(startOrder([C('a', ['b']), C('b', ['a'])]).map(c => c.name), ['a', 'b'], 'cycle: by name, without hanging');
eq(startOrder([C('a', ['fuera'])]).map(c => c.name), ['a'], 'dependency outside the group');
eq(startOrder([C('a', ['a'])]).map(c => c.name), ['a'], 'depends on itself');

// --- group button --------------------------------------------------------------------
const medios = [C('anime', ['jellyfin']), C('jellyfin')];
eq(groupAction(medios), 'start', 'all stopped: start');
eq(groupPlan(medios, 'start').map(c => c.name), ['jellyfin', 'anime'], 'start in order');
const mitad = [C('anime', ['jellyfin']), C('jellyfin', [], 'running')];
eq(groupAction(mitad), 'start', 'half-way: start');
eq(groupPlan(mitad, 'start').map(c => c.name), ['anime'], 'only the missing ones');
const todos = [C('anime', ['jellyfin'], 'running'), C('jellyfin', [], 'running')];
eq(groupAction(todos), 'stop', 'all running: stop');
eq(groupPlan(todos, 'stop').map(c => c.name), ['anime', 'jellyfin'], 'stop in reverse order');

// --- texts ------------------------------------------------------------------------------
eq(isRunning('running'), true, 'running');
eq(isRunning('paused'), true, 'paused counts as running');
eq(isRunning('exited'), false, 'exited');
eq(stateText('exited'), 'stopped', 'stopped text');
eq(stateText('raro'), 'raro', 'unknown state');
eq(formatPorts([8010, 8096]), ':8010 :8096', 'ports');
eq(errorMessage(404, '{"message":"No such container: x"}'), 'No such container: x', 'Docker message');
eq(errorMessage(500, 'basura'), 'Error 500', 'no message');
eq(actionOk(204), true, '204');
eq(actionOk(304), true, '304');
eq(actionOk(500), false, '500');

print(`${passed} tests OK, ${failed} failures`);
if (failed)
    System.exit(1);
