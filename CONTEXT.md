# Context for working on vetro-homekit

Detailed notes for whoever picks this code up next, human or AI: how it is built, why it is built that way, what the TV platform does that is not obvious, and what has and has not been verified. The [README](README.md) is the user-facing overview; start there.

Everything here was observed on one TV: a 2024 Samsung QN90D (Tizen, Wi-Fi) with a HomePod as the home hub. Where something was inferred rather than measured, it says so.

## 1. What this is

A Vetro shard that makes the TV a HomeKit Television accessory (HAP over IP), plus an optional relay that answers for the TV while it is fully asleep. No Homebridge, no Home Assistant.

## 2. Code map

| File | Role |
|---|---|
| `pack.sh` | Packs a shard folder into `dist/<id>-<version>.vplugin`: one JSON file `{ format: "vetro-plugin", version: 1, manifest, files }`. This is what Vetro installs from a file and what releases carry |
| `deploy.sh` | Packs (with `pack.sh`) and installs a shard folder through Vetro's plugin API on port 8099. Reads `VETRO_HOST`, or `TV_HOST` from `tools/local.env`; `VETRO_PORT`, `VETRO_TOKEN` |
| `.github/workflows/release.yml` | On a pushed tag `v<version>` that matches the manifest: runs the portable tests, packs the shard, publishes a GitHub release with the `.vplugin` attached |
| `homekit/README.md` | The shard's own README in the form Vetro's catalog asks for: permissions, every root command and why, network, data kept. It is packed into the bundle |
| `homekit/manifest.json` | Shard id `homekit`, version, permission `exec`. The relay image's version tag comes from here |
| `homekit/index.js` | The shard: configuration, HAP stack start/stop, state polling, input names, power modes, relay handover, HTTP routes |
| `homekit/television.js` | The accessory: Television, Speaker and InputSource services, and what each write does on the TV |
| `homekit/tv.js` | TV control: keys through Vetro's loopback `/control`, state and HDMI through root commands |
| `homekit/power.js` | The root power watcher script and the commands around it |
| `homekit/relaylink.js` | The TV-relay protocol, shared by both sides: key derivation, sealing, discovery, HTTP calls |
| `homekit/ui.html` | The settings page (one file, no build step, ES5-style JavaScript) |
| `homekit/hap/server.js` | HAP over IP: HTTP/1.1, pair-setup, pair-verify, encrypted sessions, events |
| `homekit/hap/accessory.js` | Accessory database: fixed instance ids, cached values, write handlers |
| `homekit/hap/crypto.js`, `chacha.js`, `srp.js`, `tlv.js` | HKDF, Ed25519, X25519, ChaCha20-Poly1305 (pure JavaScript, because the TV's OpenSSL lacks the cipher), SRP-6a 3072, TLV8 |
| `homekit/hap/mdns.js` | Bonjour: registers with the TV's own `mdnsd` over its client socket, else falls back to its own responder on UDP 5353 |
| `relay/relay.js` | The relay service. Rebuilds the accessory from the JSON the TV hands over |
| `relay/Dockerfile`, `relay/build.sh`, `relay/README.md` | Image (node:22-alpine, no dependencies), build and push script, user guide |
| `test/*-test.js` | Unit and end-to-end tests (see the README) |
| `test/controller.js` | Minimal HAP controller: `pair`, `accessories`, `get`, `set`, `watch`, `unpair`. Stores its keys in `test/.pairing-<host>-<port>.json` (ignored by git) |
| `test/preview.js` | Runs the shard locally against a fake Vetro and a fake TV, to preview the settings page |
| `test/tv-check.sh` | Shows the shard's state on a real TV and whether this machine sees it in Bonjour |
| `probe/` | One-off shard reporting the TV's Node runtime, crypto and mDNS abilities |

### Routes (`index.js`, under `/plugins/homekit/api/`)

- GET `ui`, `state`, `apps`
- GET `relay` → `{ handedOver }`, for the relay (no secrets)
- POST `config` (`name`, `inputs`, `offMode`, `deepSleepMin`, `relayAddress`, `relaySecret`), `refresh`, `sync`, `restart`, `reset`
- POST `standby` and `power/<state>/<wake reason>`: from the power watcher, on loopback

### Configuration (`config.json`, kept by Vetro on the TV)

Identity (`deviceId`, `ltsk`, `ltpk`, `setupCode`, `pairings`), `port`, `name`, `configNumber`, input choices (`apps`, `sync`, `custom`, `hidden`, `ports`), `offMode` (`remote` | `lowpower` | `relay`), `deepSleepMin` (0, 15, 60), `relay` (`{ secret, address }`).

**Never print `config.json` or the whole `state` response**: they hold the HomeKit long-term key, pairings, setup code and the relay secret. `state` exposes `relay.secretSet`, never the secret. Filter log lines with `/setup|pin/i` before showing them.

## 3. The TV platform (Vetro on Tizen)

- **Vetro is a separate open-source project**, not part of this repository. Its plugin host is the reference for the shard API; what follows is what this shard relies on.
- **A shard gets** `ctx.id`, `ctx.dir`, `ctx.config.get/set`, `ctx.execute(cmd, ms)` and exports `start`, `stop`, `status`, `route(req, res, sub)`. Nothing else.
- **A shard runs inside Vetro's own Node process.** There is no isolation: an uncaught error or a busy loop affects Vetro itself. Vetro reloads a shard in place on update, so sockets and timers a `stop()` forgets stay alive until Vetro restarts.
- **Routes** are mounted at `/plugins/<id>/api/<sub>`; `route` receives the part after `api/`, which may contain slashes.
- **`ctx.config`** reads and writes one JSON file, `/opt/usr/home/owner/share/vetro-plugins/<id>/config.json` on the TV, mode 0600. It survives updates and reinstalls of the shard.
- **Installing** is `POST /plugins/install` with a JSON bundle of the manifest and the text files (`deploy.sh` builds it), then `POST /plugins/<id>/enable`. Unsigned shards need Vetro's Developer mode.
- **`ctx.execute` runs as root** through Vetro's root agent (`/bin/sh -c`), one command at a time. Vetro's Node runs inside `wrt-service` as the `owner` user. There is no standalone `node`, no `timeout`, no Python, Perl, gdb, strace or nc. There are `gdbus`, `dbus-monitor`, `systemd-run`, `iwpriv`, `iw`, `wpa_cli`, `tcpdump`, `dmesg`.
- **Unsigned code does not run.** The TV refuses unsigned script files and unsigned native binaries (UEP). Scripts go inline: `S="$(echo <base64> | base64 -d)"; bash -c "$S"`. No custom native tools, so no direct ioctls.
- **`pkill -f` / `pgrep -f` match their own command line.** Use the `[x]` trick (`'vetro-homekit-[p]ower'`) and keep the target string out of the same command line. Kill your own `dbus-monitor` by pid.
- **Write the PATH out**: `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.
- **For a few seconds after a wake** root commands fail with "no root agent connected". Retry.
- **Keys**: Vetro `/control` POST `{"key": ...}`, or `/usr/bin/input_keyevent <keysym>`. The power key `XF86PowerOff` is a toggle.
- **Processes started from the root agent can be killed** when the TV resumes. Long-lived helpers are started with `systemd-run --scope` so they sit in their own scope. `--scope` also leaves `$` alone, where a service unit's ExecStart would expand it.
- **A shard's page is sandboxed.** Vetro shows it in `<iframe sandbox="allow-scripts">` and also sends `Content-Security-Policy: sandbox allow-scripts`. No popups: `target="_blank"` and `window.open` do nothing. The browser's own "open in new tab" (Cmd/Ctrl-click) works, and so does `document.execCommand('copy')`. The settings page therefore copies a link on a plain click. Do not try to loosen this from the shard.
- **Vetro's plugin API accepts LAN calls with no Origin header** while Vetro pairing is off. `deploy.sh` and the scripts rely on it.
- **Deploying** restarts the shard. HTTP 408 "request body timeout" happens now and then and leaves the shard disabled; run the deploy again.

## 4. The accessory

- One accessory, aid 1. Service base iids are fixed (Info 1, Protocol 8, Television 10, Speaker 30, InputSource 100 + id × 10), so ids stay stable when inputs come and go.
- Inputs: `home` (id 1, always in Home), `tv` (2, the tuner, opt-in), `hdmi1..4` (3-6), `airplay` (7), apps (11-30). Each has an automatic name (the device's HDMI-CEC name) and an optional custom name set on the page or in Home.
- **AirPlay** is Samsung's `com.samsung.tv.airplay-app-2`. Its manifest says `nodisplay="true"`, so it is not in Vetro's app list; it is a fixed input instead. `app_launcher -s` brings it to the front, and it is the full-screen app while it shows.
- **Current input** comes from the foreground app and the active source (`television.js` `currentInput`). An app in Home that is in front wins; the source viewer in front means the HDMI port or tuner; anything else is the TV itself.
- **Renames from Home right after pairing**: Home shortens "Samsung TV" to "TV". For 120 s after a pairing, a name that is a word-boundary suffix of the current one is refused and the full name sent back.
- **Power state reporting** has two sources: the state poll (`memory/pm/state`: 3 and 4 mean off) and the power watcher. After anything tells Home a power state, `television.js` holds it for 12 s against reads that say the opposite (`hold`): the TV follows a power key two or three seconds later, and without the hold Home shows off, on, off. A read that agrees ends the hold early.
- **`pushOnSubscribe`**: a controller that subscribes to input names, power or the current input gets the value at once. After the relay stood in, a hub comes back holding the relay's values, and an unchanged value would otherwise never be sent.

## 5. Power modes

The setting "When the TV is off" (`offMode`):

- **`remote`**: nothing special. The TV sleeps fully; Home shows No Response.
- **`lowpower`**: while the TV is lit, the watcher reserves low power with deviced (`SetEntryModeDirectLPM(1, <watcher pid>)`), again after every lit resume. The next power-off then stops at low power: screen dark, system and network up, the shard reachable. With a time limit, a timer started at `EnterStandby` calls `RequestAmbientPowerOff` (full sleep) if the TV is still in low power; a lit resume cancels it.
- **`relay`**: section 6.

**The power watcher** (`power.js`) is a root bash script in its own systemd scope, running `dbus-monitor`. On `PowerOff.EnterStandby` it POSTs `standby`; on `power.SystemResume` it waits up to 3 s for `lcdon`, then POSTs `power/<state>/<reason>`. The shard checks that it is alive after every wake and restarts it if not.

**Turning on from Home** (`powerOn()` in `index.js`): a write of Active = 1 only reaches this code while the system is up, so the TV is either lit or dark. It reads `GetPowerState` and presses the power key only if the state is not `lcdon`. It presses once more if that did not light the TV: after 5 s, or sooner if the first press came during `standby` and the state has since read `lowpower` three times in a row (a key that lands exactly on the standby-to-low-power transition is swallowed).

## 6. The relay

**Why**: a HomeKit hub reads the accessory's Firmware Revision once a minute (measured: characteristic type `52`, every 60 s on the existing connection). A TV in full sleep cannot answer. The relay answers instead, so the TV can sleep fully and still be turned on from Home.

**Flow**:

1. `EnterStandby` → the shard `handToRelay()`: sends, sealed, the identity (`deviceId`, `ltsk`, `ltpk`, pairings), the TXT record, the whole accessory database JSON, the iids of power and current input (with the input the TV is on), and the TV's MAC and address. Then it withdraws its Bonjour record and refuses new HAP connections (`hap.setAccepting(false)`), or the hub reconnects to the still-awake TV and only moves over a minute later.
2. The relay rebuilds the accessory from that JSON (same instance ids by construction), reports power off, publishes `<TV name> Relay` in Bonjour with the same TXT `id`. **HomeKit identifies an accessory by the `id`, not the instance name**, so the hub moves over (measured: within about 25 s), and the TV never finds its own name taken when it wakes.
3. A write of power = on → magic packets to the TV's MAC. Other writes are recorded.
4. The TV lit again → the shard `takeBack()`: POST `/release`, re-publish, accept connections. The relay returns pairing changes and the recorded writes; the shard replays an input choice (after 6 s, once the TV is fully up), renames and hidden inputs, and drops momentary ones.

**Details that matter**:

- Take-back triggers: the watcher's `power/lcdon`, or the state poll seeing `lcdon` (a cancelled power-off has no resume signal; ignored for 5 s after a handover so a read that began before it cannot undo it), or a mode change. A dark wake changes nothing.
- The relay polls the TV's `GET relay` every 5 s and stands down if the TV says `handedOver: false`, in case a `/release` was lost. At start-up in relay mode the shard sends a `/release` to clear a stand-in left from before a restart.
- **Protocol** (`relaylink.js`): plain HTTP on port 8125 with sealed bodies. Key = scrypt(secret). Sealed = 12 random nonce bytes + ChaCha20-Poly1305. Every sealed request carries a one-use nonce from `GET /nonce`. A wrong secret is HTTP 403.
- **Discovery** is a UDP broadcast of `vetro-homekit-relay?` to port 8125; the relay answers with its name and port. Bonjour was tried first: on the test network, an mDNS query from a port other than 5353 was sent by the TV and never reached other Wi-Fi clients. So the relay must be on the TV's subnet, which Wake-on-LAN needs anyway.
- The relay needs **host networking**: Bonjour is multicast, discovery and the magic packet are broadcasts, and none of them cross Docker's bridge. macvlan would also work.
- Nothing is persisted in the relay.
- **Settings page**: one row with the connection status and a "Set up" button. The dialog generates a random secret in the browser, shows the `docker run` command with it, and saves the secret to the TV on Save. The secret cannot be read back afterwards, by design; the dialog says so. While not connected, the shard looks for the relay every 30 s, so the page turns green by itself once the container runs.

**Releasing the shard**: bump `version` in `homekit/manifest.json` and `VERSION` in `homekit/index.js`, commit, then `git tag v<version>` and push the tag. The workflow does the rest. A published version is never changed; a fix gets a new version.

**Vetro's official catalog** is the repository `andrearicci93/vetro-plugins` (source in `plugins/<id>/`, bundles built by its scripts, entries signed by the maintainer after review). As it stands this shard cannot go in: the catalog requires ES5 source and runs every shard on Node 4.4.7, 12.4 and 20, and this shard is modern JavaScript that needs BigInt, Ed25519 and X25519 from Node's crypto. The other rules are met (under 20 files and 512 KB, text only, no `eval`, local network only, commands listed in the shard's README). Until that changes, it is distributed from this repository's releases and installed with Developer mode.

**Publishing the image**: `bash relay/build.sh push dickyt/vetro-homekit-relay` builds `linux/amd64` and `linux/arm64` and pushes tags `<version>` and `latest`. The build context is limited by `.dockerignore` to `relay/relay.js`, `homekit/relaylink.js` and `homekit/hap/`. The image must stay generic: before pushing, check that nothing but those program files is in it.

## 7. What was learned about the TV's power behaviour

This is the research behind the power modes: a few days of measurements on the test TV. The throwaway scripts and the system files studied are not kept in the repository; the outcomes are below, with enough detail to repeat any of it.

**How it was measured.** A root script on the TV (started in its own systemd scope, like the power watcher) ran `dbus-monitor --system` on the interfaces `org.tizen.system.deviced.power`, `.PowerOff` and `.display`, logged every signal with a timestamp, and after each `SystemResume` sampled `GetPowerState` / `GetScreenState` / `GetState` / `GetAmbientMode` for three minutes and saved the kernel log. The kernel log only goes back about a quarter of an hour, so what the TV sent to the Wi-Fi chip at suspend, and the pulse number of a wake, have to be read right after that wake. A machine on the LAN powered the TV off (the power key over SSH), sent magic packets or TCP packets, and polled the shard's `state` route to see when the TV answered.

### deviced low power (LPM) API

Bus name `org.tizen.system.deviced`, path `/Org/Tizen/System/DeviceD/Display`, interface `org.tizen.system.deviced.display`.

| Call | Result |
|---|---|
| `SetEntryModeDirectLPM(1, pid)` | Reserves low power for the **next** power-off: standby, then low power instead of a full sleep. Used up by that power-off. A power-off that is cancelled does not use it up |
| `UnSetEntryModeDirectLPM(1, pid)` | Drops a reservation (0), or -1 if there is none |
| `RequestAmbientPowerOff()` | Low power → full sleep, in 5-7 s |
| `GetPowerState()` | `lcdon`, `standby`, `lowpower` |
| `NotifyWakeupFromLPM`, `lockstate ... standbymode` | No useful effect |

States: lit is `lcdon` / screen 1 / pm 1. Standby is `standby` / 0 / 4. Low power is `lowpower` / 0 / 4, with `GetState` = `suspend` and `GetAmbientMode` = `lowpower`.

Signals, in order (member names):

- Power-off: `PreChangeState "standby"`, `ChangeState "standby"`, `EnterStandby`, about 15 s later `PostPowerOff`, `PreChangeState "suspend"`. With a reservation it ends in low power instead (`ChangePowerStateEvent ... lowpower`), with **no** `SystemResume`.
- A lit wake: `SystemResume <reason>`, `EarlyWakeUp`, `PreChangeState "lcdon"`, `ChangeState "lcdon"`, `PreWakeUp`, `WakeUp`, `PostWakeUp`.
- A dark wake: only `SystemResume <reason>`; later `PreChangeState "suspend"` when it goes back to sleep.
- `RequestAmbientPowerOff`: `AmbientPowerOff`, `LowPowerOff`, `PostLowPowerOff`.

Timings: the standby stage between the power key and low power (or sleep) lasts from 15 s to about 4 minutes. In low power the power key lights the TV in about 1 s (wake reason 68). **During the standby stage the power key brings the TV straight back to `lcdon` with no `SystemResume` signal.** A network wake from full sleep reaches `lcdon` about 0.7 s after `SystemResume`; a key pressed before `lcdon` is ignored.

### Wake reasons

Whether the screen lights is decided by the wake reason. The table is in the TV's `libpower-defs`; reasons flagged `lowpower` wake the TV dark, into the low power state.

| Reason | Name | Lights the screen |
|---|---|---|
| 1 | `key.remotePower` | Yes |
| 43 | `bluetooth.youtube`: Wi-Fi pulse 1. Every magic packet (Wake-on-LAN, a Bonjour Sleep Proxy, AirPlay) | Yes |
| 46 / 47 | `wifi.wowLanPulse5/6`: Wi-Fi connection trouble, not a request | No |
| 48 | `wifi.wowLanPulse7`: a packet to a port in the Wi-Fi wake-port table | No |
| 53 | `timer.onIOTKeepAlive`: the TV's own timer, every 52 minutes, awake for about 2 minutes | No |
| 55 / 56 | `ethernet.anyPacket` / `ethernet.magicPacket` (wired; not tested, the TV is on Wi-Fi) | No / Yes |
| 68 | `key.smartControllerPower`: the power key while in low power | Yes |
| 95 | `bluetooth.background` | No |
| 57 / 103 / 110 / 127 | `sw.networkStandby` / `sw.iotPowerOn` / `sw.airplay` / `sw.googleCast`: set by software after a wake | Yes |

The table itself is data inside `/usr/lib/libpower-defs.so` on the TV (columns: reason id, name, boot type, sub type, `lowpower`, description). The `sw.*` rows, together with deviced's `SetWakeupReason`, look like Samsung's own "wake dark, then let a service decide to light the screen"; that call was never tried.

- A dark wake lasts about 2 minutes and the TV goes back to sleep without an `EnterStandby` signal. The shard runs during it and the hub can connect.
- The pulse number is chosen by the Wi-Fi firmware (MT7668, encrypted, not readable). The driver logs it as `=== PulseNum = N ===`, counting from 0: a magic packet is 0 (reason 43), a wake-port hit is 6 (reason 48).

### How the TV sets up Wi-Fi wake

Read from the TV's own binaries (the `mt7668` driver, `vd-net-config`, `libwowl-agent`, `libwow-impl`), then confirmed in the kernel log:

- At suspend `vd-net-config` configures the driver through a private ioctl (0x8BEE), and the driver sends one command to the firmware. On the test network that configuration was: wait for a magic frame, no MAC or password filter, "exception" wake on (pulse 5), no pattern. The standard MediaTek wake-port table travels in the same command, which is why `SET_WOW_TCP` works.
- Pulses 5 and 6 mean connection trouble. On reasons 46/47 `vd-net-config` spends 30 s recovering the Wi-Fi link and may go back to sleep; a third reason 47 within an hour turns Wi-Fi wake off.
- Samsung's waker table (a file of MAC addresses with an app mask, served by `net.netvdconfig.wowl` on D-Bus: `AddWakerDevice`, `DelWakerDevice`, `ClearWakerTable`, `SetTcpKeepAliveInfo`, `SetWakeOnMobileMode`) is only pushed to the chip when the network's security type is an older one. On a WPA3 network the kernel log showed the filter off and all eight waker slots empty. `SetWakeOnMobileMode(false)` is persistent and disables Wi-Fi wake altogether; `SetTcpKeepAliveInfo` has no way to clear it. Leave both alone.
- The firmware's pulse test and the "exception app" setting are only reachable through the ioctl, so not from a shard (no native code).

### TCP port wake (works, not used by any mode)

`iwpriv wlan0 driver "SET_WOW_TCP <ver> <port...>"` puts ports in the Wi-Fi chip's wake table (`ver` 0 and 1 are the two IP versions; the table lives in driver memory). A packet to such a port wakes the TV **dark** (reason 48), with no magic packet. Pressing the power key then lights it in 0.7 s.

- The firmware matches **any** TCP packet to the port, not only a SYN. With the HAP port in the table, the hub's once-a-minute read on its existing connection woke the TV every time: awake 2 minutes, asleep under 1. That is why this did not become a mode on its own.
- **Driver bug**: `SET_WOW_TCP <ver>` with no ports clears the UDP table, not the TCP one. The TCP count only returns to 0 when the driver reloads. The scripts neutralise the table by setting it to the single port 0.
- `GET_WOW_PORT <ver> <proto>`: `proto` is a number (1 TCP, 0 UDP); the answer goes to the kernel log at INFO level. `/proc/net/wlan/dbg_level` sets log levels (`0x1d:0x2f,0x00:0x2f` turns INFO on for the PF and INIT modules).
- Samsung's own waker table (`net.netvdconfig.wowl` on D-Bus) is only pushed to the chip on networks with older security settings; on a WPA3 network it was not in effect.

### What a HomeKit hub does

- It reads Firmware Revision once a minute on its existing connection. Not documented anywhere that could be found; the reading here is that it is a liveness check.
- A Bonjour Sleep Proxy only wakes a sleeping device on a **new** connection (a SYN to a registered port), and always with a magic packet, so always with the screen lit. It cannot tell a user turning the TV on from the hub reconnecting. An earlier version of this shard (up to 0.4) used one and was dropped for that reason. For the record, the client side is small: find proxies by browsing `_sleep-proxy._udp`; register with a DNS UPDATE (RFC 2136) sent by unicast to the proxy, carrying the service's PTR/SRV/TXT/A records and an EDNS0 OPT with Update Lease (option 2) and Owner (option 4: the MAC to wake); take the records back by sending the same registration with a 1 s lease.
- Before the relay was written, the idea was tried with a stand-in on a laptop using the TV's identity: with the TV already asleep, the hub connected to the stand-in the same second it appeared in Bonjour, and went back to the TV the same second the stand-in left.
- AirPlay wakes a sleeping TV because the sender sends a magic packet when the user picks the TV. HomeKit controllers never send one.
- Native HomeKit TVs (Sony, LG, Vizio) stay in a network standby while off. `lowpower` mode is the same idea; the relay is the alternative.

## 8. Verified, and not

Verified on the test TV: pairing, inputs, remote, volume; all three power modes end to end from the Home app, including the relay running in Docker on a NAS; the handover and take-back timings above; the power-state hold.

Not verified:

- Other TV models and firmware versions. The LPM calls and wake reasons are Samsung internals.
- The relay on hosts where another program holds UDP 5353 without sharing it.
- Removing the TV from Home while the relay stands in (the pairing change is carried back in code; never exercised).
- What the current input reads during a real AirPlay session, as opposed to the AirPlay app brought to the front.
- A state where the screen is dark but nothing reports standby (seen once overnight: no deviced signal, the shard never suspended, Home kept showing on). The shard logs every change of `pm`, `power` and `screen` (`TV state: ...`) to catch it next time.
- Power draw in low power. It was never measured.
- Once, a power-off sent 9 s after a power-on was undone: the TV entered standby and was back at `lcdon` within 6 s with no key pressed. With 45 s between them it did not happen. HDMI-CEC from a device that was just waking up is the guess.

## 9. Working rules

- Never print the TV's `config.json` or the full `state`. Never commit `test/.pairing-*.json`, `tools/local.env`, `tools/ssh_config` or `tools/known_hosts`.
- Nothing about a particular home belongs in this repository or in the relay image: no addresses, MAC addresses, device names, keys or secrets. Local settings go in `tools/local.env`.
- Files copied from a TV for analysis (Samsung's system binaries, Vetro's source) are not ours to publish and are not kept here.
- Throwaway research scripts do not belong in the repository. Write the outcome into section 7 instead.
- Anything that powers a real TV off and on, or sends packets to other devices on the network, needs the owner's say-so first.
- The settings page is English. Keep its text short: the detailed guide for the relay lives in `relay/README.md`.
