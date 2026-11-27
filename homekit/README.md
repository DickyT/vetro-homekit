# HomeKit

Makes the TV a native Apple HomeKit Television accessory. Add it in the Home app and you get power, the HDMI inputs named after what is plugged in, AirPlay and any apps you choose as inputs, the Control Center remote, and volume. No Homebridge and no Home Assistant: the Shard speaks HomeKit itself.

Open the Shard's tab to pair it (the page shows the setup code) and to change its settings. Project page, source and guide: [github.com/DickyT/vetro-homekit](https://github.com/DickyT/vetro-homekit).

It needs a TV whose Vetro runs a recent Node (developed on Node 18). It is written in modern JavaScript, not ES5, so it does not load on older TVs.

## Permissions

`exec`. HomeKit needs the TV's real state (power, input, volume, what is on each HDMI port), and the power features use Samsung's own power service; none of that is available without root commands. The full list is below.

## Commands it runs

All commands run through `ctx.execute`. Remote keys do not: they go through Vetro's `/control` endpoint.

| Command | When | Why |
|---|---|---|
| `/usr/bin/dotnet …/TvState.dll` (Vetro's own state reader) | Every 10 s while on | Volume, mute and the active source |
| `vconftool get memory/appfw/current_fullscreen_appid` | With the above | Which app is in front, for the current input |
| `vconftool get memory/pm/state` | With the above | Whether the TV is on or going off |
| `gdbus call … org.tizen.system.deviced.display.GetPowerState` / `GetScreenState` | With the above, and before a power key | Whether the screen is lit. The power key is a toggle, so it is only pressed when the TV says it is dark |
| `cat /sys/class/extcon/extcon0/state` | Every 10 s while on | Which HDMI ports have something plugged in |
| `cat` of the TV's `.sourceCache` (in `com.samsung.tv.home.sidebar` or `com.samsung.tv.csfs`) | With the above | The HDMI-CEC names of the plugged-in devices |
| `/usr/bin/app_launcher -s <app id>` | When an app or AirPlay is chosen as the input in Home | Starts that app |
| `pgrep -f` / `pkill -f` for this Shard's own watcher | At start, after each wake, at stop | Checks, restarts and stops the power watcher. The patterns match only that script and its `dbus-monitor` |
| `systemd-run --scope bash -c <script>` (falls back to plain `bash -c`) | At start and after a setting changes | Starts the power watcher, below |

**The power watcher** is one bash script that stays running outside Vetro, so it keeps working while the TV suspends Vetro. It runs:

| Command | Why |
|---|---|
| `dbus-monitor --system` on `EnterStandby` and `SystemResume` | To learn that the TV is powering off or has woken |
| `curl -X POST http://127.0.0.1:<port>/plugins/homekit/api/standby` and `…/power/<state>/<reason>` | To tell this Shard, so Home shows the right state at once |
| `gdbus call … display.GetPowerState` | To tell a lit wake from a dark one |
| `gdbus call … display.SetEntryModeDirectLPM 1 <pid>` / `UnSetEntryModeDirectLPM` | Only in "Stay in low power": asks the TV to stop at low power on the next power-off, or drops that request |
| `gdbus call … display.RequestAmbientPowerOff` | Only with "Deep sleep after": sends the TV from low power to a full sleep when the time is up |

It writes a short log to `/tmp/vetro-homekit-power.log` and two small state files next to it.

## Network

Local network only. Nothing is sent to the internet and nothing is collected.

- **HomeKit controllers** (iPhone, HomePod, Apple TV) connect to the Shard on a TCP port it chooses (50000-59999).
- **Bonjour**: the service is published through the TV's own `mdnsd`, or, if that is unavailable, by answering on UDP 5353.
- **Vetro on loopback** (`127.0.0.1`): `/control` for remote keys, `/apps` for the app list.
- **The relay, only if you choose "Relay"**: a UDP broadcast on port 8125 to find it, then HTTP to it on your network. When the TV powers off, the Shard sends the relay its HomeKit keys and accessory description, encrypted with the secret you set up. See the [relay's guide](https://github.com/DickyT/vetro-homekit/tree/main/relay).

## Data it keeps

`config.json` holds the accessory's HomeKit identity (its long-term key pair and device id), the setup code, the paired controllers' public keys, the TV's name, your input choices and names, the power setting, and the relay's secret and address if you use one. Removing the Shard removes it; "Reset HomeKit" on the settings page replaces the identity and pairings.
