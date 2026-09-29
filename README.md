# AXB35 P-MODE Indicator

A GNOME Shell extension that shows, in the top bar, the position of the
physical **P-MODE** button of mini PCs built on the Sixunited AXB35-02 board
(AMD Ryzen AI Max "Strix Halo"), together with the live APU power draw.

<img width="351" alt="Top bar indicator with its drop-down menu" src="https://github.com/user-attachments/assets/3a76e482-0fc7-4eae-8dba-2211be2b013b" />

| Button position | Top bar |
|---|---|
| `quiet`       | 34 W 🌿 |
| `balanced`    | 34 W ⚖️ |
| `performance` | 34 W 🚀 |

Boards and machines known to use the AXB35-02:
GMKtec EVO-X2, Bosgame M5, FEVM FA-EX9, Peladn YO1, NIMO AI MiniPC,
Corsair AI Workstation 300.

## ⚠️ Requirement: the `ec_su_axb35` kernel driver

**This extension does not work on its own.** The P-MODE position lives in the
board's embedded controller, which only the out-of-tree
[**ec-su_axb35-linux**](https://github.com/cmetz/ec-su_axb35-linux) driver
exposes to Linux. The extension does not install it: install it first if you
have not already.

1. Install the driver by following
   [its instructions](https://github.com/cmetz/ec-su_axb35-linux#build-instructions).
   Prefer DKMS (Ubuntu scripts in
   [`contrib/ubuntu/`](https://github.com/cmetz/ec-su_axb35-linux/tree/main/contrib/ubuntu)):
   a plain `sudo make install` builds the module for the running kernel only,
   and it disappears at the next kernel update.
2. Check that it is loaded:
   ```bash
   cat /sys/class/ec_su_axb35/apu/power_mode
   ```
   This should print `quiet`, `balanced` or `performance`.
3. Load it at every boot:
   ```bash
   echo ec_su_axb35 | sudo tee /etc/modules-load.d/ec_su_axb35.conf
   ```

Without the driver the top bar shows `?`, and the drop-down says what is
missing and links to the driver's instructions.

## Installation

### From extensions.gnome.org

Search for **AXB35 P-MODE Indicator** on
[extensions.gnome.org](https://extensions.gnome.org/) or in the Extension
Manager app.

### From source

```bash
git clone https://github.com/laurentpayot/gnome-shell-extension-axb35-pmode.git
cd gnome-shell-extension-axb35-pmode
make install
```

Log out and back in (GNOME Shell only discovers new extensions at login, and
cannot be restarted in place under Wayland), then:

```bash
gnome-extensions enable axb35-pmode@laurentpayot.github.io
```

## What it shows

**Button position.** The emoji follows the P-MODE button, read from
`/sys/class/ec_su_axb35/apu/power_mode` every 3 seconds. The drop-down lists
the three modes and checks the active one. It is read-only: the button is
physical, and writing to the embedded controller would need root.

**Live power draw.** The figure left of the emoji is the APU package power
that `amdgpu` publishes in `/sys/class/hwmon/hwmonN/power1_average`, read every
2 seconds. It is the current draw, not the budget: a short burst goes well
above the nominal figure before the sustained limit takes over. A switch in
the drop-down turns it off, which stops the polling altogether.

**Wattage labels.** The embedded controller stores an ordinal, not a wattage.
The 55 / 85 / 120 W figures in the drop-down are those of the GMKtec EVO-X2
and are **not read from the hardware**; other vendors may ship different
presets.

GNOME's own Power Mode menu cannot show any of this: there is no ACPI
`platform_profile` on this board, so power-profiles-daemon only drives the
`amd_pstate` EPP hint and never touches the embedded controller.

## Troubleshooting

When the driver is missing, the drop-down says why:

- **ec_su_axb35 driver not installed for kernel X**: the running kernel has no
  build of the module, typically right after a kernel update when the driver
  was installed with `make install`. Rebuild it
  (`make && sudo make install && sudo modprobe ec_su_axb35` in the driver's
  directory), or move to DKMS so this happens by itself.
- **ec_su_axb35 driver not loaded**: the module is installed but not loaded.
  Run `sudo modprobe ec_su_axb35`.

The indicator picks the driver up within 3 seconds, no need to log out.

## Development

```bash
make pack    # builds axb35-pmode@laurentpayot.github.io.shell-extension.zip
make lint    # runs shexli, the analyzer extensions.gnome.org uses (pip install shexli)
```

Tested on a GMKtec EVO-X2 with Ubuntu 26.04 and GNOME Shell 50.

## License

GPL-2.0-or-later. Not affiliated with Sixunited, GMKtec or any other vendor
named above.
