// Pruebas de modules/updatestate.js (lógica pura del botón «Actualizar»).
//     gjs -m scripts/test-updatestate.js

import System from 'system';

import {
    buttonText, isNewer, parseInstalled, sameView, updateView, versionKey,
} from '../extension/agent-notch@daniel.local/modules/updatestate.js';

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

const json = o => JSON.stringify(o);

// --- versiones ---------------------------------------------------------------
eq(versionKey('v4'), [4], 'v4');
eq(versionKey('v1.10'), [1, 10], 'v1.10');
eq(versionKey(' v2 '), [2], 'con espacios');
eq(versionKey('main'), null, 'main no es release');
eq(versionKey('local (v3-4-gf42964a-dirty)'), null, 'copia local no es release');
eq(versionKey('v'), null, 'v sola');
eq(versionKey(null), null, 'null');
eq(isNewer('v5', 'v4'), true, 'v5 > v4');
eq(isNewer('v4', 'v4'), false, 'igual');
eq(isNewer('v3', 'v4'), false, 'más vieja');
eq(isNewer('v1.10', 'v1.9'), true, 'v1.10 > v1.9');
eq(isNewer('v2', 'v1.9'), true, 'v2 > v1.9');
eq(isNewer('v2.0', 'v2'), false, 'v2.0 = v2');
eq(isNewer('v5', 'main'), false, 'instalada no release');
eq(parseInstalled('v4\n'), 'v4', 'VERSION con salto de línea');

// --- qué mostrar -------------------------------------------------------------
const disp = {disponible: 'v5', instalada: 'v4', estado: 'disponible'};
eq(updateView(json(disp), 'v4'), {version: 'v5', state: 'disponible', log: null}, 'hay v5');
eq(updateView(json({...disp, estado: undefined}), 'v4'), {version: 'v5', state: 'disponible', log: null},
    'sin estado: disponible');
eq(updateView(json({...disp, estado: 'raro'}), 'v4').state, 'disponible', 'estado desconocido: disponible');
eq(updateView(json(disp), 'v5'), null, 'ya instalada (tras volver a entrar)');
eq(updateView(json(disp), 'v6'), null, 'instalada más nueva');
eq(updateView(json(disp), 'local (v3-4)'), null, 'copia local: nada');
eq(updateView(json(disp), 'main'), null, 'main: nada');
eq(updateView(json({...disp, estado: 'instalando'}), 'v4').state, 'instalando', 'instalando');
eq(updateView(json({...disp, estado: 'instalada'}), 'v4'), {version: 'v5', state: 'instalada', log: null},
    'instalada sin cerrar sesión (sigue cargada la v4): «Cerrar sesión para terminar»');
eq(updateView(json({...disp, estado: 'instalada'}), 'v5'), null,
    'instalada y ya cargada la v5 (se volvió a entrar): nada (fallo del 19-11-2026)');
eq(updateView(json({...disp, disponible: 'v6.1', estado: 'instalada'}), 'v6.1'), null,
    'ídem con versiones con punto');
eq(updateView(json({...disp, estado: 'error', registro: '/x/update.log'}), 'v4'),
    {version: 'v5', state: 'error', log: '/x/update.log'}, 'error con registro');
eq(updateView(json({...disp, registro: 3}), 'v4').log, null, 'registro que no es texto');
eq(updateView(json({version: 'v5', snooze_until: 1}), 'v4'), null, 'solo «Más tarde»: nada');
eq(updateView(json({...disp, disponible: 'main'}), 'v4'), null, 'disponible no es release');
eq(updateView('{roto', 'v4'), null, 'JSON roto');
eq(updateView('', 'v4'), null, 'archivo vacío');
eq(updateView('[1]', 'v4'), null, 'no es un objeto');
eq(updateView('null', 'v4'), null, 'null');

// --- cambios y textos --------------------------------------------------------
const v = updateView(json(disp), 'v4');
eq(sameView(v, updateView(json(disp), 'v4')), true, 'misma vista');
eq(sameView(v, null), false, 'vista → nada');
eq(sameView(null, null), true, 'nada → nada');
eq(sameView(v, {...v, state: 'instalando'}), false, 'cambia el estado');
eq(buttonText(v), 'Update to v5', 'botón disponible');
eq(buttonText({...v, state: 'instalando'}), 'Updating…', 'botón instalando');
eq(buttonText({...v, state: 'instalada'}), 'Log out to finish', 'botón instalada');
eq(buttonText({...v, state: 'error'}), 'Update failed · Retry', 'botón error');

print(`${passed} pruebas OK, ${failed} fallos`);
if (failed)
    System.exit(1);
