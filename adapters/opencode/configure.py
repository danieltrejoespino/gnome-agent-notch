#!/usr/bin/env python3
"""Añade o quita el plugin de agent-notch en OpenCode.

    configure.py install     instala el plugin (si ya estaba, lo deja al día)
    configure.py uninstall   lo quita
    configure.py status      dice si está (código 0 = sí, 1 = no)

OpenCode carga los plugins de ~/.config/opencode/plugins/*.js
($XDG_CONFIG_HOME/opencode/plugins). Ahí se deja un archivo pequeño,
agent-notch.js, que carga el adaptador de esta carpeta (agent-notch.js junto a
este script): así una actualización de agent-notch llega sola, sin volver a
configurar. Si el adaptador desaparece (al desinstalar agent-notch sin quitar
el plugin), el archivo no hace nada en lugar de dar error.

--plugin RUTA elige qué adaptador usar; por defecto, el de esta carpeta. Sirve
tanto para la copia instalada (~/.local/share/agent-notch/adapters/) como para
un repo clonado.

Solo toca su propio archivo: los demás plugins quedan igual. OpenCode 2 carga
los plugins en su servicio de fondo (`opencode serve --service`), que sigue
vivo al cerrar OpenCode: para que cargue el plugin hay que pararlo
(pkill -f 'opencode serve'); OpenCode lo vuelve a lanzar al abrirlo.
"""

import argparse
import json
import os
import sys

MARKER = "agent-notch: cargador del plugin (lo crea adapters/opencode/configure.py)"
FILENAME = "agent-notch.js"


def plugins_dir():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "opencode", "plugins")


def loader(plugin):
    url = "file://" + plugin
    return """// %s
// Carga el adaptador de agent-notch. Si ya no existe, no hace nada.
let mod = null;
try {
  mod = await import(%s);
} catch {}
export default mod?.default ?? { id: "agent-notch", setup: async () => async () => {} };
""" % (MARKER, json.dumps(url))


def current(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Plugin de agent-notch para OpenCode.")
    parser.add_argument("action", choices=("install", "uninstall", "status"))
    parser.add_argument("--plugin", default=os.path.join(here, "agent-notch.js"),
                        help="adaptador a usar (por defecto, el de esta carpeta)")
    args = parser.parse_args(argv)
    plugin = os.path.abspath(args.plugin)
    path = os.path.join(plugins_dir(), FILENAME)
    text = current(path)
    ours = text is not None and MARKER in text

    if args.action == "status":
        if ours and text == loader(plugin):
            print("agent-notch: el plugin de OpenCode está en %s" % path)
            return 0
        print("agent-notch: el plugin de OpenCode no está configurado en %s" % path)
        return 1

    if args.action == "install":
        if not os.path.isfile(plugin):
            sys.exit("agent-notch: no existe %s" % plugin)
        if text is not None and not ours:
            sys.exit("agent-notch: %s existe y no es de agent-notch; no lo toco." % path)
        if text == loader(plugin):
            print("agent-notch: el plugin de OpenCode ya estaba en %s" % path)
            return 0
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = os.path.join(os.path.dirname(path), ".%s.%d.tmp" % (FILENAME, os.getpid()))
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(loader(plugin))
        os.replace(tmp, path)
        print("agent-notch: plugin de OpenCode instalado en %s" % path)
        print("agent-notch: OpenCode lo carga al arrancar su servicio de fondo. Si ya está "
              "en marcha, ciérralo (pkill -f 'opencode serve') y vuelve a abrir OpenCode.")
        return 0

    if ours and text != loader(plugin):
        # Apunta a otra copia (p. ej. un repo clonado): se deja, como el hook
        # de Claude Code.
        print("agent-notch: el plugin de OpenCode apunta a otra copia; lo dejo (%s)" % path)
    elif ours:
        os.unlink(path)
        print("agent-notch: plugin de OpenCode quitado de %s" % path)
    else:
        print("agent-notch: el plugin de OpenCode no estaba en %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
