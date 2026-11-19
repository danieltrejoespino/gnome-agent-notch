// Módulo Música: muestra lo que suena en cualquier reproductor MPRIS.
// Ver docs/11-modulo-musica.md y docs/13-rediseno.md (D3).
//
// Vistas (cada una se crea la primera vez que se usa):
//   - compacta:  carátula mini (o icono de la app) · Título — Artista ·
//     barritas (animadas SOLO si suena y la compacta se ve)
//   - expandida (hover, M4): tarjeta con la carátula de fondo oscurecida,
//     salida de audio, icono · Título • Artista, barra con onda fija que se
//     puede arrastrar, tiempos y 🔀 ⏮ ⏯ ⏭ 🔁
//   - tarjeta de Home: carátula mini · título · artista · ⏯
//   - página:    carátula grande fundida con el panel, barra de progreso
//
// Consumo: sin sondeo. Solo reacciona a las señales de los reproductores y
// reutiliza el lector MPRIS que ya tiene abierto el calendario de GNOME.
// La barra de progreso es la única excepción: avanza con un temporizador de
// 1 s SOLO con la página o el hover visibles y la música sonando, y se
// sincroniza con el reproductor (una llamada D-Bus) cada 5 s o al cambiar de
// canción. Aleatorio, repetir y la salida de audio solo se leen y escuchan
// mientras se ve el hover.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {MprisSource} from 'resource:///org/gnome/shell/ui/mpris.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {NotchModule} from './module.js';
import {Bar, CoverBackdrop, EqualizerBars, WaveProgress, formatTime, makeLabel} from './widgets.js';

const PRIORITY = 10;
const FALLBACK_ICON = 'audio-x-generic-symbolic';
const RESYNC_EVERY_TICKS = 5;
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
// Orden al pulsar 🔁: no repetir → toda la lista → una canción.
const LOOP_NEXT = {None: 'Playlist', Playlist: 'Track', Track: 'None'};

// Al cerrarse un reproductor, GNOME anula su proxy un instante antes de
// emitir 'player-removed': leer sus propiedades entonces lanzaría un error.
function safe(read, fallback) {
    try {
        return read();
    } catch {
        return fallback;
    }
}

function isPlaying(player) {
    return safe(() => player.status === 'Playing', false);
}

// Duración de la pista en µs (0 si el reproductor no la da).
// ⚠️ Interno de GNOME 50: MprisPlayer no la expone; se lee del proxy.
function trackLength(player) {
    return safe(() => Number(player._playerProxy?.Metadata?.['mpris:length']?.deepUnpack() ?? 0), 0);
}

// trackid de la pista (para SetPosition). ⚠️ Interno de GNOME 50: del proxy.
function trackId(player) {
    return safe(() => player._playerProxy?.Metadata?.['mpris:trackid']?.deepUnpack() ?? null, null);
}

// Partes de una vista; update() rellena las que existan.
class TrackView {
    constructor({actor, cover = null, title = null, artist = null, player = null,
        playIcon = null, prev = null, next = null, appIcon = null, dot = null,
        coverLayers = null}) {
        // coverLayers: capas que solo tienen sentido con carátula (la
        // carátula misma incluida); sin carátula se ocultan.
        Object.assign(this, {actor, cover, title, artist, player, playIcon, prev, next,
            appIcon, dot, coverLayers});
        this.coverUrl = null;
    }

    update(current) {
        const setText = (label, text) => {
            if (label && label.text !== text)
                label.text = text;
        };
        setText(this.title, current?.trackTitle ?? 'Nada sonando');
        setText(this.artist, current?.trackArtists?.join(', ') ?? '');
        setText(this.player, current
            ? current.app?.get_name() ?? current.source?.title ?? ''
            : '');
        if (this.dot)
            this.dot.visible = Boolean(this.artist?.text);
        if (this.appIcon) {
            const gicon = current?.app?.get_icon() ?? null;
            if (gicon)
                this.appIcon.gicon = gicon;
            else
                this.appIcon.icon_name = FALLBACK_ICON;
        }

        // La carátula solo se vuelve a cargar si cambia la URL.
        if (this.cover) {
            const url = current?.trackCoverUrl || '';
            if (url !== this.coverUrl) {
                this.coverUrl = url;
                if (url) {
                    this.cover.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(url)});
                    this.cover.remove_style_class_name('no-cover');
                } else {
                    this.cover.icon_name = FALLBACK_ICON;
                    this.cover.add_style_class_name('no-cover');
                }
                for (const layer of this.coverLayers ?? [])
                    layer.visible = Boolean(url);
            }
        }

        if (this.playIcon) {
            this.playIcon.icon_name = current && isPlaying(current)
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
            this.playIcon.get_parent().reactive = current !== null;
        }
        if (this.prev)
            this.prev.reactive = current ? safe(() => current.canGoPrevious, false) : false;
        if (this.next)
            this.next.reactive = current ? safe(() => current.canGoNext, false) : false;
    }

    destroy() {
        this.actor.destroy();
    }
}

export const MusicModule = GObject.registerClass(
class MusicModule extends NotchModule {
    _init() {
        super._init();

        // player -> {playing, order}; `order` crece cada vez que un
        // reproductor empieza a sonar, para elegir el más reciente.
        this._players = new Map();
        this._order = 0;
        this._current = null;
        // Reproductor elegido a mano en el hover: {player, order}. Manda
        // hasta que otro empiece a sonar después de elegirlo.
        this._manual = null;
        this._playerButtons = new Map();   // player -> St.Button (hover)
        this._compactCoverUrl = null;

        this._exp = null;       // TrackView, se crean al primer uso
        this._card = null;
        this._page = null;

        // Progreso (solo con la página o el hover visibles). Cada vista con
        // barra: {box, bar, elapsed, end, total}; `total` = mostrar la
        // duración (hover) en lugar de lo que falta (página).
        this._progressViews = [];
        this._positionUs = 0;
        this._ticks = 0;
        this._tickId = 0;
        this._positionCancellable = null;

        // Aleatorio / repetir (solo con el hover visible). null = el
        // reproductor no lo admite (se oculta el botón).
        this._shuffle = null;
        this._loop = null;
        this._extrasPlayer = null;
        this._extrasSubscription = 0;
        this._extrasCancellable = null;
        this._mixer = null;

        this._buildCompact();

        // ⚠️ Interno de GNOME 50: el lector del calendario. Si cambia de
        // sitio en otra versión, creamos uno propio (un poco más de memoria).
        this._source =
            Main.panel.statusArea.dateMenu?._messageList?._messageView?._mediaSource ??
            new MprisSource();

        this._source.connectObject(
            'player-added', (_s, player) => this._addPlayer(player),
            'player-removed', (_s, player) => this._removePlayer(player),
            this);
        this._source.players.forEach(player => this._addPlayer(player));

        this._update();
    }

    get priority() {
        return PRIORITY;
    }

    get active() {
        return this._current !== null;
    }

    get compactActor() {
        return this._compact;
    }

    get hasExpanded() {
        return this._current !== null;
    }

    get expandedActor() {
        this._exp ??= this._buildExpanded();
        this._syncPlayerButtons();
        this._exp.update(this._current);
        return this._exp.actor;
    }

    get homeCard() {
        this._card ??= this._buildCard();
        this._card.update(this._current);
        return this._card.actor;
    }

    get pageActor() {
        this._page ??= this._buildPage();
        this._page.update(this._current);
        this._updateProgress();
        return this._page.actor;
    }

    get pageTitle() {
        return 'Música';
    }

    get pageIcon() {
        return 'folder-music-symbolic';
    }

    // --- Construcción de vistas --------------------------------------------

    _buildCompact() {
        this._compact = new St.BoxLayout({
            style_class: 'agent-notch-music',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._icon = new St.Icon({
            style_class: 'agent-notch-music-icon',
            icon_name: FALLBACK_ICON,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compact.add_child(this._icon);

        this._label = makeLabel('agent-notch-music-label', {y_align: Clutter.ActorAlign.CENTER});
        this._compact.add_child(this._label);

        this._bars = new EqualizerBars();
        this._compact.add_child(this._bars);
    }

    _onCompactVisibleChanged() {
        this._syncBars();
    }

    // Barritas animadas solo si suena y la compacta se ve.
    _syncBars() {
        this._bars?.setAnimating(this.compactVisible &&
            this._current !== null && isPlaying(this._current));
    }

    _button(styleClass, iconName, action) {
        const icon = new St.Icon({icon_name: iconName});
        const button = new St.Button({style_class: styleClass, can_focus: true, child: icon});
        button.connect('clicked', () => {
            if (this._current)
                safe(() => action(this._current), null);
        });
        return [button, icon];
    }

    _controls(styleClass, buttonClass, xAlign) {
        const box = new St.BoxLayout({style_class: styleClass, x_align: xAlign});
        const [prev] = this._button(buttonClass, 'media-skip-backward-symbolic', p => p.previous());
        const [play, playIcon] = this._button(`${buttonClass} play`, 'media-playback-start-symbolic', p => p.playPause());
        const [next] = this._button(buttonClass, 'media-skip-forward-symbolic', p => p.next());
        box.add_child(prev);
        box.add_child(play);
        box.add_child(next);
        return {box, prev, playIcon, next};
    }

    _coverButton(buttonClass, coverClass) {
        const cover = new St.Icon({style_class: coverClass});
        const button = new St.Button({
            style_class: buttonClass,
            child: cover,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Clic en la carátula: abrir el reproductor.
        button.connect('clicked', () => this._current?.raise());
        return [button, cover];
    }

    // Tarjeta del hover: carátula de fondo oscurecida y, encima,
    //   salida de audio ·································· abrir reproductor
    //               icono · Título • Artista
    //   ～～～～～～～～～～●─────────────────────────
    //   01:01                                                     03:18
    //            🔀      ⏮      ⏯      ⏭      🔁
    _buildExpanded() {
        const actor = new St.Widget({
            style_class: 'agent-notch-music-hero',
            layout_manager: new Clutter.BinLayout(),
        });

        // Capas: carátula · oscurecido · bordes fundidos con la isla · contenido.
        const backdrop = new CoverBackdrop({
            style_class: 'agent-notch-music-hero-backdrop',
            x_expand: true,
            y_expand: true,
        });
        actor.add_child(backdrop);
        const coverLayers = [backdrop.icon];
        const dim = new St.Widget({
            style_class: 'agent-notch-music-hero-dim',
            x_expand: true,
            y_expand: true,
        });
        actor.add_child(dim);
        coverLayers.push(dim);
        for (const [side, xAlign, yAlign] of [
            ['left', Clutter.ActorAlign.START, Clutter.ActorAlign.FILL],
            ['right', Clutter.ActorAlign.END, Clutter.ActorAlign.FILL],
            ['top', Clutter.ActorAlign.FILL, Clutter.ActorAlign.START],
            ['bottom', Clutter.ActorAlign.FILL, Clutter.ActorAlign.END],
        ]) {
            const fade = new St.Widget({
                style_class: `agent-notch-music-hero-fade ${side}`,
                x_expand: true,
                y_expand: true,
                x_align: xAlign,
                y_align: yAlign,
            });
            actor.add_child(fade);
            coverLayers.push(fade);
        }

        const content = new St.BoxLayout({
            style_class: 'agent-notch-music-hero-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        actor.add_child(content);

        // Arriba: salida de audio · abrir reproductor.
        const top = new St.BoxLayout({style_class: 'agent-notch-music-hero-top', x_expand: true});
        this._outputBox = new St.BoxLayout({
            style_class: 'agent-notch-music-hero-output-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._outputIcon = new St.Icon({
            style_class: 'agent-notch-music-hero-output-icon',
            icon_name: 'audio-speakers-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._outputLabel = makeLabel('agent-notch-music-hero-output', {y_align: Clutter.ActorAlign.CENTER});
        this._outputBox.add_child(this._outputIcon);
        this._outputBox.add_child(this._outputLabel);
        top.add_child(this._outputBox);
        top.add_child(new St.Widget({x_expand: true}));   // empuja lo demás a la derecha
        // Varios reproductores: un icono por cada uno para elegir cuál ver.
        this._playersBox = new St.BoxLayout({
            style_class: 'agent-notch-music-hero-players',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        top.add_child(this._playersBox);
        const raise = new St.Button({
            style_class: 'agent-notch-music-hero-small-button',
            can_focus: true,
            child: new St.Icon({icon_name: 'focus-windows-symbolic'}),
        });
        raise.connect('clicked', () => this._current?.raise());
        top.add_child(raise);
        content.add_child(top);

        // Icono de la app · Título • Artista
        const line = new St.BoxLayout({
            style_class: 'agent-notch-music-hero-line',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const appIcon = new St.Icon({
            style_class: 'agent-notch-music-hero-app',
            icon_name: FALLBACK_ICON,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = makeLabel('agent-notch-music-hero-title', {y_align: Clutter.ActorAlign.CENTER});
        const dot = new St.Label({
            style_class: 'agent-notch-music-hero-dot',
            text: '•',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const artist = makeLabel('agent-notch-music-hero-artist', {y_align: Clutter.ActorAlign.CENTER});
        line.add_child(appIcon);
        line.add_child(title);
        line.add_child(dot);
        line.add_child(artist);
        content.add_child(line);

        // Onda + tiempos.
        const progressBox = new St.BoxLayout({
            style_class: 'agent-notch-music-hero-progress',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const wave = new WaveProgress();
        wave.connect('seek', (_w, fraction) => this._seek(fraction));
        progressBox.add_child(wave);
        const times = new St.BoxLayout({x_expand: true});
        const elapsed = new St.Label({style_class: 'agent-notch-music-hero-time', x_expand: true});
        const end = new St.Label({style_class: 'agent-notch-music-hero-time'});
        times.add_child(elapsed);
        times.add_child(end);
        progressBox.add_child(times);
        content.add_child(progressBox);
        this._progressViews.push({box: progressBox, bar: wave, elapsed, end, total: true});

        // 🔀 ⏮ ⏯ ⏭ 🔁
        const controls = new St.BoxLayout({
            style_class: 'agent-notch-music-hero-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        [this._shuffleButton] = this._extraButton('media-playlist-shuffle-symbolic',
            () => this._toggleShuffle());
        const [prev] = this._button('agent-notch-music-hero-button',
            'media-skip-backward-symbolic', p => p.previous());
        const [play, playIcon] = this._button('agent-notch-music-hero-button play',
            'media-playback-start-symbolic', p => p.playPause());
        const [next] = this._button('agent-notch-music-hero-button',
            'media-skip-forward-symbolic', p => p.next());
        [this._loopButton, this._loopIcon] = this._extraButton('media-playlist-repeat-symbolic',
            () => this._cycleLoop());
        for (const b of [this._shuffleButton, prev, play, next, this._loopButton])
            controls.add_child(b);
        content.add_child(controls);

        this._exp = new TrackView({actor, cover: backdrop.icon, title, artist, playIcon, prev, next,
            appIcon, dot, coverLayers});
        this._showExtras();
        return this._exp;
    }

    // Botón pequeño (🔀 / 🔁 / abrir): se ilumina con la clase `on`.
    _extraButton(iconName, action) {
        const icon = new St.Icon({icon_name: iconName});
        const button = new St.Button({
            style_class: 'agent-notch-music-hero-small-button',
            can_focus: true,
            child: icon,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        button.connect('clicked', action);
        return [button, icon];
    }

    // Tarjeta de Home: carátula mini · título/artista · ⏯
    _buildCard() {
        const actor = new St.BoxLayout({style_class: 'agent-notch-card agent-notch-music-card'});
        const [coverButton, cover] = this._coverButton(
            'agent-notch-music-cover-button', 'agent-notch-music-card-cover');
        actor.add_child(coverButton);

        const info = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        actor.add_child(info);
        const title = makeLabel('agent-notch-card-title');
        const artist = makeLabel('agent-notch-card-subtitle');
        info.add_child(title);
        info.add_child(artist);

        const [play, playIcon] = this._button('agent-notch-music-button play',
            'media-playback-start-symbolic', p => p.playPause());
        play.y_align = Clutter.ActorAlign.CENTER;
        actor.add_child(play);

        return new TrackView({actor, cover, title, artist, playIcon});
    }

    // Página: carátula grande que se funde con el panel · artista ·
    // título · barra de progreso · controles
    _buildPage() {
        const actor = new St.BoxLayout({style_class: 'agent-notch-music-page'});

        // La carátula con un degradado encima en su borde derecho.
        const coverStack = new St.Widget({
            style_class: 'agent-notch-music-page-cover-stack',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        const [coverButton, cover] = this._coverButton(
            'agent-notch-music-page-cover-button', 'agent-notch-music-page-cover');
        coverStack.add_child(coverButton);
        coverStack.add_child(new St.Widget({
            style_class: 'agent-notch-music-page-fade',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.FILL,
            y_expand: true,
        }));
        actor.add_child(coverStack);

        const info = new St.BoxLayout({
            style_class: 'agent-notch-music-page-info',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        actor.add_child(info);

        const artist = makeLabel('agent-notch-music-page-artist');
        const title = makeLabel('agent-notch-music-page-title');
        const player = makeLabel('agent-notch-music-player');
        info.add_child(artist);
        info.add_child(title);
        info.add_child(player);

        // Progreso: barra + 0:54 ······ -2:21
        const progressBox = new St.BoxLayout({
            style_class: 'agent-notch-music-progress',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const bar = new Bar();
        progressBox.add_child(bar);
        const times = new St.BoxLayout({x_expand: true});
        const elapsed = new St.Label({style_class: 'agent-notch-music-time', x_expand: true});
        const remaining = new St.Label({style_class: 'agent-notch-music-time'});
        times.add_child(elapsed);
        times.add_child(remaining);
        progressBox.add_child(times);
        info.add_child(progressBox);
        this._progressViews.push({box: progressBox, bar, elapsed, end: remaining, total: false});

        const c = this._controls('agent-notch-music-page-controls', 'agent-notch-music-button big',
            Clutter.ActorAlign.CENTER);
        info.add_child(c.box);

        return new TrackView({actor, cover, title, artist, player,
            playIcon: c.playIcon, prev: c.prev, next: c.next});
    }

    // --- Reproductores ------------------------------------------------------

    _addPlayer(player) {
        if (this._players.has(player))
            return;

        const playing = isPlaying(player);
        this._players.set(player, {playing, order: playing ? ++this._order : 0});
        player.connectObject('changed', () => this._onPlayerChanged(player), this);
        this._update();
    }

    _removePlayer(player) {
        if (!this._players.delete(player))
            return;
        player.disconnectObject(this);
        if (this._manual?.player === player)
            this._manual = null;
        this._update();
    }

    // Clic en el icono de un reproductor en el hover.
    _selectPlayer(player) {
        if (!this._players.has(player))
            return;
        this._manual = {player, order: this._order};
        this._update();
    }

    // Iconos de los reproductores en el hover (solo si hay más de uno).
    // Se crean y destruyen solo cuando aparece o se va un reproductor.
    _syncPlayerButtons() {
        if (!this._playersBox)
            return;
        const players = [...this._players.keys()].filter(p => safe(() => p.canPlay, false));

        for (const [player, button] of this._playerButtons) {
            if (!players.includes(player)) {
                button.destroy();
                this._playerButtons.delete(player);
            }
        }
        for (const player of players) {
            let button = this._playerButtons.get(player);
            if (!button) {
                button = new St.Button({
                    style_class: 'agent-notch-music-hero-player',
                    can_focus: true,
                    child: new St.Icon({icon_name: FALLBACK_ICON}),
                });
                button.connect('clicked', () => this._selectPlayer(player));
                this._playersBox.add_child(button);
                this._playerButtons.set(player, button);
            }
            const gicon = safe(() => player.app?.get_icon(), null);
            if (gicon)
                button.child.gicon = gicon;
            if (player === this._current)
                button.add_style_class_name('current');
            else
                button.remove_style_class_name('current');
        }
        this._playersBox.visible = players.length > 1;
    }

    _onPlayerChanged(player) {
        const entry = this._players.get(player);
        if (!entry)
            return;

        const playing = isPlaying(player);
        if (playing && !entry.playing)
            entry.order = ++this._order;
        entry.playing = playing;
        this._update();
    }

    // 0) el elegido a mano en el hover, mientras ningún otro empiece a
    //    sonar después; 1) el que suena (el más reciente); 2) si no, el
    //    último que sonó.
    _choosePlayer() {
        if (this._manual) {
            const {player, order} = this._manual;
            const newer = [...this._players].some(([p, e]) =>
                p !== player && e.playing && e.order > order);
            if (this._players.has(player) && safe(() => player.canPlay, false) && !newer)
                return player;
            this._manual = null;
        }

        let best = null;
        let bestEntry = null;
        for (const [player, entry] of this._players) {
            if (!player.canPlay)
                continue;
            if (!bestEntry ||
                entry.playing > bestEntry.playing ||
                (entry.playing === bestEntry.playing && entry.order > bestEntry.order)) {
                best = player;
                bestEntry = entry;
            }
        }
        return best;
    }

    _update() {
        const player = this._choosePlayer();
        this._current = player;

        if (player) {
            const artists = player.trackArtists?.join(', ') ?? '';
            const text = artists ? `${player.trackTitle} — ${artists}` : player.trackTitle;
            // Solo tocar el texto si cambió (evita recalcular el diseño).
            if (this._label.text !== text)
                this._label.text = text;

            // Carátula mini si la hay (cargada a 18 px); si no, el icono de la app.
            const coverUrl = player.trackCoverUrl || '';
            if (coverUrl) {
                if (coverUrl !== this._compactCoverUrl) {
                    this._icon.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(coverUrl)});
                    this._icon.add_style_class_name('cover');
                }
            } else {
                const gicon = player.app?.get_icon() ?? null;
                if (gicon)
                    this._icon.gicon = gicon;
                else
                    this._icon.icon_name = FALLBACK_ICON;
                this._icon.remove_style_class_name('cover');
            }
            this._compactCoverUrl = coverUrl;

            if (isPlaying(player))
                this._compact.remove_style_class_name('paused');
            else
                this._compact.add_style_class_name('paused');
        }

        for (const view of [this._exp, this._card, this._page])
            view?.update(player);
        this._syncPlayerButtons();
        this._syncBars();
        this._updateProgress({resync: true});
        this._updateExtras(this.visibleViews.has('expanded'));

        this.emit('changed');
    }

    // --- Progreso (página u hover visibles) ---------------------------------

    _onViewsChanged(views) {
        this._updateProgress({resync: true});
        this._updateExtras(views.has('expanded'));
    }

    // Arranca o para el temporizador según haga falta y, si se pide,
    // vuelve a preguntar la posición al reproductor.
    _updateProgress({resync = false} = {}) {
        if (this._progressViews.length === 0)
            return;

        const player = this._current;
        const length = player ? trackLength(player) : 0;
        for (const view of this._progressViews)
            view.box.visible = length > 0;
        // Sin barra, la tarjeta del hover es más baja (sin hueco).
        if (length > 0)
            this._exp?.actor.remove_style_class_name('no-progress');
        else
            this._exp?.actor.add_style_class_name('no-progress');

        const views = this.visibleViews;
        const visible = Boolean((this._page && views.has('page')) ||
            (this._exp && views.has('expanded')));
        const wantTimer = visible && player !== null && length > 0 && isPlaying(player);

        if (wantTimer && !this._tickId) {
            this._ticks = 0;
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 1, () => {
                this._positionUs += 1e6;
                if (++this._ticks % RESYNC_EVERY_TICKS === 0)
                    this._syncPosition();
                this._showProgress();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wantTimer && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }

        if (visible && length > 0 && resync)
            this._syncPosition();
        this._showProgress();
    }

    // Llamada D-Bus asíncrona al reproductor actual.
    // ⚠️ Interno de GNOME 50: el nombre D-Bus está en `_busName`.
    _call(iface, method, params, replyType, cancellable, onReply = null) {
        const busName = this._current?._busName;
        if (!busName)
            return;
        Gio.DBus.session.call(busName, MPRIS_PATH, iface, method, params,
            replyType, Gio.DBusCallFlags.NONE, 1000, cancellable,
            (connection, result) => {
                let reply;
                try {
                    reply = connection.call_finish(result);
                } catch {
                    return;   // cancelado o el reproductor no lo admite
                }
                try {
                    onReply?.(reply);
                } catch (e) {
                    console.warn(`[agent-notch] música: ${method}: ${e.message}`);
                }
            });
    }

    // Posición real del reproductor (Properties.Get de MPRIS).
    _syncPosition() {
        const player = this._current;
        if (!player?._busName)
            return;

        this._positionCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._positionCancellable = cancellable;

        this._call(PROPS_IFACE, 'Get', new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'), cancellable, reply => {
                if (this._positionCancellable === cancellable)
                    this._positionCancellable = null;
                if (player !== this._current)
                    return;
                const [value] = reply.deepUnpack();
                this._positionUs = Number(value.deepUnpack());
                this._showProgress();
            });
    }

    // Clic o arrastre en la onda: saltar a esa posición (SetPosition).
    _seek(fraction) {
        const player = this._current;
        const length = player ? trackLength(player) : 0;
        const id = player ? trackId(player) : null;
        if (!length || !id)
            return;
        const position = Math.round(fraction * length);
        this._positionUs = position;
        this._showProgress();
        this._call(PLAYER_IFACE, 'SetPosition',
            new GLib.Variant('(ox)', [id, position]), null, null);
    }

    _showProgress() {
        const length = this._current ? trackLength(this._current) : 0;
        const position = Math.min(Math.max(0, this._positionUs), length);
        for (const view of this._progressViews) {
            if (!view.box.visible)
                continue;
            view.bar.setFraction(length > 0 ? position / length : 0);
            const elapsed = formatTime(position / 1e6, {padMinutes: view.total});
            const end = view.total
                ? formatTime(length / 1e6, {padMinutes: true})
                : `-${formatTime((length - position) / 1e6)}`;
            if (view.elapsed.text !== elapsed)
                view.elapsed.text = elapsed;
            if (view.end.text !== end)
                view.end.text = end;
        }
    }

    // --- Aleatorio, repetir y salida de audio (solo con el hover visible) ---

    // Empieza o deja de escuchar al reproductor actual y al mezclador.
    _updateExtras(visible) {
        const player = visible && this._exp ? this._current : null;

        if (player !== this._extrasPlayer) {
            this._extrasCancellable?.cancel();
            this._extrasCancellable = null;
            if (this._extrasSubscription) {
                Gio.DBus.session.signal_unsubscribe(this._extrasSubscription);
                this._extrasSubscription = 0;
            }
            this._extrasPlayer = player;
            this._shuffle = this._loop = null;

            if (player?._busName) {
                this._extrasSubscription = Gio.DBus.session.signal_subscribe(
                    player._busName, PROPS_IFACE, 'PropertiesChanged', MPRIS_PATH,
                    PLAYER_IFACE, Gio.DBusSignalFlags.NONE,
                    (_c, _sender, _path, _iface, _signal, params) => {
                        const [, changed] = params.deepUnpack();
                        this._readExtras(changed);
                    });
                this._extrasCancellable = new Gio.Cancellable();
                this._call(PROPS_IFACE, 'GetAll', new GLib.Variant('(s)', [PLAYER_IFACE]),
                    new GLib.VariantType('(a{sv})'), this._extrasCancellable,
                    reply => {
                        if (player === this._extrasPlayer)
                            this._readExtras(reply.deepUnpack()[0]);
                    });
            }
            this._showExtras();
        }

        // Salida de audio: el mezclador que ya tiene abierto GNOME.
        const wantMixer = visible && this._exp !== null;
        if (wantMixer && !this._mixer) {
            this._mixer = getMixerControl();
            this._mixer.connectObject(
                'default-sink-changed', () => this._showOutput(),
                'state-changed', () => this._showOutput(),
                this);
            this._showOutput();
        } else if (!wantMixer && this._mixer) {
            this._mixer.disconnectObject(this);
            this._mixer = null;
        }
    }

    _readExtras(props) {
        if ('Shuffle' in props)
            this._shuffle = Boolean(props.Shuffle.deepUnpack());
        if ('LoopStatus' in props)
            this._loop = String(props.LoopStatus.deepUnpack());
        this._showExtras();
    }

    _showExtras() {
        if (!this._shuffleButton)
            return;
        const toggle = (button, on) => {
            if (on)
                button.add_style_class_name('on');
            else
                button.remove_style_class_name('on');
        };
        this._shuffleButton.visible = this._shuffle !== null;
        toggle(this._shuffleButton, this._shuffle === true);
        this._loopButton.visible = this._loop !== null;
        toggle(this._loopButton, this._loop === 'Playlist' || this._loop === 'Track');
        this._loopIcon.icon_name = this._loop === 'Track'
            ? 'media-playlist-repeat-song-symbolic'
            : 'media-playlist-repeat-symbolic';
    }

    _setPlayerProperty(name, variant) {
        this._call(PROPS_IFACE, 'Set',
            new GLib.Variant('(ssv)', [PLAYER_IFACE, name, variant]), null, null);
    }

    _toggleShuffle() {
        if (this._shuffle === null)
            return;
        // Se ve al instante; PropertiesChanged lo confirma (o lo corrige).
        this._shuffle = !this._shuffle;
        this._showExtras();
        this._setPlayerProperty('Shuffle', new GLib.Variant('b', this._shuffle));
    }

    _cycleLoop() {
        if (this._loop === null)
            return;
        this._loop = LOOP_NEXT[this._loop] ?? 'None';
        this._showExtras();
        this._setPlayerProperty('LoopStatus', new GLib.Variant('s', this._loop));
    }

    _showOutput() {
        if (!this._outputBox)
            return;
        const sink = this._mixer?.get_state() === Gvc.MixerControlState.READY
            ? this._mixer.get_default_sink()
            : null;
        if (!sink) {
            this._outputBox.visible = false;
            return;
        }
        const port = safe(() => sink.get_port(), null);
        const name = port?.human_port || sink.get_description() || '';
        const headphones = ['headset', 'headphone'].includes(sink.get_form_factor()) ||
            (port?.port ?? '').toLowerCase().includes('headphone');
        if (this._outputLabel.text !== name)
            this._outputLabel.text = name;
        this._outputIcon.icon_name = headphones
            ? 'audio-headphones-symbolic'
            : 'audio-speakers-symbolic';
        this._outputBox.visible = name !== '';
    }

    destroy() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        this._positionCancellable?.cancel();
        this._positionCancellable = null;
        this._updateExtras(false);

        this._source?.disconnectObject(this);
        for (const player of this._players.keys())
            player.disconnectObject(this);
        this._players.clear();
        this._source = null;
        this._current = null;

        this._compact?.destroy();
        this._compact = this._icon = this._label = this._bars = null;
        this._playerButtons.clear();
        this._playersBox = null;
        this._manual = null;

        for (const view of [this._exp, this._card, this._page])
            view?.destroy();
        this._exp = this._card = this._page = null;
        this._progressViews = [];
        this._shuffleButton = this._loopButton = this._loopIcon = null;
        this._outputBox = this._outputIcon = this._outputLabel = null;
    }
});
