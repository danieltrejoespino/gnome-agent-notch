// Pure logic of the "Update" button (docs/18): without GNOME Shell, so it
// can be tested with gjs (scripts/test-updatestate.js).
//
// update.json is written by services/updater/update_check.py:
//   {"disponible": "v5", "instalada": "v4", "estado": "disponible",
//    "registro": "/path/update.log", ...the "Later" fields}

const TAG = /^v(\d+(?:\.\d+)*)$/;

export const UPDATE_STATES = ['disponible', 'instalando', 'instalada', 'error'];

/** 'v1.10' → [1, 10]; anything that is not a release (main, local (…)) → null. */
export function versionKey(tag) {
    const m = TAG.exec(String(tag ?? '').trim());
    return m ? m[1].split('.').map(Number) : null;
}

/** Is `latest` a release newer than `installed`? (v1.10 > v1.9) */
export function isNewer(latest, installed) {
    const a = versionKey(latest);
    const b = versionKey(installed);
    if (!a || !b)
        return false;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d !== 0)
            return d > 0;
    }
    return false;
}

/** Contents of VERSION → the version ('v4', 'local (…)'…), trimmed. */
export function parseInstalled(text) {
    return String(text ?? '').trim();
}

/**
 * update.json text + RUNNING version → what to show, or null if there is
 * nothing (no update, broken JSON, code that is not a release…):
 *   {version: 'v5', state: 'disponible'|'instalando'|'instalada'|'error', log}
 * `running` is the version of the code GNOME has loaded (version-name
 * from metadata.json, written by install.sh), not the VERSION file: that way,
 * after installing, "Log out to finish" stays until logging back in
 * and goes away afterwards (fixed on 19-11-2026: it used to stay).
 */
export function updateView(raw, running) {
    if (!versionKey(running))
        return null;
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return null;
    const version = data.disponible;
    if (!versionKey(version))
        return null;
    const state = UPDATE_STATES.includes(data.estado) ? data.estado : 'disponible';
    if (!isNewer(version, running))
        return null;
    const log = typeof data.registro === 'string' ? data.registro : null;
    return {version, state, log};
}

/** Did what is shown change? */
export function sameView(a, b) {
    return a === b || (a !== null && b !== null &&
        a.version === b.version && a.state === b.state && a.log === b.log);
}

/** Button text for each state. */
export function buttonText(view) {
    switch (view?.state) {
    case 'instalando':
        return 'Updating…';
    case 'instalada':
        return 'Log out to finish';
    case 'error':
        return 'Update failed · Retry';
    default:
        return `Update to ${view?.version ?? ''}`.trim();
    }
}
