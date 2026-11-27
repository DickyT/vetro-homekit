# vetro-homekit-relay

Keeps a Samsung TV in Apple Home while the TV is fully asleep, and wakes it when you turn it on in Home.

It is the companion of [vetro-homekit](https://github.com/dickyt/vetro-homekit), a plugin that makes a Samsung TV running Vetro a native HomeKit Television accessory. On its own this image does nothing: it needs a TV with that plugin.

- Source: [github.com/dickyt/vetro-homekit](https://github.com/dickyt/vetro-homekit) (this is the `relay/` folder)
- Image: [`dickyt/vetro-homekit-relay`](https://hub.docker.com/r/dickyt/vetro-homekit-relay) on Docker Hub, for `linux/amd64` and `linux/arm64`

## Why it exists

A HomeKit hub (HomePod, Apple TV) checks every accessory about once a minute. A TV in full sleep cannot answer, so Home shows it as **No Response** and cannot turn it on. The usual way around this is to keep the TV half awake all the time.

The relay is the other way: the TV sleeps fully, and a small always-on machine on your network answers for it.

1. **The TV powers off.** The plugin hands the TV's HomeKit identity and its accessory description to the relay, then lets the TV sleep.
2. **While the TV sleeps**, the relay appears in Home as that TV, showing **Off**. Your hub talks to the relay instead.
3. **You tap On in Home.** The relay sends a Wake-on-LAN magic packet. The TV lights up.
4. **The TV is on.** The plugin takes everything back and the relay steps aside. Turning the TV on with the remote does the same.

## Requirements

- A machine that is always on and runs Docker: a NAS, a Raspberry Pi, a home server. `linux/amd64` and `linux/arm64` are both supported; Docker picks the right one.
- **Host networking.** Bonjour is multicast, and the magic packet and the TV's search for the relay are broadcasts. None of these cross Docker's default bridge network. Docker Desktop on macOS and Windows does not provide real host networking, so run this on Linux.
- The relay and the TV on the **same subnet** (for example both `192.168.1.x`).
- On the TV: Wake-on-LAN enabled. On Samsung TVs the setting is called Power On with Mobile, usually under Settings → General → Network → Expert Settings.

## Setup

### 1. Get the command from the TV

Open the [vetro-homekit](https://github.com/dickyt/vetro-homekit) settings page on the TV, go to **Power → When the TV is off**, choose **Relay**, and press **Set up**.

The page makes a random secret and shows the command that starts the relay with it. Copy the command. (Under **Advanced options** you can type a secret of your own instead: any text of at least 8 characters. The secret is what lets your TV, and nothing else, hand its identity to this relay.)

### 2. Run it

Paste the command on the machine that will run the relay. **That machine must be on the same local network (subnet) as the TV**: from another network the relay cannot wake the TV. The command looks like this:

```bash
docker run -d --name vetro-homekit-relay --network host --restart unless-stopped -e RELAY_SECRET=the-secret-from-the-tv docker.io/dickyt/vetro-homekit-relay
```

No volumes and no compose file are needed. The equivalent compose file, if you prefer one:

```yaml
services:
  vetro-homekit-relay:
    image: docker.io/dickyt/vetro-homekit-relay
    network_mode: host
    restart: unless-stopped
    environment:
      RELAY_SECRET: the-secret-from-the-tv
```

**Synology (Container Manager):** download `dickyt/vetro-homekit-relay` from the Registry tab, then create a container from it with auto-restart on, the environment variable `RELAY_SECRET`, and the network set to `host`. (The exact labels differ a little between DSM versions.)

### 3. Save on the TV

Press **Save** in the dialog. Within half a minute the **Relay** line on the settings page turns green: `Connected to <name>.` The TV finds the relay by itself.

The secret is shown only while the dialog is open. If you lose the command, press **Set up again**: it makes a new secret, and the relay has to be started again with the new command (`docker rm -f vetro-homekit-relay` first).

### 4. Try it

Turn the TV off. After about half a minute Home shows it as Off rather than No Response. Tap it in Home: the TV turns on.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_SECRET` | none, required | The secret from the TV's **Set up** dialog. At least 8 characters. |
| `RELAY_PORT` | `8125` | The port the TV finds and talks to the relay on (TCP and UDP). The TV only finds the relay by itself on the default; with another port, type `address:port` into **Relay address** (under **Advanced options** in the Set up dialog). |
| `RELAY_HAP_PORT` | `8126` | The port HomeKit controllers connect to while the relay stands in (TCP). |
| `RELAY_NAME` | host name | The name shown on the TV's settings page. |
| `RELAY_ADDRESS` | automatic | This machine's address on the TV's subnet. Set it if the machine has several network interfaces and the log shows the wrong one. |

### Firewall

If the host has a firewall, allow from your LAN:

| Port | Protocol | For |
|---|---|---|
| 8125 | TCP and UDP | The TV finding and talking to the relay |
| 8126 | TCP | HomeKit controllers, while standing in |
| 5353 | UDP | Bonjour |

## What the log tells you

```bash
docker logs -f vetro-homekit-relay
```

| Line | Meaning |
|---|---|
| `listening on port 8125 at <address>` | Up. If the address is not the one on your TV's subnet, set `RELAY_ADDRESS`. |
| `standing in for "<TV>"` | The TV powered off and handed over. |
| `bonjour: own mDNS responder up` | The stand-in is published. |
| `bonjour: mDNS publishing failed` | UDP port 5353 is in use and cannot be shared. See Troubleshooting. |
| `homekit: controller … connected` | Your hub found the relay. |
| `Home turned the TV on: sending magic packets` | You tapped On in Home. |
| `the TV did not come back within 60 s` | The magic packets did not wake the TV. See Troubleshooting. |
| `no longer standing in` | The TV is on again and took HomeKit back. |
| `refused … sealed with a different secret` | The secret on the TV's settings page differs from `RELAY_SECRET`. |

`GET http://<relay>:8125/info` returns a small JSON status (no secrets), which is also the container's health check.

## Troubleshooting

**The settings page says "No relay found yet."**
The TV looks for the relay with a UDP broadcast on port 8125, every 30 seconds until it is found. Check that the container is running with host networking, that the relay and the TV are on the same subnet, and that UDP 8125 is not blocked. Otherwise press **Set up again** and type the relay's address under **Advanced options** (this also makes a new secret, so restart the relay with the new command).

**"The relay has a different secret."**
The relay was started with another secret than the one saved on the TV. Press **Set up again**, and start the relay again with the command it shows.

**Home still shows No Response while the TV is off.**
Look at the log. If there is no `standing in` line, the handover did not happen: open the settings page while the TV is on and check the **Relay** line. If there is `standing in` but no `controller … connected`, the hub cannot see the relay's Bonjour record: check UDP 5353, and `RELAY_ADDRESS` on a machine with several interfaces.

**Tapping On does nothing.**
The log should show `sending magic packets`. If it does and the TV stays off, Wake-on-LAN is not reaching it: enable Power On with Mobile on the TV, and make sure the relay is on the TV's subnet.

**`mDNS publishing failed`.**
Another program holds UDP 5353 without allowing it to be shared. Most Bonjour services do share it; if yours does not, stop that program or run the relay on another machine.

## Good to know

- **Nothing is stored on disk.** If the container restarts while the TV is asleep, Home shows No Response until the TV is next turned on (with the remote) and off again.
- **One TV per relay.**
- **Changes made in Home while the TV is off** are passed on when it wakes: choosing an input, renaming an input, hiding an input. Momentary things such as remote keys and volume are dropped.
- **Security.** While it stands in, the relay holds the TV's HomeKit keys in memory. They travel from the TV encrypted with a key derived from your secret (scrypt, ChaCha20-Poly1305), and a recorded handover cannot be replayed. Anyone on your LAN who knows the secret could impersonate your TV in HomeKit, so choose a long one. The image contains only the program: no keys, no addresses, nothing about any particular home.
- **The image** is `node:22-alpine` plus nine JavaScript files with no dependencies. It runs as the unprivileged `node` user. The [Dockerfile](https://github.com/dickyt/vetro-homekit/blob/main/relay/Dockerfile) and the [source](https://github.com/dickyt/vetro-homekit/tree/main/relay) are in the repository.

## Questions and problems

Open an issue at [github.com/dickyt/vetro-homekit/issues](https://github.com/dickyt/vetro-homekit/issues).
