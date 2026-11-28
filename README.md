# vetro-homekit

A Samsung TV as a native Apple Home accessory.

> **TL;DR** Install one file on a Samsung TV running Vetro and the TV appears in Apple's Home app. **Your iPhone becomes the TV's remote**: the remote in Control Center moves through the TV's menus, and the phone's volume buttons change the TV's volume. You can also turn the TV on and off and switch inputs from Home, Siri, scenes and automations.

vetro-homekit is a Vetro shard (plugin) that runs on the TV itself and speaks HomeKit Accessory Protocol over IP. The TV shows up in the Home app as a Television: no Homebridge, no Home Assistant, no extra hub.

## Install

**[Download the latest release](https://github.com/DickyT/vetro-homekit/releases/latest)**: one file, `homekit-<version>.vplugin`.

1. Open the Vetro dashboard (`http://<the TV's address>:8099`), go to **Vetro Shards**, then **Install from a file or develop a Shard**.
2. Turn on **Developer mode**. Vetro asks for it for any Shard that is not in its own catalog.
3. Choose the `.vplugin` file and confirm. Then switch the Shard on.
4. Open the Shard's **HomeKit** tab. It shows a setup code. In the Home app: **+ → Add Accessory → More options… → Samsung TV**, and enter the code. iOS warns that the accessory is uncertified; choose Add Anyway.

To update, install a newer file the same way. Pairings and settings are kept.

## What you get in Home

- **Power**: turn the TV off, and on (see [When the TV is off](#when-the-tv-is-off)).
- **Inputs**: the HDMI ports, named after the devices plugged into them, plus AirPlay, Live TV and any apps you add. Home shows which one is on screen and switches between them.
- **Remote**: the Control Center remote works (arrows, select, back, play/pause, info).
- **Volume and mute** with the iPhone's volume buttons while the remote is open.
- **State that follows the TV**: turning it off with the remote shows up in Home right away.

Everything is configured on a settings page served by the TV.

## Requirements

- A Samsung Tizen TV running **Vetro** with unsigned shards allowed (Developer mode in Vetro). Developed and tested on a 2024 QN90D.
- A HomeKit home with a home hub (HomePod or Apple TV) for remote access and automations, as with any HomeKit accessory.
- Vetro 0.5.0 or later (the first version with Shards), on a TV whose Vetro runs a recent Node. The shard is modern JavaScript and was developed on Node 18; it does not load on older TVs.

## When the TV is off

A HomeKit hub checks every accessory about once a minute. A Samsung TV in its normal standby is fully asleep and cannot answer, so the question is what should answer for it. The settings page offers three ways:

| Setting | The TV while off | In Home | Turn on from Home |
|---|---|---|---|
| **Remote only** | Full sleep | No Response | No |
| **Stay in low power** | Screen dark, system and network up. Optionally a full sleep after 15 minutes or 1 hour | Off | Yes, in about a second |
| **Relay** | Full sleep | Off | Yes |

**Relay** needs a small always-on machine on the same network (a NAS, a Raspberry Pi). It runs the [vetro-homekit relay](relay/README.md), which stands in for the TV in Home while it sleeps and wakes it with a Wake-on-LAN packet when you turn it on. Choose Relay on the settings page and press **Set up**: the page gives you the one command to run. The image is [`dickyt/vetro-homekit-relay`](https://hub.docker.com/r/dickyt/vetro-homekit-relay) on Docker Hub.

## How it works

- `homekit/` is the shard. It carries its own HomeKit stack in plain JavaScript (pairing, encrypted sessions, the accessory database, Bonjour), because the TV's Node build lacks some of the usual crypto and there is no package manager on a TV.
- TV control goes through Vetro: remote keys through its `/control` endpoint, everything else through root commands.
- A small root script outside Vetro follows the TV's power signals on D-Bus, so Home hears about a power-off before the TV suspends the shard.
- `relay/` is the relay: the same HomeKit stack serving the accessory database the TV hands over, with power reported as off.

[CONTEXT.md](CONTEXT.md) has the details: the code map, the TV platform's pitfalls, what was learned about Samsung's power states and wake reasons, and how the relay handover works.

## Repository layout

| Path | What it is |
|---|---|
| `homekit/` | The shard: `index.js` (main), `television.js` (the accessory), `tv.js` (TV control), `power.js` (power watcher), `relaylink.js` (relay protocol), `ui.html` (settings page), `hap/` (HomeKit stack) |
| `relay/` | The relay service, its Dockerfile and [its guide](relay/README.md) |
| `pack.sh`, `deploy.sh` | Pack the shard into a `.vplugin` file; install it on a TV over Vetro's plugin API |
| `test/` | Unit and end-to-end tests, a minimal HomeKit controller, and a local preview of the settings page |
| `probe/` | A one-off shard that reports what the TV's Node runtime can do |
| `tools/` | Example local settings: `local.env.example` (the TV's address, for `deploy.sh`), `ssh_config.example` (root shell on the TV) |

## Development

Install on a TV straight from a checkout (needs `bash`, `curl` and `python3`, and the TV switched on):

```bash
VETRO_HOST=<the TV's address> bash deploy.sh homekit
```

If the call ends with HTTP 408, run it again until it prints `deployed homekit`. To keep from typing the address, copy `tools/local.env.example` to `tools/local.env` and fill it in.

Build the `.vplugin` file that releases carry:

```bash
bash pack.sh
```

A release is a tag named after the version in `homekit/manifest.json` (for example `1.2.3`). Create the release with that tag on GitHub, or just push the tag: a GitHub Actions workflow packs the shard and attaches the `.vplugin` file, unless the release already has it.

Tests run on any machine with Node 18 or later, without a TV (`mdns-race` needs a Mac):

```bash
for t in chacha current-input home-target mdns-race power-hold poweron relay relay-plugin; do node test/$t-test.js || break; done
```

`relay-test` and `relay-plugin-test` start a relay on the machine and send a Wake-on-LAN packet for a made-up address on your network.

Preview the settings page locally, against a fake TV:

```bash
HK_STUB_PORT=8123 node test/preview.js /tmp/hk-preview 3600
```

Then open `http://localhost:8123/plugins/homekit/api/ui`.

Build the relay image for `linux/amd64` and `linux/arm64`:

```bash
bash relay/build.sh
```

## Good to know

- **The shard's `config.json` on the TV holds its HomeKit keys and pairings.** `deploy.sh` never sends or overwrites it. Do not post it, or the full output of the `state` endpoint, anywhere.
- **Vetro's plugin API has no sign-in while Vetro pairing is off.** Anyone on your network can then reach the shard's settings. That is Vetro's trust model, not something this shard adds to or removes.
- **Uncertified accessory.** This is not an Apple-certified product. Home works with it as it does with other open-source accessories, and warns once when you add it.
- **Tested on one TV model.** The power handling relies on Samsung-internal interfaces that may differ on other models and firmware versions.

## License

[MIT](LICENSE). Vetro is a separate project with its own license; this repository contains none of its code.
