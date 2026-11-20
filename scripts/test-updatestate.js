// Tests for modules/updatestate.js (pure logic of the "Update" button).
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
        printerr(`FAIL ${what}\n   got:      ${a}\n   expected: ${e}`);
    }
}

const json = o => JSON.stringify(o);

// --- versions ---------------------------------------------------------------
eq(versionKey('v4'), [4], 'v4');
eq(versionKey('v1.10'), [1, 10], 'v1.10');
eq(versionKey(' v2 '), [2], 'with spaces');
eq(versionKey('main'), null, 'main is not a release');
eq(versionKey('local (v3-4-gf42964a-dirty)'), null, 'local copy is not a release');
eq(versionKey('v'), null, 'v alone');
eq(versionKey(null), null, 'null');
eq(isNewer('v5', 'v4'), true, 'v5 > v4');
eq(isNewer('v4', 'v4'), false, 'equal');
eq(isNewer('v3', 'v4'), false, 'older');
eq(isNewer('v1.10', 'v1.9'), true, 'v1.10 > v1.9');
eq(isNewer('v2', 'v1.9'), true, 'v2 > v1.9');
eq(isNewer('v2.0', 'v2'), false, 'v2.0 = v2');
eq(isNewer('v5', 'main'), false, 'installed is not a release');
eq(parseInstalled('v4\n'), 'v4', 'VERSION with a line break');

// --- what to show -------------------------------------------------------------
const disp = {disponible: 'v5', instalada: 'v4', estado: 'disponible'};
eq(updateView(json(disp), 'v4'), {version: 'v5', state: 'disponible', log: null}, 'v5 is out');
eq(updateView(json({...disp, estado: undefined}), 'v4'), {version: 'v5', state: 'disponible', log: null},
    'no estado: disponible');
eq(updateView(json({...disp, estado: 'raro'}), 'v4').state, 'disponible', 'unknown estado: disponible');
eq(updateView(json(disp), 'v5'), null, 'already installed (after logging back in)');
eq(updateView(json(disp), 'v6'), null, 'newer installed');
eq(updateView(json(disp), 'local (v3-4)'), null, 'local copy: nothing');
eq(updateView(json(disp), 'main'), null, 'main: nothing');
eq(updateView(json({...disp, estado: 'instalando'}), 'v4').state, 'instalando', 'installing');
eq(updateView(json({...disp, estado: 'instalada'}), 'v4'), {version: 'v5', state: 'instalada', log: null},
    'installed without logging out (v4 still loaded): "Log out to finish"');
eq(updateView(json({...disp, estado: 'instalada'}), 'v5'), null,
    'installed and v5 already loaded (logged back in): nothing (bug of 19-11-2026)');
eq(updateView(json({...disp, disponible: 'v6.1', estado: 'instalada'}), 'v6.1'), null,
    'same with dotted versions');
eq(updateView(json({...disp, estado: 'error', registro: '/x/update.log'}), 'v4'),
    {version: 'v5', state: 'error', log: '/x/update.log'}, 'error with log');
eq(updateView(json({...disp, registro: 3}), 'v4').log, null, 'log that is not text');
eq(updateView(json({version: 'v5', snooze_until: 1}), 'v4'), null, 'only "Later": nothing');
eq(updateView(json({...disp, disponible: 'main'}), 'v4'), null, 'disponible is not a release');
eq(updateView('{roto', 'v4'), null, 'broken JSON');
eq(updateView('', 'v4'), null, 'empty file');
eq(updateView('[1]', 'v4'), null, 'not an object');
eq(updateView('null', 'v4'), null, 'null');

// --- changes and texts --------------------------------------------------------
const v = updateView(json(disp), 'v4');
eq(sameView(v, updateView(json(disp), 'v4')), true, 'same view');
eq(sameView(v, null), false, 'view → nothing');
eq(sameView(null, null), true, 'nothing → nothing');
eq(sameView(v, {...v, state: 'instalando'}), false, 'the state changes');
eq(buttonText(v), 'Update to v5', 'button available');
eq(buttonText({...v, state: 'instalando'}), 'Updating…', 'button installing');
eq(buttonText({...v, state: 'instalada'}), 'Log out to finish', 'button installed');
eq(buttonText({...v, state: 'error'}), 'Update failed · Retry', 'button error');

print(`${passed} tests OK, ${failed} failures`);
if (failed)
    System.exit(1);
