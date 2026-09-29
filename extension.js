// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.AppInfo, 'launch_default_for_uri_async');

// Exposed by the ec_su_axb35 driver, which reads EC register 0x31 — the
// register the physical P-MODE button sets. The driver does not call
// sysfs_notify(), so no event is available and we have to poll. Every read
// is an ACPI EC transaction, so keep this interval conservative.
const PMODE_PATH = '/sys/class/ec_su_axb35/apu/power_mode';
const PMODE_POLL_SECONDS = 3;

// The driver is not part of the kernel and this extension does not install
// it. The drop-down links here whenever it is missing.
const DRIVER_URL = 'https://github.com/cmetz/ec-su_axb35-linux';

// Only read once the node above is missing, to tell a module that is merely
// not loaded from one the running kernel has no build of — the usual state
// after a kernel update when the driver was installed with `make install`.
const OSRELEASE_PATH = '/proc/sys/kernel/osrelease';

// Live APU package power, published by amdgpu in microwatts. A plain sysfs
// read with no EC involved, so it can be polled a little faster. The hwmon
// number is not stable across boots and is resolved at runtime.
const HWMON_DIR = '/sys/class/hwmon';
const POWER_ATTR = 'power1_average';
const POWER_POLL_SECONDS = 2;

// NOTE: the embedded controller stores an ordinal (0/1/2), not a wattage.
// The figures below are those of the GMKtec EVO-X2. Other vendors using the
// AXB35-02 board may ship different presets — adjust here if yours differ.
const MODES = {
    'quiet':       {label: 'Quiet',       watts: 55,  emoji: '🌿'},
    'balanced':    {label: 'Balanced',    watts: 85,  emoji: '⚖️'},
    'performance': {label: 'Performance', watts: 120, emoji: '🚀'},
};
const ORDER = ['quiet', 'balanced', 'performance'];

// The promisified call drops load_contents_finish()'s leading `true`.
async function readText(file, cancellable) {
    const [contents] = await file.load_contents_async(cancellable);
    return new TextDecoder().decode(contents).trim();
}

function isCancelled(error) {
    return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

const PModeIndicator = GObject.registerClass(
class PModeIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.5, 'P-MODE Indicator');

        this._settings = settings;
        this._cancellable = new Gio.Cancellable();
        this._modeFile = Gio.File.new_for_path(PMODE_PATH);
        this._powerFile = null;
        this._mode = undefined;
        this._power = null;
        this._readingMode = false;
        this._readingPower = false;
        this._checkingModule = false;
        this._modeTimeoutId = null;
        this._powerTimeoutId = null;

        // Emoji rather than a symbolic icon: the Adwaita power-profile icons
        // are already used by GNOME's own Power Mode menu, which shows a
        // different thing entirely (the amd_pstate EPP hint, not the EC budget).
        // Two labels so the reading can carry its own font size. Reading
        // first, emoji on the right.
        const box = new St.BoxLayout({style_class: 'pmode-box'});
        this._wattsLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pmode-watts',
        });
        this._emojiLabel = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._wattsLabel);
        box.add_child(this._emojiLabel);
        this.add_child(box);

        this._items = new Map();
        for (const key of ORDER) {
            const {label, watts, emoji} = MODES[key];
            // Read-only: the button is physical, writing would need root.
            const item = new PopupMenu.PopupMenuItem(
                `${emoji}  ${label} — ${watts} W`, {reactive: false});
            this.menu.addMenuItem(item);
            this._items.set(key, item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._powerSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Live power reading', this._settings.get_boolean('show-power'));
        this._powerSwitch.connect('toggled', (item, state) => {
            this._settings.set_boolean('show-power', state);
        });
        // Until the amdgpu hwmon has been found.
        this._powerSwitch.setSensitive(false);
        this.menu.addMenuItem(this._powerSwitch);
        this._settingsId = this._settings.connect('changed::show-power', () => {
            this._powerSwitch.state = this._settings.get_boolean('show-power');
            this._syncPowerPolling();
        });

        // Only shown when something is wrong: with the panel and the check
        // mark both saying which mode is active, a status line would be
        // redundant the rest of the time.
        this._statusItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            style_class: 'pmode-status-item',
        });
        this._statusItem.visible = false;
        this.menu.addMenuItem(this._statusItem);

        this._driverItem = new PopupMenu.PopupMenuItem('Driver installation instructions…');
        this._driverItem.connect('activate', () => this._openDriverPage());
        this._driverItem.visible = false;
        this.menu.addMenuItem(this._driverItem);

        this._readMode();
        this._modeTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, PMODE_POLL_SECONDS, () => {
                this._readMode();
                return GLib.SOURCE_CONTINUE;
            });

        this._findPowerFile().then(file => {
            if (this._cancellable.is_cancelled() || !file)
                return;
            this._powerFile = file;
            this._powerSwitch.setSensitive(true);
            this._syncPowerPolling();
        });
    }

    // The amdgpu hwmon index varies between boots, so look it up by name.
    async _findPowerFile() {
        const dir = Gio.File.new_for_path(HWMON_DIR);
        const names = [];
        try {
            const iter = await dir.enumerate_children_async('standard::name',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
            let infos;
            while ((infos = await iter.next_files_async(16,
                GLib.PRIORITY_DEFAULT, this._cancellable)).length > 0)
                names.push(...infos.map(info => info.get_name()));
        } catch {
            return null;
        }

        for (const name of names) {
            const hwmon = dir.get_child(name);
            try {
                if (await readText(hwmon.get_child('name'), this._cancellable) !== 'amdgpu')
                    continue;
                const power = hwmon.get_child(POWER_ATTR);
                await readText(power, this._cancellable);
                return power;
            } catch (e) {
                if (isCancelled(e))
                    return null;
            }
        }
        return null;
    }

    // Nothing is polled while the reading is switched off.
    _syncPowerPolling() {
        const wanted = this._powerFile !== null &&
            this._settings.get_boolean('show-power');

        if (wanted && !this._powerTimeoutId) {
            this._readPower();
            this._powerTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, POWER_POLL_SECONDS, () => {
                    this._readPower();
                    return GLib.SOURCE_CONTINUE;
                });
        } else if (!wanted && this._powerTimeoutId) {
            GLib.Source.remove(this._powerTimeoutId);
            this._powerTimeoutId = null;
            this._power = null;
            this._setLabel();
        }
    }

    async _readMode() {
        if (this._readingMode)
            return; // previous read still in flight
        this._readingMode = true;
        let mode;
        try {
            mode = await readText(this._modeFile, this._cancellable);
        } catch (e) {
            if (isCancelled(e))
                return;
            // A missing node means no driver; any other error comes from the
            // EC itself and is reported like an unknown value.
            mode = e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)
                ? null
                : 'error';
        } finally {
            this._readingMode = false;
        }
        this._updateMode(mode);
    }

    async _readPower() {
        if (this._readingPower)
            return;
        this._readingPower = true;
        let watts = null;
        try {
            const uw = parseInt(await readText(this._powerFile, this._cancellable), 10);
            if (Number.isFinite(uw))
                watts = Math.round(uw / 1000000);
        } catch (e) {
            if (isCancelled(e))
                return;
        } finally {
            this._readingPower = false;
        }
        // The reading may have been switched off while this one was in flight.
        if (!this._powerTimeoutId || watts === this._power)
            return;
        this._power = watts;
        this._setLabel();
    }

    // Panel shows the live draw with the button position to its right,
    // e.g. "34 W ⚖️". The reading is padded with U+2007 FIGURE SPACE, whose
    // advance equals a digit's, so the indicator keeps a constant width from
    // 9 W to 115 W instead of nudging its neighbours every couple of seconds.
    _setLabel() {
        const info = MODES[this._mode];
        this._emojiLabel.text = info ? info.emoji : '?';
        this._wattsLabel.text = this._power === null
            ? ''
            : `${String(this._power).padStart(3, ' ')} W`;
    }

    _updateMode(mode) {
        if (mode === this._mode)
            return;
        this._mode = mode;
        this._setLabel();

        if (MODES[mode]) {
            this._statusItem.visible = false;
            this._driverItem.visible = false;
        } else if (mode !== null) {
            this._setStatus('Unexpected answer from the EC');
            this._driverItem.visible = false;
        } else {
            this._setStatus('ec_su_axb35 driver not loaded');
            this._driverItem.visible = true;
            this._checkModuleInstalled();
        }

        for (const [key, item] of this._items) {
            // NONE keeps the ornament column, so the checked entry stays
            // aligned with the others, but draws nothing — NO_DOT would put
            // an empty circle in front of every inactive mode.
            item.setOrnament(key === mode
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }
    }

    _setStatus(text) {
        this._statusItem.label.text = text;
        this._statusItem.visible = true;
    }

    // modules.dep lists every module modprobe can find for a given kernel.
    // Read only on the transition into the error state, so about a megabyte
    // once rather than on every poll.
    async _checkModuleInstalled() {
        if (this._checkingModule)
            return;
        this._checkingModule = true;
        try {
            const release = await readText(
                Gio.File.new_for_path(OSRELEASE_PATH), this._cancellable);
            const deps = await readText(
                Gio.File.new_for_path(`/lib/modules/${release}/modules.dep`),
                this._cancellable);
            // Matches a plain `make install` (updates/ec_su_axb35.ko) as well
            // as DKMS's compressed updates/dkms/ec_su_axb35.ko.zst. The node
            // may have appeared while the file was being read.
            if (!/(^|\/)ec_su_axb35\.ko/m.test(deps) && this._mode === null)
                this._setStatus(`ec_su_axb35 driver not installed for kernel ${release}`);
        } catch {
            // Cancelled, or no modules.dep: "not loaded" is all we can say.
        } finally {
            this._checkingModule = false;
        }
    }

    async _openDriverPage() {
        try {
            await Gio.AppInfo.launch_default_for_uri_async(DRIVER_URL,
                global.create_app_launch_context(0, -1), null);
        } catch (e) {
            console.error(`Cannot open ${DRIVER_URL}: ${e.message}`);
        }
    }

    destroy() {
        if (this._modeTimeoutId) {
            GLib.Source.remove(this._modeTimeoutId);
            this._modeTimeoutId = null;
        }
        if (this._powerTimeoutId) {
            GLib.Source.remove(this._powerTimeoutId);
            this._powerTimeoutId = null;
        }
        this._cancellable.cancel();
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = null;
        }
        this._settings = null;
        super.destroy();
    }
});

export default class PModeIndicatorExtension extends Extension {
    enable() {
        this._indicator = new PModeIndicator(this.getSettings());
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
