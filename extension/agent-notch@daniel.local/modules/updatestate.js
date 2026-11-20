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
 * Texto de update.json + versión instalada → qué mostrar, o null si no hay
 * nada (sin actualización, JSON roto, instalado algo que no es release…):
 *   {version: 'v5', state: 'disponible'|'instalando'|'instalada'|'error', log}
 * Tras instalar (`instalada`) se sigue mostrando aunque VERSION ya diga v5:
 * hasta cerrar sesión, GNOME sigue con la versión vieja cargada.
 */
export function updateView(raw, installed) {
    if (!versionKey(installed))
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
    if (state !== 'instalada' && !isNewer(version, installed))
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
        return 'Actualizando…';
    case 'instalada':
        return 'Cerrar sesión para terminar';
    case 'error':
        return 'No se pudo actualizar · Reintentar';
    default:
        return `Actualizar a ${view?.version ?? ''}`.trim();
    }
}
