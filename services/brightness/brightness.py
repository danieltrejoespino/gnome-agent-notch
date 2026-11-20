#!/usr/bin/env python3
"""Brillo de monitores externos por DDC/CI: servicio D-Bus aparte.

Ver docs/17-brillo-monitor.md. Lo arranca el D-Bus de sesión al llamar a
cualquier método (activación D-Bus) y se cierra solo tras IDLE_EXIT_S sin
llamadas. Habla con los monitores con `ddcutil` (DDC/CI es lento: ~0,8 s
para buscar monitores, ~0,13 s por lectura o escritura), por eso no va
dentro de GNOME Shell.

Las llamadas a ddcutil van en hilos; las respuestas D-Bus se devuelven
siempre desde el bucle principal (GLib.idle_add).
"""

import re
import shutil
import subprocess
import sys
import threading

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

BUS_NAME = 'dev.agentnotch.Brightness'
OBJECT_PATH = '/dev/agentnotch/Brightness'
INTERFACE = 'dev.agentnotch.Brightness'

INTERFACE_XML = f'''
<node>
  <interface name="{INTERFACE}">
    <method name="Detect">
      <arg name="displays" type="a(issuu)" direction="out"/>
    </method>
    <method name="Get">
      <arg name="bus" type="i" direction="in"/>
      <arg name="current" type="u" direction="out"/>
      <arg name="max" type="u" direction="out"/>
    </method>
    <method name="Set">
      <arg name="bus" type="i" direction="in"/>
      <arg name="value" type="u" direction="in"/>
    </method>
  </interface>
</node>
'''

VCP_BRIGHTNESS = '10'
DDCUTIL_TIMEOUT_S = 10
IDLE_EXIT_S = 30        # sin llamadas → se cierra

DISPLAY_RE = re.compile(r'^Display \d+\s*$')
BUS_RE = re.compile(r'^\s*I2C bus:\s*/dev/i2c-(\d+)')
MONITOR_RE = re.compile(r'^\s*Monitor:\s*(.*?)\s*$')
VCP_RE = re.compile(r'^VCP\s+10\s+C\s+(\d+)\s+(\d+)')


def log(msg):
    print(f'[agent-notch] brightness: {msg}', file=sys.stderr, flush=True)


class DdcError(Exception):
    pass


def ddcutil(*args):
    exe = shutil.which('ddcutil')
    if not exe:
        raise DdcError('ddcutil is not installed')
    try:
        result = subprocess.run([exe, *args], capture_output=True, text=True,
                                timeout=DDCUTIL_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired as e:
        raise DdcError(f'ddcutil {args[0]}: tiempo agotado') from e
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise DdcError(f'ddcutil {args[0]}: {detail[-1] if detail else result.returncode}')
    return result.stdout


def read_brightness(bus):
    out = ddcutil('getvcp', VCP_BRIGHTNESS, '--bus', str(bus), '--brief')
    for line in out.splitlines():
        m = VCP_RE.match(line.strip())
        if m:
            return int(m.group(1)), int(m.group(2))
    raise DdcError(f'unexpected getvcp answer: {out.strip()!r}')


def detect():
    """[(bus, id 'VENDOR:MODELO:SERIE', modelo, brillo, máximo)]

    Solo los monitores que responden por DDC/CI ("Display N"); los
    "Invalid display" (pantalla del portátil, adaptadores que no dejan
    pasar DDC) se saltan.
    """
    displays = []
    current = None
    for line in ddcutil('detect', '--brief').splitlines():
        if DISPLAY_RE.match(line):
            current = {}
            displays.append(current)
        elif not line.strip() or not line.startswith(' '):
            current = None
        elif current is not None:
            if m := BUS_RE.match(line):
                current['bus'] = int(m.group(1))
            elif m := MONITOR_RE.match(line):
                current['id'] = m.group(1)

    found = []
    for d in displays:
        if 'bus' not in d:
            continue
        ident = d.get('id', '')
        parts = ident.split(':')
        model = parts[1] if len(parts) > 1 and parts[1] else ident or f'i2c-{d["bus"]}'
        try:
            value, maximum = read_brightness(d['bus'])
        except DdcError as e:
            log(f'bus {d["bus"]}: {e}')
            continue
        found.append((d['bus'], ident, model, value, maximum))
    return found


class Writer:
    """Escrituras de un bus: solo cuenta el último valor pedido.

    Mientras se arrastra la barra llegan valores más rápido de lo que el
    monitor los acepta; los intermedios se descartan.
    """

    def __init__(self, bus, on_idle):
        self._bus = bus
        self._on_idle = on_idle
        self._lock = threading.Lock()
        self._pending = None
        self._busy = False

    @property
    def busy(self):
        with self._lock:
            return self._busy

    def set(self, value):
        with self._lock:
            self._pending = value
            if self._busy:
                return
            self._busy = True
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while True:
            with self._lock:
                value, self._pending = self._pending, None
                if value is None:
                    self._busy = False
                    break
            try:
                ddcutil('setvcp', VCP_BRIGHTNESS, str(value), '--bus', str(self._bus),
                        '--noverify')
            except DdcError as e:
                log(f'bus {self._bus}: {e}')
        GLib.idle_add(self._on_idle)


class Service:
    def __init__(self):
        self._loop = GLib.MainLoop()
        self._node = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML)
        self._writers = {}
        self._jobs = 0          # Detect/Get en marcha
        self._idle_id = 0
        self._owned = False

    def run(self):
        Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
                         self._on_bus_acquired, self._on_name_acquired, self._on_name_lost)
        self._touch()
        self._loop.run()

    def _on_bus_acquired(self, conn, _name):
        conn.register_object_with_closures2(OBJECT_PATH, self._node.interfaces[0],
                                            self._on_method_call, None, None)

    def _on_name_acquired(self, _conn, _name):
        self._owned = True

    def _on_name_lost(self, _conn, _name):
        # Si ya era nuestro, es que el bus se ha cerrado (fin de la sesión).
        if not self._owned:
            log('could not take the bus name (is another one running?)')
        self._loop.quit()

    def _on_method_call(self, _conn, _sender, _path, _iface, method, params, invocation):
        self._touch()
        if method == 'Detect':
            self._in_thread(invocation, lambda: GLib.Variant('(a(issuu))', (detect(),)))
        elif method == 'Get':
            (bus,) = params.unpack()
            self._in_thread(invocation, lambda: GLib.Variant('(uu)', read_brightness(bus)))
        elif method == 'Set':
            bus, value = params.unpack()
            invocation.return_value(None)
            writer = self._writers.get(bus)
            if writer is None:
                writer = self._writers[bus] = Writer(bus, self._touch)
            writer.set(value)
        else:
            invocation.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod', method)

    def _in_thread(self, invocation, work):
        self._jobs += 1

        def run():
            try:
                result, error = work(), None
            except DdcError as e:
                result, error = None, str(e)
            except Exception as e:  # noqa: BLE001 - cualquier fallo se devuelve
                log(f'failed: {e!r}')
                result, error = None, repr(e)
            GLib.idle_add(reply, result, error)

        def reply(result, error):
            self._jobs -= 1
            if error is None:
                invocation.return_value(result)
            else:
                invocation.return_dbus_error(f'{INTERFACE}.Error', error)
            self._touch()
            return GLib.SOURCE_REMOVE

        threading.Thread(target=run, daemon=True).start()

    def _touch(self):
        """Reinicia la cuenta atrás para cerrarse."""
        if self._idle_id:
            GLib.source_remove(self._idle_id)
        self._idle_id = GLib.timeout_add_seconds(IDLE_EXIT_S, self._on_idle_timeout)
        return GLib.SOURCE_REMOVE

    def _on_idle_timeout(self):
        self._idle_id = 0
        if self._jobs or any(w.busy for w in self._writers.values()):
            self._touch()
        else:
            self._loop.quit()
        return GLib.SOURCE_REMOVE


if __name__ == '__main__':
    Service().run()
