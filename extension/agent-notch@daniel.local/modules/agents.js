// Agents module: status of Claude Code sessions and other agents
// (Phase 1, steps 4–6 of docs/10-hoja-de-ruta.md).
//
// The adapters write one JSON per session in
//     $XDG_RUNTIME_DIR/agent-notch/sessions/<agente>-<sesion>.json
// (docs/03-formato-estado.md). AGENT_NOTCH_DIR changes the root: the test
// GNOME uses agent-notch-dev so scripts/simulate.py does not show up on the
// real desktop's island.
//
// Vistas:
//   - Compact: "● my-app · Editing main.py", or "● 3 agents · 1 needs
//     you" with several. Sessions that are only waiting do not take it.
//   - Expanded (hover): one row per session (dot · project · action ·
//     time), up to 6. Click on a row → brings its terminal window to the
//     front, if it is known for sure which one it is (otherwise it does nothing).
//   - The panel's "Agents" tab: the same list, with all sessions
//     and scrolling; it is still there when you click the island.
//
// Dead sessions (docs/03): with a PID, when that process no longer exists; without
// a PID, after 30 min without news. They are removed and their file deleted.
//
// Consumo:
//   - Event-driven: Gio.FileMonitor on the folder, no polling.
//   - Bursts grouped: at most one read/redraw every 100 ms.
//   - Asynchronous reads, cancelled on destroy.
//   - Timers only while needed: 5 s after `terminado`;
//     checking for dead sessions every 30 s only if there are sessions; refreshing
//     the times every 30 s only with the list (hover or tab) visible.
//   - Each list is created the first time it is shown and reuses its rows.
//
// Animations and alerts (step 7, docs/09-diseno-visual.md):
//   - In the compact view, eyes instead of the dot (docs/09, 19-11-2026): they change
//     shape and color with the state and blink once when it changes.
//   - Pulse of the eyes (opacity, with ease() on the GPU) while thinking or
//     working (900 ms) or asking for attention (500 ms), ONLY with the compact view
//     visible and GNOME's animations on. Otherwise, no loop.
//   - `terminado`: happy eyes and a single flash.
//   - When a session goes to `atencion` (once per change, not on every
//     event): the island opens for 5 s with an amber banner and plays
//     the theme's `dialog-question`. Click on the banner → its terminal. With
//     Do Not Disturb there is neither banner nor sound. Sessions that were already
//     asking for attention when the extension was enabled (e.g. on unlock) do not alert.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NotchModule} from './module.js';
import {readText, isCancelled} from './sysinfo.js';
import {Eyes, eyesAnimate, makeLabel} from './widgets.js';
import {
    AGENT_TINTS, STATES, agentLabel, formatAge, isDead, isSessionFile, nextChangeIn, parentPid, parseSession,
    eyesFor, overview, pickWindow, sameSummary, shortPath, shownState, sortSessions, stateText, summarize,
} from './agentstate.js';

// Compact: with something running it beats the music (10) but not the
// focus timer (20); asking for attention it beats everything except
// notification banners (100).
const PRIORITY = 15;
const PRIORITY_ATTENTION = 50;
const BATCH_MS = 100;
const REAP_S = 30;
const AGE_TICK_S = 30;
const MAX_ROWS = 6;          // in the hover
const MAX_PAGE_ROWS = 40;    // in the tab (with scrolling)
const ICON = 'utilities-terminal-symbolic';
const PULSE_MS = {pensando: 900, trabajando: 900, atencion: 500};
const PULSE_OPACITY = 110;
const FLASH_MS = 180;
const BANNER_MS = 5000;
const BANNER_HOVER_RETRY_MS = 1000;
const ATTENTION_SOUND = 'dialog-question';   // Yaru theme (docs/09)
const ATTENTION_RGB = {red: 251, green: 191, blue: 36};   // #fbbf24
const MAX_ANCESTORS = 16;

const decoder = new TextDecoder();
const nowSeconds = () => GLib.get_real_time() / 1e6;
// /proc does not block: checking whether a process exists is instant.
const pidAlive = pid => GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);

function sessionsDir() {
    const root = GLib.getenv('AGENT_NOTCH_DIR') ||
        GLib.build_filenamev([GLib.get_user_runtime_dir(), 'agent-notch']);
    return GLib.build_filenamev([root, 'sessions']);
}

function setStateClass(actor, state) {
    for (const s of STATES) {
        if (s === state)
            actor.add_style_class_name(`estado-${s}`);
        else
            actor.remove_style_class_name(`estado-${s}`);
    }
}

function setTintClass(actor, tint) {
    for (const t of AGENT_TINTS) {
        if (t === tint)
            actor.add_style_class_name(`agente-${t}`);
        else
            actor.remove_style_class_name(`agente-${t}`);
    }
}

export const AgentsModule = GObject.registerClass(
class AgentsModule extends NotchModule {
    // settings: agent-notch settings (sound, banner and its duration are read
    // at the moment of the alert); twoLines: eyes on top and text below (docs/20).
    _init({settings = null, twoLines = true} = {}) {
        super._init();
        this._prefs = settings;
        this._twoLines = twoLines;

        this._sessions = new Map();   // file name → session
        this._readGen = new Map();    // name → no. of the last read requested
        this._pending = new Set();    // names to reread in the next batch
        this._batchId = 0;
        this._expireId = 0;
        this._reapId = 0;
        this._ageId = 0;
        this._summary = null;
        this._rowCount = 0;           // sessions in the lists (to readjust the island)
        this._exp = null;             // hover list, on first use
        this._page = null;            // panel tab, on first use
        this._card = null;            // Home card, on first use
        this._cancellable = new Gio.Cancellable();
        this._pulseMs = 0;            // duration of the running pulse (0 = stopped)
        this._banner = null;          // created with the first alert
        this._bannerName = null;      // file of the banner's session
        this._bannerSession = null;
        this._bannerId = 0;

        this._settings = St.Settings.get();
        this._settings.connectObject('notify::enable-animations', () => this._syncPulse(), this);
        // GNOME's Do Not Disturb = show-banners false.
        this._notifSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});

        this._buildCompact();

        this._dir = Gio.File.new_for_path(sessionsDir());
        try {
            // The adapters create it with 0700; if there is none yet,
            // we create it ourselves so we can watch it right away.
            GLib.mkdir_with_parents(this._dir.get_path(), 0o700);
            this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connectObject('changed', (_m, file, other) => {
                this._queue(file);
                this._queue(other);
            }, this);
        } catch (e) {
            console.error(`[agent-notch] Agents: cannot watch ${this._dir.get_path()}: ${e.message}`);
            this._monitor = null;
        }
        this._loadAll();
    }

    get priority() {
        return this._summary?.state === 'atencion' ? PRIORITY_ATTENTION : PRIORITY;
    }

    get active() {
        return this._summary !== null;
    }

    get compactActor() {
        return this._compact;
    }

    // Eyes on top and text below: the island grows while it is shown (docs/09).
    get tallCompact() {
        return this._twoLines;
    }

    get hasExpanded() {
        return this._sessions.size > 0;
    }

    get expandedActor() {
        this._exp ??= this._newList(MAX_ROWS);
        return this._exp.actor;
    }

    // Home card (docs/09, review of 19-11-2026): always, with the
    // eyes and the summary; click → Agents tab.
    get homeCard() {
        this._card ??= this._buildCard();
        return this._card.actor;
    }

    get pageActor() {
        this._page ??= this._buildPage();
        return this._page.actor;
    }

    get pageTitle() {
        return 'Agents';
    }

    get pageIcon() {
        return ICON;
    }

    // --- Reading the folder -------------------------------------------------

    // Any event (CREATED, CHANGES_DONE_HINT, RENAMED, MOVED_IN,
    // DELETED…) is handled the same: reread that file. If it no longer exists, the
    // session is removed. That way it does not matter which events GLib sends for a rename.
    _queue(file) {
        const name = file?.get_basename();
        if (!isSessionFile(name) || !file.get_parent()?.equal(this._dir))
            return;
        this._pending.add(name);
        if (!this._batchId) {
            this._batchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BATCH_MS, () => {
                this._batchId = 0;
                const names = [...this._pending];
                this._pending.clear();
                for (const n of names)
                    this._read(n);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _loadAll() {
        this._dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable, (dir, res) => {
                let enumerator;
                try {
                    enumerator = dir.enumerate_children_finish(res);
                } catch (e) {
                    if (!isCancelled(e))
                        console.error(`[agent-notch] Agents: cannot read the folder: ${e.message}`);
                    return;
                }
                this._nextFiles(enumerator);
            });
    }

    _nextFiles(enumerator) {
        enumerator.next_files_async(32, GLib.PRIORITY_DEFAULT, this._cancellable, (en, res) => {
            let infos;
            try {
                infos = en.next_files_finish(res);
            } catch {
                infos = [];
            }
            for (const info of infos) {
                if (isSessionFile(info.get_name()))
                    this._read(info.get_name(), {initial: true});
            }
            if (infos.length > 0)
                this._nextFiles(en);
            else
                en.close_async(GLib.PRIORITY_DEFAULT, null, null);
        });
    }

    // initial: read when the extension is enabled (it does not alert about what was already there).
    _read(name, {initial = false} = {}) {
        // If two reads of the same file arrive, only the last one requested
        // counts (the other could bring old data).
        const gen = (this._readGen.get(name) ?? 0) + 1;
        this._readGen.set(name, gen);
        this._dir.get_child(name).load_contents_async(this._cancellable, (file, res) => {
            let session = null;
            try {
                const [, bytes] = file.load_contents_finish(res);
                session = parseSession(decoder.decode(bytes));
            } catch (e) {
                if (isCancelled(e))
                    return;
                // NOT_FOUND: the session ended (or was deleted): it is removed.
            }
            if (!this._dir || this._readGen.get(name) !== gen)
                return;   // destroyed, or a newer read is on its way
            this._readGen.delete(name);
            const prev = this._sessions.get(name);
            if (session)
                this._sessions.set(name, session);
            else
                this._sessions.delete(name);
            if (!initial && session?.estado === 'atencion' && prev?.estado !== 'atencion')
                this._alert(name, session);
            this._render();
        });
    }

    // --- Dead sessions --------------------------------------------------------

    // Removes dead sessions and deletes their files. Returns whether it removed any.
    _reap() {
        const now = nowSeconds();
        let removed = false;
        for (const [name, session] of this._sessions) {
            if (!isDead(session, now, pidAlive))
                continue;
            this._sessions.delete(name);
            this._dir.get_child(name).delete_async(GLib.PRIORITY_LOW, null, (f, res) => {
                try {
                    f.delete_finish(res);
                } catch {
                    // It was already gone: nothing to do.
                }
            });
            removed = true;
        }
        return removed;
    }

    // Check every 30 s, only while there are sessions.
    _syncReaper() {
        if (this._sessions.size > 0 && !this._reapId) {
            this._reapId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REAP_S, () => {
                if (this._reap())
                    this._render();
                if (this._sessions.size > 0)
                    return GLib.SOURCE_CONTINUE;
                this._reapId = 0;
                return GLib.SOURCE_REMOVE;
            });
        } else if (this._sessions.size === 0 && this._reapId) {
            GLib.source_remove(this._reapId);
            this._reapId = 0;
        }
    }

    // --- Compact view ----------------------------------------------------------

    _buildCompact() {
        // Two lines (docs/09): eyes at the top center, text below. With the
        // agentes-dos-lineas setting off, everything on one line (docs/20).
        this._compact = new St.BoxLayout({
            style_class: this._twoLines ? 'agent-notch-agents' : 'agent-notch-agents una-linea',
            orientation: this._twoLines ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Eyes instead of the dot (docs/09): color and shape according to the state.
        this._eyes = new Eyes({x_align: Clutter.ActorAlign.CENTER});
        this._title = makeLabel('agent-notch-agents-title', {y_align: Clutter.ActorAlign.CENTER});
        this._separator = new St.Label({
            style_class: 'agent-notch-agents-separator',
            text: '·',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._detail = makeLabel('agent-notch-agents-detail', {y_align: Clutter.ActorAlign.CENTER});
        const line = new St.BoxLayout({
            style_class: 'agent-notch-agents-line',
            x_align: Clutter.ActorAlign.CENTER,
        });
        line.add_child(this._title);
        line.add_child(this._separator);
        line.add_child(this._detail);
        this._compact.add_child(this._eyes);
        this._compact.add_child(line);
    }

    _render() {
        if (!this._compact)
            return;
        // A freshly read session can already be dead (e.g. after a
        // false close): it is removed without waiting for the next check.
        this._reap();

        const now = nowSeconds();
        const sessions = [...this._sessions.values()];
        const summary = summarize(sessions, now);
        this._scheduleExpiry(sessions, now);
        this._syncReaper();

        // Any change in the number of sessions changes the height of the hover
        // or of the tab: the island has to readjust.
        const rowCount = sessions.length;
        const sorted = sortSessions(sessions, now);
        for (const list of [this._exp, this._page?.list]) {
            if (list)
                this._renderList(list, sorted, now);
        }
        const ov = overview(sessions, now);
        if (this._page) {
            this._page.scroll.visible = sessions.length > 0;
            this._page.header.visible = sessions.length > 0;
            this._page.empty.visible = sessions.length === 0;
            if (this._page.header.text !== ov.text)
                this._page.header.text = ov.text;
        }
        if (this._card)
            this._renderCard(ov);

        const before = this._summary;
        if (!sameSummary(summary, before)) {
            this._summary = summary;
            if (summary) {
                setStateClass(this._compact, summary.state);
                this._title.text = summary.title;
                this._detail.text = summary.detail;
            }
        }
        // When finishing, the flash replaces the blink of the shape change.
        const finished = summary?.state === 'terminado' && before?.state !== 'terminado';
        if (summary)
            this._eyes.setExpression(eyesFor(summary.state), {animate: !finished && this.compactVisible});
        this._syncPulse();
        if (finished)
            this._flash();

        // The banner is not needed if its session no longer asks for attention (it was
        // answered in the terminal) or it disappeared.
        if (this._bannerName && this._sessions.get(this._bannerName)?.estado !== 'atencion')
            this._hideBanner();

        // The island only cares whether something appears/disappears, the
        // priority changes or the height of the expanded view changes; text
        // changes are laid out again by Clutter on its own.
        const changed = (before === null) !== (summary === null) ||
            before?.state !== summary?.state || rowCount !== this._rowCount;
        this._rowCount = rowCount;
        if (changed)
            this.emit('changed');
    }

    // `terminado` shows as `inactivo` after 5 s: a single timer
    // until the next change, and none if no sessions are finishing.
    _scheduleExpiry(sessions, now) {
        if (this._expireId) {
            GLib.source_remove(this._expireId);
            this._expireId = 0;
        }
        const left = nextChangeIn(sessions, now);
        if (left === null)
            return;
        this._expireId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(left * 1000) + 50, () => {
            this._expireId = 0;
            this._render();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Animations (step 7) ----------------------------------------------------

    _onCompactVisibleChanged() {
        this._syncPulse();
    }

    // A single opacity loop, and only while it adds something.
    _syncPulse() {
        if (!this._eyes)
            return;
        const ms = PULSE_MS[this._summary?.state] ?? 0;
        const want = ms && this.compactVisible && eyesAnimate() ? ms : 0;
        if (want === this._pulseMs)
            return;
        this._eyes.remove_transition('opacity');
        this._eyes.opacity = 255;
        this._pulseMs = want;
        if (want) {
            this._eyes.ease({
                opacity: PULSE_OPACITY,
                duration: want,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: -1,
                autoReverse: true,
            });
        }
    }

    _flash() {
        if (!this.compactVisible || !eyesAnimate())
            return;
        this._eyes.remove_transition('scale-x');
        this._eyes.remove_transition('scale-y');
        this._eyes.set_scale(1, 1);
        this._eyes.ease({
            scale_x: 1.4,
            scale_y: 1.4,
            duration: FLASH_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            repeatCount: 1,
            autoReverse: true,
        });
    }

    // --- Alert when asking for attention (step 7) -----------------------------------------

    get bannerActor() {
        return this._bannerSession ? this._banner : null;
    }

    get bannerAccent() {
        return this._bannerSession ? ATTENTION_RGB : null;
    }

    _alert(name, session) {
        if (!this._notifSettings.get_boolean('show-banners'))
            return;   // Do Not Disturb: only the eyes change
        // agent-notch settings (docs/20), read now: no signals.
        if (this._prefs?.get_boolean('sonido-atencion') ?? true) {
            try {
                global.display.get_sound_player().play_from_theme(
                    ATTENTION_SOUND, `${session.proyecto} needs you`, null);
            } catch (e) {
                console.error(`[agent-notch] Agents: could not play the alert sound: ${e.message}`);
            }
        }
        if (this._prefs?.get_boolean('banner-atencion') ?? true)
            this._showBanner(name, session);
    }

    _buildBanner() {
        // Two lines, like the compact view (docs/09): eyes on top, message below
        // (or on one line, with agentes-dos-lineas off, docs/20).
        const box = new St.BoxLayout({
            style_class: 'agent-notch-agents-banner-box',
            orientation: this._twoLines ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        // Wide-open amber eyes (docs/09, added on approval).
        this._bannerEyes = new Eyes({x_align: Clutter.ActorAlign.CENTER});
        this._bannerEyes.setExpression('muy-abiertos', {animate: false});
        this._bannerTitle = makeLabel('agent-notch-agents-banner-title', {y_align: Clutter.ActorAlign.CENTER});
        this._bannerDetail = makeLabel('agent-notch-agents-banner-detail', {y_align: Clutter.ActorAlign.CENTER});
        const line = new St.BoxLayout({
            style_class: 'agent-notch-agents-banner-line',
            x_align: Clutter.ActorAlign.CENTER,
        });
        line.add_child(this._bannerTitle);
        line.add_child(this._bannerDetail);
        box.add_child(this._bannerEyes);
        box.add_child(line);
        this._banner = new St.Button({
            style_class: this._twoLines
                ? 'agent-notch-agents-banner estado-atencion'
                : 'agent-notch-agents-banner estado-atencion una-linea',
            child: box,
            x_expand: true,
            track_hover: true,
            can_focus: true,
        });
        this._banner.connect('clicked', () => {
            const session = this._bannerSession;
            this._hideBanner();
            if (session)
                this._focusTerminal(session);
        });
    }

    _showBanner(name, session) {
        if (!this._banner)
            this._buildBanner();
        this._bannerTitle.text = `${session.proyecto} needs you`;
        this._bannerDetail.text = session.accion ?? stateText('atencion');
        this._banner.accessible_name = `${this._bannerTitle.text}: ${this._bannerDetail.text}`;
        this._bannerName = name;
        this._bannerSession = session;
        const seconds = this._prefs?.get_int('banner-segundos') ?? BANNER_MS / 1000;
        this._scheduleBannerEnd(seconds * 1000);
        this.emit('changed');
    }

    // It goes away after 5 s; with the pointer over it, it waits until it leaves.
    _scheduleBannerEnd(ms) {
        if (this._bannerId)
            GLib.source_remove(this._bannerId);
        this._bannerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._bannerId = 0;
            if (this._banner?.hover)
                this._scheduleBannerEnd(BANNER_HOVER_RETRY_MS);
            else
                this._hideBanner();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideBanner() {
        if (this._bannerId) {
            GLib.source_remove(this._bannerId);
            this._bannerId = 0;
        }
        if (!this._bannerSession)
            return;
        this._bannerName = null;
        this._bannerSession = null;
        this.emit('changed');
    }

    // --- Session lists (hover and tab) -----------------------------------

    // A reusable list: rows created when needed and
    // reused; at most `maxRows`, and "and N more" if they do not fit.
    // detailed: rows on two lines, with the folder below (tab).
    _newList(maxRows, {detailed = false} = {}) {
        const actor = new St.BoxLayout({
            style_class: 'agent-notch-agents-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const more = makeLabel('agent-notch-agents-more', {visible: false});
        actor.add_child(more);
        const list = {actor, more, rows: [], maxRows, detailed};
        const now = nowSeconds();
        this._renderList(list, sortSessions([...this._sessions.values()], now), now);
        return list;
    }

    _buildPage() {
        const actor = new St.BoxLayout({
            style_class: 'agent-notch-agents-page',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            // Stuck to the top (the panel's St.Bin only follows y_align with y_expand).
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        // Header with the summary (docs/09, review of 19-11-2026).
        const header = makeLabel('agent-notch-agents-header', {visible: this._sessions.size > 0});
        actor.add_child(header);
        const list = this._newList(MAX_PAGE_ROWS, {detailed: true});
        const scroll = new St.ScrollView({
            style_class: 'agent-notch-agents-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: list.actor,
            visible: this._sessions.size > 0,
        });
        actor.add_child(scroll);

        const empty = new St.BoxLayout({
            style_class: 'agent-notch-agents-empty',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            visible: this._sessions.size === 0,
        });
        empty.add_child(new St.Icon({icon_name: ICON, style_class: 'agent-notch-agents-empty-icon'}));
        empty.add_child(new St.Label({
            style_class: 'agent-notch-agents-empty-title',
            text: 'No agents running',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        empty.add_child(new St.Label({
            style_class: 'agent-notch-agents-empty-hint',
            text: 'Claude Code sessions will show up here',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        actor.add_child(empty);
        return {actor, list, scroll, empty, header};
    }

    _newRow(list) {
        const row = {};
        const box = new St.BoxLayout({style_class: 'agent-notch-agents-row-box', x_expand: true});
        let child = box;
        row.path = null;
        if (list.detailed) {
            child = new St.BoxLayout({
                style_class: 'agent-notch-agents-row-two',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            row.path = makeLabel('agent-notch-agents-row-path');
            child.add_child(box);
            child.add_child(row.path);
        }
        row.button = new St.Button({
            style_class: 'agent-notch-agents-row',
            child,
            x_expand: true,
            can_focus: true,
        });
        row.dot = new St.Widget({style_class: 'agent-notch-dot', y_align: Clutter.ActorAlign.CENTER});
        row.project = makeLabel('agent-notch-agents-row-project', {y_align: Clutter.ActorAlign.CENTER});
        row.tag = new St.Label({style_class: 'agent-notch-agents-row-tag', y_align: Clutter.ActorAlign.CENTER});
        row.agente = null;
        row.action = makeLabel('agent-notch-agents-row-action', {
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        row.age = new St.Label({style_class: 'agent-notch-agents-row-age', y_align: Clutter.ActorAlign.CENTER});
        for (const child of [row.dot, row.project, row.tag, row.action, row.age])
            box.add_child(child);
        row.button.connect('clicked', () => {
            if (row.session)
                this._focusTerminal(row.session);
        });
        // Before the "and N more" label, which always goes last.
        list.actor.insert_child_below(row.button, list.more);
        return row;
    }

    _renderList(list, sorted, now) {
        const shown = sorted.slice(0, list.maxRows);
        while (list.rows.length < shown.length)
            list.rows.push(this._newRow(list));

        list.rows.forEach((row, i) => {
            const s = shown[i];
            row.session = s ?? null;
            row.button.visible = Boolean(s);
            if (!s)
                return;
            const state = shownState(s, now);
            setStateClass(row.button, state);
            const action = state === 'inactivo' ? stateText(state) : s.accion ?? stateText(state);
            if (row.project.text !== s.proyecto)
                row.project.text = s.proyecto;
            const agent = agentLabel(s.agente);
            if (row.agente !== s.agente) {
                row.agente = s.agente;
                row.tag.text = agent.name;
                setTintClass(row.tag, agent.tint);
            }
            if (row.action.text !== action)
                row.action.text = action;
            const age = formatAge(now - s.inicio);
            if (row.age.text !== age)
                row.age.text = age;
            if (row.path) {
                const path = shortPath(s.cwd, GLib.get_home_dir());
                if (row.path.text !== path)
                    row.path.text = path;
                row.path.visible = path !== '';
            }
            row.button.accessible_name = `${s.proyecto} (${agent.name}): ${action}`;
        });

        const hidden = sorted.length - shown.length;
        list.more.visible = hidden > 0;
        if (hidden > 0)
            list.more.text = `and ${hidden} more`;
    }

    _buildCard() {
        const eyes = new Eyes();
        const title = makeLabel('agent-notch-card-title');
        const subtitle = makeLabel('agent-notch-card-subtitle');
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        text.add_child(title);
        text.add_child(subtitle);
        const box = new St.BoxLayout({style_class: 'agent-notch-agents-card-box', x_expand: true});
        box.add_child(eyes);
        box.add_child(text);
        const actor = new St.Button({
            style_class: 'agent-notch-card agent-notch-agents-card',
            child: box,
            can_focus: true,
            accessible_name: 'Agents',
        });
        actor.connect('clicked', () => this.emit('show-page'));
        const card = {actor, eyes, title, subtitle};
        this._renderCard(overview([...this._sessions.values()], nowSeconds()), card);
        return card;
    }

    _renderCard(ov, card = this._card) {
        setStateClass(card.actor, ov.state ?? 'ninguno');
        card.eyes.setExpression(ov.state ? eyesFor(ov.state) : 'abiertos',
            {animate: this.visibleViews.has('home')});
        if (card.title.text !== ov.title)
            card.title.text = ov.title;
        if (card.subtitle.text !== ov.detail)
            card.subtitle.text = ov.detail;
    }

    // The times ("12 min") only refresh with some list visible.
    _onViewsChanged(views) {
        const visible = views.has('expanded') || views.has('page');
        if (visible && !this._ageId) {
            this._render();
            this._ageId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, AGE_TICK_S, () => {
                this._render();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!visible && this._ageId) {
            GLib.source_remove(this._ageId);
            this._ageId = 0;
        }
    }

    // --- Click: bring the session's terminal ------------------------------------

    async _focusTerminal(session) {
        if (session.pid === null)
            return;
        const ancestors = [];
        let pid = session.pid;
        try {
            while (pid && pid > 1 && ancestors.length < MAX_ANCESTORS) {
                ancestors.push(pid);
                // eslint-disable-next-line no-await-in-loop
                pid = parentPid(await readText(`/proc/${pid}/stat`, this._cancellable));
            }
        } catch (e) {
            if (isCancelled(e))
                return;
            // The process ended while we were climbing: go with what we have.
        }
        if (!this._dir)
            return;   // destroyed in the meantime

        const windows = global.display.list_all_windows()
            .filter(w => w.get_window_type() === Meta.WindowType.NORMAL && !w.is_skip_taskbar())
            .map(w => ({pid: w.get_pid(), title: w.get_title(), window: w}));
        const target = pickWindow(ancestors, windows, session.proyecto);
        if (!target)
            return;   // it is not known which one: better do nothing
        Main.activateWindow(target);
        this.emit('dismiss');
    }

    destroy() {
        this._cancellable.cancel();
        this._settings?.disconnectObject(this);
        this._settings = this._notifSettings = this._prefs = null;
        if (this._bannerId)
            GLib.source_remove(this._bannerId);
        this._bannerId = 0;
        this._bannerName = this._bannerSession = null;
        this._banner?.destroy();
        this._banner = this._bannerEyes = this._bannerTitle = this._bannerDetail = null;
        this._monitor?.disconnectObject(this);
        this._monitor?.cancel();
        this._monitor = null;
        for (const id of [this._batchId, this._expireId, this._reapId, this._ageId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._batchId = this._expireId = this._reapId = this._ageId = 0;
        this._pending.clear();
        this._sessions.clear();
        this._readGen.clear();
        this._compact?.destroy();
        this._compact = this._eyes = this._title = this._separator = this._detail = null;
        this._exp?.actor.destroy();
        this._page?.actor.destroy();
        this._card?.actor.destroy();
        this._exp = this._page = this._card = null;
        this._dir = null;
    }
});
