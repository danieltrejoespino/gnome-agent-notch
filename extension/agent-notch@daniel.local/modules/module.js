// Interfaz común de los módulos de la isla (música, sistema, notificaciones, agentes…).
//
// Cada módulo:
//   - emite 'changed' cuando cambia lo que quiere mostrar,
//   - puede aportar una vista compacta (`active` + `compactActor`): la isla
//     muestra solo la del módulo activo de mayor prioridad,
//   - puede aportar una sección expandida (`hasExpanded` + `expandedActor`):
//     la isla apila las de todos los módulos, por prioridad,
//   - puede pedir un banner temporal (`bannerActor`): la isla se expande
//     sola para mostrarlo, con un brillo del color `bannerAccent`,
//   - puede aportar una tarjeta para la pestaña Home del panel (`homeCard`)
//     y una página propia con su pestaña (`pageActor`, `pageTitle`, `pageIcon`),
//   - la isla le avisa de si su vista compacta se está viendo
//     (setCompactVisible → _onCompactVisibleChanged), p. ej. para animar
//     algo SOLO mientras se ve,
//   - la isla y el panel le avisan de qué vistas se están viendo
//     ('expanded', 'home', 'page'); el módulo reacciona en
//     _onViewsChanged(views) para trabajar SOLO mientras algo se ve
//     (p. ej. leer la RAM solo si se ve alguna de sus vistas),
//   - puede pedir que el panel se abra en su página (señal 'show-page'),
//   - libera todo en destroy().
//
// Los actores son del módulo: se crean UNA vez y se actualizan después
// (nunca se recrean en cada cambio).

import GObject from 'gi://GObject';

export const NotchModule = GObject.registerClass({
    // 'changed': cambió lo que quiere mostrar.
    // 'dismiss': pide a la isla que se minimice (cierra el panel y no se
    //            vuelve a expandir hasta que el ratón salga y vuelva a entrar).
    // 'show-page': pide abrir el panel en su página, o cerrarlo si ya está
    //            abierto en ella (p. ej. un atajo de teclado).
    Signals: {'changed': {}, 'dismiss': {}, 'show-page': {}},
}, class NotchModule extends GObject.Object {
    _init(params) {
        super._init(params);
        this._notchVisibleViews = new Set();
        this._notchCompactVisible = false;
    }

    /** Mayor número = antes (compacta: gana; expandida: va más arriba). */
    get priority() {
        return 0;
    }

    /** true si tiene algo que mostrar en la fila compacta. */
    get active() {
        return false;
    }

    /** Actor de la vista compacta. */
    get compactActor() {
        return null;
    }

    /** true si su vista compacta es la "de reposo" (la isla queda mínima). */
    get minimal() {
        return false;
    }

    /** true si tiene una sección que mostrar en la vista expandida. */
    get hasExpanded() {
        return false;
    }

    /**
     * Actor de la sección expandida. Conviene crearlo la primera vez que se
     * pide, no antes: si nunca se pasa el ratón, no ocupa memoria.
     */
    get expandedActor() {
        return null;
    }

    /** Tarjeta para la pestaña Home del panel, o null. Crearla al primer uso. */
    get homeCard() {
        return null;
    }

    /** Página propia en el panel (con su pestaña), o null. Crearla al primer uso. */
    get pageActor() {
        return null;
    }

    /** Nombre de la pestaña. */
    get pageTitle() {
        return '';
    }

    /** Icono simbólico de la pestaña. */
    get pageIcon() {
        return 'application-x-addon-symbolic';
    }

    // --- Qué vistas se están viendo -----------------------------------------

    /** La isla avisa: su vista compacta se ve (o deja de verse). */
    setCompactVisible(visible) {
        if (visible === this._notchCompactVisible)
            return;
        this._notchCompactVisible = visible;
        this._onCompactVisibleChanged(visible);
    }

    get compactVisible() {
        return this._notchCompactVisible;
    }

    /** Para los módulos: su vista compacta empieza o deja de verse. */
    _onCompactVisibleChanged(_visible) {}

    setExpandedVisible(visible) {
        this._setViewVisible('expanded', visible);
    }

    setHomeVisible(visible) {
        this._setViewVisible('home', visible);
    }

    setPageVisible(visible) {
        this._setViewVisible('page', visible);
    }

    /** Vistas visibles ahora mismo ('expanded', 'home', 'page'). */
    get visibleViews() {
        return this._notchVisibleViews;
    }

    _setViewVisible(view, visible) {
        if (visible === this._notchVisibleViews.has(view))
            return;
        if (visible)
            this._notchVisibleViews.add(view);
        else
            this._notchVisibleViews.delete(view);
        this._onViewsChanged(this._notchVisibleViews);
    }

    /** Para los módulos: cambió el conjunto de vistas visibles. */
    _onViewsChanged(_views) {}

    /**
     * Banner temporal (p. ej. una notificación), o null. Mientras no sea
     * null, la isla se expande sola y lo muestra en lugar de las secciones.
     * Al cambiar, emitir 'changed'.
     */
    get bannerActor() {
        return null;
    }

    /** Color del brillo inferior mientras se ve el banner ({red, green, blue} 0–255), o null. */
    get bannerAccent() {
        return null;
    }

    destroy() {}
});
