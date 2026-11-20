// Lógica pura del botón «Actualizar» (docs/18): sin GNOME Shell, para
// probarla con gjs (scripts/test-updatestate.js).
//
// update.json lo escribe services/updater/update_check.py:
//   {"disponible": "v5", "instalada": "v4", "estado": "disponible",
//    "registro": "/ruta/update.log", ...lo de «Más tarde»}

const TAG = /^v(\d+(?:\.\d+)*)$/;

export const UPDATE_STATES = ['disponible', 'instalando', 'instalada', 'error'];

/** 'v1.10' → [1, 10]; lo que no sea una release (main, local (…)) → null. */
export function versionKey(tag) {
    const m = TAG.exec(String(tag ?? '').trim());
    return m ? m[1].split('.').map(Number) : null;
}

/** ¿`latest` es una release más nueva que `installed`? (v1.10 > v1.9) */
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

/** Contenido de VERSION → la versión ('v4', 'local (…)'…), sin espacios. */
export function parseInstalled(text) {
    return String(text ?? '').trim();
}

/**
 * Texto de update.json + versión EN MARCHA → qué mostrar, o null si no hay
 * nada (sin actualización, JSON roto, código que no es una release…):
 *   {version: 'v5', state: 'disponible'|'instalando'|'instalada'|'error', log}
 * `running` es la versión del código que GNOME tiene cargado (version-name
 * del metadata.json, que escribe install.sh), no el archivo VERSION: así,
 * tras instalar, «Cerrar sesión para terminar» sigue hasta volver a entrar
 * y desaparece después (arreglado el 19-11-2026: antes se quedaba).
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

/** ¿Cambió lo que se muestra? */
export function sameView(a, b) {
    return a === b || (a !== null && b !== null &&
        a.version === b.version && a.state === b.state && a.log === b.log);
}

/** Texto del botón para cada estado. */
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
