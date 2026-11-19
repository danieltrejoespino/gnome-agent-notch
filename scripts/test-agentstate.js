// Pruebas de modules/agentstate.js (lógica pura del módulo Agentes).
//     gjs -m scripts/test-agentstate.js

import System from 'system';

import {
    isSessionFile, nextChangeIn, parseSession, sameSummary, shownState, summarize,
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

print(`${passed} pruebas OK, ${failed} fallos`);
if (failed)
    System.exit(1);
