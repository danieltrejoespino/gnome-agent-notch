// Tests for modules/agentstate.js (pure logic of the Agents module).
//     gjs -m scripts/test-agentstate.js

import System from 'system';

import {
    AGENT_TINTS, EYE_EXPRESSIONS, STATES, agentLabel, eyesFor, overview, shortPath, formatAge, isDead, isSessionFile, nextChangeIn, parentPid, parseSession, pickWindow,
    sameSummary, shownState, sortSessions, summarize,
} from '../extension/agent-notch@daniel.local/modules/agentstate.js';

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

const NOW = 1_800_000_000;
const base = {
    v: 1, agente: 'claude-code', sesion: 's1', proyecto: 'mi-app', cwd: '/x/mi-app',
    estado: 'trabajando', accion: 'Editando main.py', herramienta: 'Edit',
    inicio: NOW - 60, actualizado: NOW - 1, pid: 1234,
};
const raw = over => JSON.stringify({...base, ...over});
const sess = over => parseSession(raw(over));

// --- file names ---------------------------------------------------
eq(isSessionFile('claude-code-abc.json'), true, 'normal file');
eq(isSessionFile('.claude-code-abc.json.123.tmp'), false, 'hidden temporary');
eq(isSessionFile('.oculto.json'), false, 'hidden .json');
eq(isSessionFile('x.json.tmp'), false, 'old temporary');
eq(isSessionFile(null), false, 'null');

// --- validation -----------------------------------------------------------
eq(sess({}).proyecto, 'mi-app', 'valid session');
eq(sess({}).pid, 1234, 'pid');
for (const [what, text] of [
    ['JSON roto', '{a'], ['vacío', ''], ['lista', '[1]'], ['null', 'null'],
    ['versión 2', raw({v: 2})], ['sin versión', raw({v: undefined})],
    ['estado raro', raw({estado: 'bailando'})], ['sin agente', raw({agente: ''})],
    ['sesion no texto', raw({sesion: 5})], ['sin actualizado', raw({actualizado: 'ayer'})],
])
    eq(parseSession(text), null, `rechaza: ${what}`);
eq(sess({campoNuevo: 1, otro: {a: 1}}) !== null, true, 'ignores unknown fields');
eq(sess({proyecto: ''}).proyecto, '?', 'empty project → ?');
eq(sess({accion: null}).accion, null, 'null action');
eq(sess({accion: '  a \n b  '}).accion, 'a b', 'action on one line');
eq(sess({accion: 'x'.repeat(200)}).accion.length, 80, 'trimmed action');
eq(sess({pid: -3}).pid, null, 'negative pid');
eq(sess({pid: 1.5}).pid, null, 'non-integer pid');
eq(sess({inicio: undefined}).inicio, NOW - 1, 'no inicio → actualizado');

// --- terminado → inactivo after 5 s --------------------------------------
eq(shownState(sess({estado: 'terminado', actualizado: NOW - 2}), NOW), 'terminado', 'recently finished');
eq(shownState(sess({estado: 'terminado', actualizado: NOW - 5}), NOW), 'inactivo', 'finished after 5 s');
eq(nextChangeIn([sess({estado: 'terminado', actualizado: NOW - 2})], NOW), 3, '3 s left');
eq(nextChangeIn([sess({estado: 'terminado', actualizado: NOW - 9}), sess({})], NOW), null, 'nothing pending');
eq(nextChangeIn([
    sess({estado: 'terminado', actualizado: NOW - 1}),
    sess({estado: 'terminado', actualizado: NOW - 4}),
], NOW), 1, 'the closest one');

// --- summary for the compact view --------------------------------------------
eq(summarize([], NOW), null, 'no sessions');
eq(summarize([sess({estado: 'inactivo'})], NOW), null, 'only waiting');
eq(summarize([sess({})], NOW),
    {state: 'trabajando', title: 'mi-app', detail: 'Editando main.py'}, 'one working');
eq(summarize([sess({estado: 'pensando', accion: null})], NOW),
    {state: 'pensando', title: 'mi-app', detail: 'Thinking…'}, 'no action → state text');
eq(summarize([sess({}), sess({sesion: 's2', proyecto: 'blog', estado: 'inactivo'})], NOW),
    {state: 'trabajando', title: 'mi-app', detail: 'Editando main.py'}, 'one busy and one waiting');
eq(summarize([
    sess({}),
    sess({sesion: 's2', proyecto: 'blog', estado: 'atencion', accion: 'Pide permiso: Bash'}),
    sess({sesion: 's3', proyecto: 'api', estado: 'pensando'}),
], NOW), {state: 'atencion', title: '3 agents', detail: '1 needs you'}, 'several, one asks for attention');
eq(summarize([
    sess({estado: 'atencion'}), sess({sesion: 's2', estado: 'atencion'}),
], NOW).detail, '2 need you', 'plural');
eq(summarize([
    sess({}), sess({sesion: 's2', estado: 'error'}),
], NOW).state, 'error', 'error beats working');
eq(summarize([
    sess({estado: 'terminado', actualizado: NOW - 1}), sess({sesion: 's2', estado: 'terminado', actualizado: NOW - 2}),
], NOW).detail, '2 done', 'two finished');
eq(summarize([sess({estado: 'terminado', actualizado: NOW - 30})], NOW), null, 'finished a while ago');

// --- comparing summaries ---------------------------------------------------
const a = {state: 'trabajando', title: 'x', detail: 'y'};
eq(sameSummary(a, {...a}), true, 'equal');
eq(sameSummary(a, {...a, detail: 'z'}), false, 'different detail');
eq(sameSummary(null, null), true, 'null and null');
eq(sameSummary(a, null), false, 'something and null');

// --- dead sessions (step 6) -------------------------------------------
const alive = new Set([1234]);
const pidAlive = p => alive.has(p);
eq(isDead(sess({}), NOW, pidAlive), false, 'live pid');
eq(isDead(sess({pid: 999}), NOW, pidAlive), true, 'dead pid');
eq(isDead(sess({actualizado: NOW - 7200, estado: 'inactivo'}), NOW, pidAlive), false, 'live pid and 2 h waiting: stays');
eq(isDead(sess({pid: null, actualizado: NOW - 31 * 60}), NOW, pidAlive), true, 'no pid and 31 min');
eq(isDead(sess({pid: null, actualizado: NOW - 29 * 60}), NOW, pidAlive), false, 'no pid and 29 min');
eq(isDead(sess({pid: null, estado: 'atencion', actualizado: NOW - 7200}), NOW, pidAlive), false, 'no pid but attention');

// --- order and times -------------------------------------------------------
eq(sortSessions([
    sess({sesion: 'a', estado: 'inactivo'}),
    sess({sesion: 'b', estado: 'atencion'}),
    sess({sesion: 'c', estado: 'trabajando', actualizado: NOW - 50}),
    sess({sesion: 'd', estado: 'trabajando', actualizado: NOW - 5}),
    sess({sesion: 'e', estado: 'terminado', actualizado: NOW - 60}),
], NOW).map(s => s.sesion), ['b', 'd', 'c', 'a', 'e'], 'list order (old terminado = inactivo)');
eq([0, 59, 60, 12 * 60 + 5, 3600, 3600 + 5 * 60, -5].map(formatAge),
    ['<1 min', '<1 min', '1 min', '12 min', '1 h 00', '1 h 05', '<1 min'], 'formatAge');

// --- /proc/<pid>/stat ------------------------------------------------------
eq(parentPid('4321 (claude) S 4300 4321 4300 0 -1'), 4300, 'simple ppid');
eq(parentPid('77 (mi (raro) prog) R 12 77 77'), 12, 'comm with spaces and parentheses');
eq(parentPid('basura'), null, 'broken stat');

// --- terminal window ------------------------------------------------
const W = (pid, title, id) => ({pid, title, window: id});
// claude 300 → bash 200 → terminal 100
eq(pickWindow([300, 200, 100], [W(100, 'mi-app — Kitty', 'k'), W(50, 'Firefox', 'f')], 'mi-app'), 'k', 'one terminal window');
eq(pickWindow([300, 200, 100], [W(100, 'usuario@pc: ~/blog', 'a'), W(100, 'usuario@pc: ~/mi-app', 'b')], 'mi-app'), 'b', 'several: the title decides');
eq(pickWindow([300, 200, 100], [W(100, 'Terminal', 'a'), W(100, 'Terminal', 'b')], 'mi-app'), null, 'several without a hint: nothing');
eq(pickWindow([300, 200, 100], [W(100, 'mi-app 1', 'a'), W(100, 'mi-app 2', 'b')], 'mi-app'), null, 'several with the same project: nothing');
eq(pickWindow([300, 200, 100], [W(200, 'x', 'cerca'), W(100, 'mi-app', 'lejos')], 'mi-app'), 'cerca', 'the closest ancestor wins');
eq(pickWindow([300, 200, 100], [W(50, 'mi-app', 'otra')], 'mi-app'), null, 'window of another process: nothing');
eq(pickWindow([300], [W(1, 'a', 'x'), W(1, 'b', 'y')], '?'), null, 'no project');

// --- agent label (step 15) -----------------------------------------
eq(agentLabel('claude-code'), {name: 'Claude', tint: 'claude'}, 'Claude Code');
eq(agentLabel('opencode'), {name: 'OpenCode', tint: 'opencode'}, 'OpenCode');
eq(agentLabel('gemini-cli'), {name: 'Gemini', tint: 'otro'}, 'known without its own tint');
eq(agentLabel('simulador'), {name: 'simulador', tint: 'otro'}, 'unknown: its name');
eq(agentLabel('un-agente-muy-largo'), {name: 'un-agente-m…', tint: 'otro'}, 'long name trimmed');
eq(agentLabel('  '), {name: '?', tint: 'otro'}, 'empty');
eq(agentLabel('toString'), {name: 'toString', tint: 'otro'}, 'does not mistake inherited properties');
eq(AGENT_TINTS.includes(agentLabel('cualquiera').tint), true, 'the tint is always a known one');

// --- eyes with expression (docs/09) --------------------------------------------
eq(eyesFor('pensando'), 'arriba', 'pensando: looking up');
eq(eyesFor('trabajando'), 'derecha', 'trabajando: looking at the text');
eq(eyesFor('atencion'), 'muy-abiertos', 'atencion: wide open');
eq(eyesFor('terminado'), 'contentos', 'terminado: happy');
eq(eyesFor('error'), 'error', 'error: × ×');
eq(eyesFor('inactivo'), 'abiertos', 'inactivo: open');
eq(eyesFor('raro'), 'abiertos', 'unknown: open');
eq(eyesFor('toString'), 'abiertos', 'does not mistake inherited properties');
eq(STATES.every(s => EYE_EXPRESSIONS.includes(eyesFor(s))), true, 'every state has a drawable expression');

// --- summary and folder (design review, docs/09) ---------------------------
eq(overview([], NOW), {state: null, title: 'Agents', detail: 'None running', text: 'None running'}, 'summary: none');
eq(overview([base], NOW), {state: 'trabajando', title: '1 agent', detail: 'working', text: '1 agent · working'}, 'summary: one');
eq(overview([{...base, estado: 'inactivo'}], NOW).text, '1 agent · waiting', 'summary: one waiting');
eq(overview([base, {...base, sesion: 's2', estado: 'inactivo'}, {...base, sesion: 's3', estado: 'atencion'}], NOW),
    {state: 'atencion', title: '3 agents', detail: '1 needs you · 1 working · 1 waiting',
        text: '3 agents · 1 needs you · 1 working · 1 waiting'}, 'summary: several, by priority');
eq(overview([base, {...base, sesion: 's2'}], NOW).text, '2 agents · 2 working', 'summary: same state');
eq(overview([{...base, estado: 'terminado', actualizado: NOW - 60}], NOW).state, 'inactivo', 'summary: terminado a while ago counts as waiting');
eq(parseSession(JSON.stringify(base)).cwd, '/x/mi-app', 'the session keeps the folder');
eq(parseSession(JSON.stringify({...base, cwd: 3})).cwd, null, 'folder that is not text');
eq(shortPath('/home/ana/proyectos/x', '/home/ana'), '~/proyectos/x', 'folder under home');
eq(shortPath('/home/ana', '/home/ana/'), '~', 'home itself');
eq(shortPath('/home/anabel/x', '/home/ana'), '/home/anabel/x', 'does not mistake prefixes');
eq(shortPath('/srv/x', '/home/ana'), '/srv/x', 'outside home');
eq(shortPath(null, '/home/ana'), '', 'no folder');

print(`${passed} tests OK, ${failed} failures`);
if (failed)
    System.exit(1);
