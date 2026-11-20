// Common interface of the island's modules (music, system, notifications, agents…).
//
// Each module:
//   - emits 'changed' when what it wants to show changes,
//   - can provide a compact view (`active` + `compactActor`): the island
//     only shows the one of the active module with the highest priority,
//   - can provide an expanded section (`hasExpanded` + `expandedActor`):
//     the island stacks those of all modules, by priority,
//   - can ask for a temporary banner (`bannerActor`): the island expands
//     on its own to show it, with a glow in the `bannerAccent` color,
//   - can provide a card for the panel's Home tab (`homeCard`)
//     and a page of its own with its tab (`pageActor`, `pageTitle`, `pageIcon`),
//   - the island tells it whether its compact view is visible
//     (setCompactVisible → _onCompactVisibleChanged), e.g. to animate
//     something ONLY while visible,
//   - the island and the panel tell it which views are visible
//     ('expanded', 'home', 'page'); the module reacts in
//     _onViewsChanged(views) to work ONLY while something is visible
//     (e.g. read the RAM only if one of its views is visible),
//   - can ask the panel to open on its page ('show-page' signal),
//   - releases everything in destroy().
//
// The actors belong to the module: they are created ONCE and updated afterwards
// (never recreated on every change).

import GObject from 'gi://GObject';

export const NotchModule = GObject.registerClass({
    // 'changed': what it wants to show changed.
    // 'dismiss': asks the island to minimize (closes the panel and does not
    //            expand again until the pointer leaves and comes back).
    // 'show-page': asks to open the panel on its page, or close it if it is
    //            already open on it (e.g. a keyboard shortcut).
    Signals: {'changed': {}, 'dismiss': {}, 'show-page': {}},
}, class NotchModule extends GObject.Object {
    _init(params) {
        super._init(params);
        this._notchVisibleViews = new Set();
        this._notchCompactVisible = false;
    }

    /** Higher number = first (compact: wins; expanded: goes higher up). */
    get priority() {
        return 0;
    }

    /** true if it has something to show in the compact row. */
    get active() {
        return false;
    }

    /** Actor of the compact view. */
    get compactActor() {
        return null;
    }

    /** true if its compact view is the "resting" one (the island stays minimal). */
    get minimal() {
        return false;
    }

    /**
     * Actor the module adds at the end of the panel's tab bar
     * (e.g. the "Update" button, docs/18), or null. The module creates it and
     * shows or hides it; the panel only places it and releases it when destroyed.
     */
    get tabBarActor() {
        return null;
    }

    /** true if its compact view needs the tall row (two lines, docs/09). */
    get tallCompact() {
        return false;
    }

    /** true if it has a section to show in the expanded view. */
    get hasExpanded() {
        return false;
    }

    /**
     * Actor of the expanded section. Better to create it the first time it is
     * asked for, not before: if the pointer never goes over it, it uses no memory.
     */
    get expandedActor() {
        return null;
    }

    /** Card for the panel's Home tab, or null. Create it on first use. */
    get homeCard() {
        return null;
    }

    /** Page of its own in the panel (with its tab), or null. Create it on first use. */
    get pageActor() {
        return null;
    }

    /** Tab name. */
    get pageTitle() {
        return '';
    }

    /** Symbolic icon of the tab. */
    get pageIcon() {
        return 'application-x-addon-symbolic';
    }

    // --- Which views are visible -----------------------------------------

    /** The island tells it: its compact view is visible (or stops being visible). */
    setCompactVisible(visible) {
        if (visible === this._notchCompactVisible)
            return;
        this._notchCompactVisible = visible;
        this._onCompactVisibleChanged(visible);
    }

    get compactVisible() {
        return this._notchCompactVisible;
    }

    /** For the modules: their compact view starts or stops being visible. */
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

    /** Views visible right now ('expanded', 'home', 'page'). */
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

    /** For the modules: the set of visible views changed. */
    _onViewsChanged(_views) {}

    /**
     * Temporary banner (e.g. a notification), or null. While it is not
     * null, the island expands on its own and shows it instead of the sections.
     * When it changes, emit 'changed'.
     */
    get bannerActor() {
        return null;
    }

    /** Color of the bottom glow while the banner is visible ({red, green, blue} 0–255), or null. */
    get bannerAccent() {
        return null;
    }

    destroy() {}
});
