// Pruebas de modules/agentstate.js (lógica pura del módulo Agentes).
//     gjs -m scripts/test-agentstate.js

import System from 'system';

import {
    formatAge, isDead, isSessionFile, nextChangeIn, parentPid, parseSession, pickWindow,
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
        printerr(`FALLA ${what}\n   obtenido: ${a}\n   esperado: ${e}`);
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

// --- nombres de archivo ---------------------------------------------------
eq(isSessionFile('claude-code-abc.json'), true, 'archivo normal');
eq(isSessionFile('.claude-code-abc.json.123.tmp'), false, 'temporal oculto');
eq(isSessionFile('.oculto.json'), false, 'oculto .json');
eq(isSessionFile('x.json.tmp'), false, 'temporal viejo');
eq(isSessionFile(null), false, 'null');

// --- validación -----------------------------------------------------------
eq(sess({}).proyecto, 'mi-app', 'sesión válida');
eq(sess({}).pid, 1234, 'pid');
for (const [what, text] of [
    ['JSON roto', '{a'], ['vacío', ''], ['lista', '[1]'], ['null', 'null'],
    ['versión 2', raw({v: 2})], ['sin versión', raw({v: undefined})],
    ['estado raro', raw({estado: 'bailando'})], ['sin agente', raw({agente: ''})],
    ['sesion no texto', raw({sesion: 5})], ['sin actualizado', raw({actualizado: 'ayer'})],
])
    eq(parseSession(text), null, `rechaza: ${what}`);
eq(sess({campoNuevo: 1, otro: {a: 1}}) !== null, true, 'ignora campos desconocidos');
eq(sess({proyecto: ''}).proyecto, '?', 'proyecto vacío → ?');
eq(sess({accion: null}).accion, null, 'acción null');
eq(sess({accion: '  a \n b  '}).accion, 'a b', 'acción en una línea');
eq(sess({accion: 'x'.repeat(200)}).accion.length, 80, 'acción recortada');
eq(sess({pid: -3}).pid, null, 'pid negativo');
eq(sess({pid: 1.5}).pid, null, 'pid no entero');
eq(sess({inicio: undefined}).inicio, NOW - 1, 'sin inicio → actualizado');

// --- terminado → inactivo a los 5 s --------------------------------------
eq(shownState(sess({estado: 'terminado', actualizado: NOW - 2}), NOW), 'terminado', 'terminado reciente');
eq(shownState(sess({estado: 'terminado', actualizado: NOW - 5}), NOW), 'inactivo', 'terminado a los 5 s');
eq(nextChangeIn([sess({estado: 'terminado', actualizado: NOW - 2})], NOW), 3, 'faltan 3 s');
eq(nextChangeIn([sess({estado: 'terminado', actualizado: NOW - 9}), sess({})], NOW), null, 'nada pendiente');
eq(nextChangeIn([
    sess({estado: 'terminado', actualizado: NOW - 1}),
    sess({estado: 'terminado', actualizado: NOW - 4}),
], NOW), 1, 'el más cercano');

// --- resumen para la compacta --------------------------------------------
eq(summarize([], NOW), null, 'sin sesiones');
eq(summarize([sess({estado: 'inactivo'})], NOW), null, 'solo esperando');
eq(summarize([sess({})], NOW),
    {state: 'trabajando', title: 'mi-app', detail: 'Editando main.py'}, 'una trabajando');
eq(summarize([sess({estado: 'pensando', accion: null})], NOW),
    {state: 'pensando', title: 'mi-app', detail: 'Pensando…'}, 'sin acción → texto del estado');
eq(summarize([sess({}), sess({sesion: 's2', proyecto: 'blog', estado: 'inactivo'})], NOW),
    {state: 'trabajando', title: 'mi-app', detail: 'Editando main.py'}, 'una ocupada y otra esperando');
eq(summarize([
    sess({}),
    sess({sesion: 's2', proyecto: 'blog', estado: 'atencion', accion: 'Pide permiso: Bash'}),
    sess({sesion: 's3', proyecto: 'api', estado: 'pensando'}),
], NOW), {state: 'atencion', title: '3 agentes', detail: '1 te necesita'}, 'varias, una pide atención');
eq(summarize([
    sess({estado: 'atencion'}), sess({sesion: 's2', estado: 'atencion'}),
], NOW).detail, '2 te necesitan', 'plural');
eq(summarize([
    sess({}), sess({sesion: 's2', estado: 'error'}),
], NOW).state, 'error', 'error gana a trabajando');
eq(summarize([
    sess({estado: 'terminado', actualizado: NOW - 1}), sess({sesion: 's2', estado: 'terminado', actualizado: NOW - 2}),
], NOW).detail, '2 listos', 'dos terminadas');
eq(summarize([sess({estado: 'terminado', actualizado: NOW - 30})], NOW), null, 'terminada hace rato');

// --- comparar resúmenes ---------------------------------------------------
const a = {state: 'trabajando', title: 'x', detail: 'y'};
eq(sameSummary(a, {...a}), true, 'iguales');
eq(sameSummary(a, {...a, detail: 'z'}), false, 'distinto detalle');
eq(sameSummary(null, null), true, 'null y null');
eq(sameSummary(a, null), false, 'algo y null');

// --- sesiones muertas (paso 6) -------------------------------------------
const alive = new Set([1234]);
const pidAlive = p => alive.has(p);
eq(isDead(sess({}), NOW, pidAlive), false, 'pid vivo');
eq(isDead(sess({pid: 999}), NOW, pidAlive), true, 'pid muerto');
eq(isDead(sess({actualizado: NOW - 7200, estado: 'inactivo'}), NOW, pidAlive), false, 'pid vivo y 2 h esperando: sigue');
eq(isDead(sess({pid: null, actualizado: NOW - 31 * 60}), NOW, pidAlive), true, 'sin pid y 31 min');
eq(isDead(sess({pid: null, actualizado: NOW - 29 * 60}), NOW, pidAlive), false, 'sin pid y 29 min');
eq(isDead(sess({pid: null, estado: 'atencion', actualizado: NOW - 7200}), NOW, pidAlive), false, 'sin pid pero atención');

// --- orden y tiempos -------------------------------------------------------
eq(sortSessions([
    sess({sesion: 'a', estado: 'inactivo'}),
    sess({sesion: 'b', estado: 'atencion'}),
    sess({sesion: 'c', estado: 'trabajando', actualizado: NOW - 50}),
    sess({sesion: 'd', estado: 'trabajando', actualizado: NOW - 5}),
    sess({sesion: 'e', estado: 'terminado', actualizado: NOW - 60}),
], NOW).map(s => s.sesion), ['b', 'd', 'c', 'a', 'e'], 'orden de la lista (terminado viejo = inactivo)');
eq([0, 59, 60, 12 * 60 + 5, 3600, 3600 + 5 * 60, -5].map(formatAge),
    ['<1 min', '<1 min', '1 min', '12 min', '1 h 00', '1 h 05', '<1 min'], 'formatAge');

// --- /proc/<pid>/stat ------------------------------------------------------
eq(parentPid('4321 (claude) S 4300 4321 4300 0 -1'), 4300, 'ppid simple');
eq(parentPid('77 (mi (raro) prog) R 12 77 77'), 12, 'comm con espacios y paréntesis');
eq(parentPid('basura'), null, 'stat roto');

// --- ventana de la terminal ------------------------------------------------
const W = (pid, title, id) => ({pid, title, window: id});
// claude 300 → bash 200 → terminal 100
eq(pickWindow([300, 200, 100], [W(100, 'mi-app — Kitty', 'k'), W(50, 'Firefox', 'f')], 'mi-app'), 'k', 'una ventana de la terminal');
eq(pickWindow([300, 200, 100], [W(100, 'usuario@pc: ~/blog', 'a'), W(100, 'usuario@pc: ~/mi-app', 'b')], 'mi-app'), 'b', 'varias: decide el título');
eq(pickWindow([300, 200, 100], [W(100, 'Terminal', 'a'), W(100, 'Terminal', 'b')], 'mi-app'), null, 'varias sin pista: nada');
eq(pickWindow([300, 200, 100], [W(100, 'mi-app 1', 'a'), W(100, 'mi-app 2', 'b')], 'mi-app'), null, 'varias con el mismo proyecto: nada');
eq(pickWindow([300, 200, 100], [W(200, 'x', 'cerca'), W(100, 'mi-app', 'lejos')], 'mi-app'), 'cerca', 'gana el ancestro más cercano');
eq(pickWindow([300, 200, 100], [W(50, 'mi-app', 'otra')], 'mi-app'), null, 'ventana de otro proceso: nada');
eq(pickWindow([300], [W(1, 'a', 'x'), W(1, 'b', 'y')], '?'), null, 'sin proyecto');

print(`${passed} pruebas OK, ${failed} fallos`);
if (failed)
    System.exit(1);
