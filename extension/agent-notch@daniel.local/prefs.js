// Ventana de preferencias de agent-notch (docs/20-preferencias.md): la abre
// la app Extensiones, en un proceso aparte de GNOME Shell y solo mientras
// está abierta. Cada interruptor está enlazado a su clave con settings.bind:
// la extensión se entera por la señal `changed` (sin sondeo).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// [clave, título, subtítulo]
const TABS = [
    ['modulo-agentes', 'Agentes', 'Claude Code, OpenCode… en la isla y en su pestaña'],
    ['modulo-musica', 'Música', 'Lo que suena y sus controles'],
    ['modulo-sistema', 'Sistema', 'RAM, CPU, red y velocidad de internet'],
    ['modulo-docker', 'Docker', 'Contenedores; solo sale si Docker está instalado'],
    ['modulo-portapapeles', 'Portapapeles', 'Historial con búsqueda y fijados'],
    ['modulo-concentracion', 'Concentración', 'Temporizador de trabajo'],
];

export default class AgentNotchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;   // que viva lo mismo que la ventana

        const page = new Adw.PreferencesPage({
            title: 'Ajustes',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // --- Pestañas -------------------------------------------------------
        const tabs = new Adw.PreferencesGroup({
            title: 'Pestañas',
            description: 'Una pestaña apagada no se carga, así que no ocupa memoria. ' +
                'Al cambiarlas, la isla se reinicia.',
        });
        for (const [key, title, subtitle] of TABS)
            tabs.add(this._switch(settings, key, title, subtitle));
        page.add(tabs);

        // --- Avisos de agentes ----------------------------------------------
        const alerts = new Adw.PreferencesGroup({
            title: 'Avisos de agentes',
            description: 'Cuando un agente te necesita. Con «No molestar» de GNOME no hay ' +
                'ni banner ni sonido.',
        });
        alerts.add(this._switch(settings, 'sonido-atencion', 'Sonido',
            'Un aviso corto del tema de sonido'));
        alerts.add(this._switch(settings, 'banner-atencion', 'Banner «te necesita»',
            'La isla se despliega con el aviso; clic → la terminal del agente'));
        const seconds = Adw.SpinRow.new_with_range(2, 30, 1);
        seconds.title = 'Duración del banner';
        seconds.subtitle = 'Segundos (con el ratón encima, espera a que salga)';
        settings.bind('banner-segundos', seconds, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('banner-atencion', seconds, 'sensitive', Gio.SettingsBindFlags.GET);
        alerts.add(seconds);
        page.add(alerts);

        // --- Aspecto --------------------------------------------------------
        const look = new Adw.PreferencesGroup({title: 'Aspecto'});
        look.add(this._switch(settings, 'agentes-dos-lineas', 'Agentes en dos líneas',
            'Ojos arriba y el texto debajo; la isla crece un poco con agentes activos'));
        look.add(this._switch(settings, 'animar-ojos', 'Animar los ojos',
            'Parpadeo, pulso y destello. «Reducir animaciones» de GNOME las apaga siempre'));
        page.add(look);

        // --- Atajos y actualizaciones ---------------------------------------
        const more = new Adw.PreferencesGroup({title: 'Atajos y actualizaciones'});
        more.add(this._switch(settings, 'atajo-portapapeles', 'Super+V abre el Portapapeles',
            'Si lo apagas, GNOME recupera su atajo'));
        more.add(this._switch(settings, 'aviso-actualizaciones', 'Avisar de versiones nuevas',
            'Una consulta diaria a GitHub y el botón «Actualizar» en la isla ' +
            '(solo con versiones instaladas desde GitHub)'));
        more.add(new Adw.ActionRow({
            title: 'Versión',
            subtitle: this.metadata['version-name'] ?? 'desconocida',
        }));
        page.add(more);
    }

    _switch(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
