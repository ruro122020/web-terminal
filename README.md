# web-terminal

A terminal for your iPhone that runs in the browser and connects to a Linux computer over Tailscale. It has a scrollback of 10,000 lines, finger scrolling, and a bar of keys the iPhone keyboard lacks (Esc, Tab, Shift+Tab, Ctrl and the arrow keys).

Only one device can open it: the iPhone you allow. Everyone else is refused, including your other Tailscale devices.

## How it works

```
iPhone browser --> Tailscale --> gatekeeper (server.mjs) --> private socket file --> ttyd --> ssh to computer
```

- **Tailscale** connects your iPhone and the computer from anywhere, and encrypts everything between them.
- **The gatekeeper** (`server.mjs`) is the only program listening on the network. It listens on the computer's Tailscale address, refuses every device except the allowed iPhone, serves the terminal page, and forwards the terminal connection to ttyd.
- **ttyd** runs the terminal. It listens on a socket file (a connection point on disk that only your user can open) instead of the network, so the gatekeeper is the only way to reach it.
- **ssh** runs inside ttyd and logs in to the same computer, so every session asks for your Linux password.
- **Bitwarden Secrets Manager** holds the two private addresses the gatekeeper needs. They are never written in this repo; `bws run` hands them to the gatekeeper when it starts.

Why not a firewall rule? Tailscale accepts traffic arriving through its own network before the firewall (ufw) checks it, so a ufw rule cannot limit which Tailscale device gets in. The gatekeeper does that check itself. Tailscale addresses cannot be forged, because each one is tied to a device's encryption key.

## Requirements

- A Linux computer that uses systemd (Ubuntu, Debian, Fedora and most others do)
- An iPhone
- A [Tailscale](https://tailscale.com) account with both devices signed in
- A [Bitwarden](https://bitwarden.com) account with Secrets Manager (the free plan is enough)

## Placeholders used below

Replace these with your own values when Bitwarden asks for them. Never write them into the repo.

| Placeholder | What it is | Where to find it |
|---|---|---|
| `<COMPUTER_TAILSCALE_IP>` | The computer's Tailscale address | Run `tailscale ip -4` on the computer |
| `<IPHONE_TAILSCALE_IP>` | The iPhone's Tailscale address | The Tailscale app on the iPhone, or `tailscale status` on the computer terminal |
| `<BITWARDEN_ACCESS_TOKEN>` | The token that lets this computer read its secrets from Bitwarden | Created in step 5 and you type it in step 6 without it being shown |

## Setup

### 1. Install the SSH server and ttyd

On Ubuntu or Debian:

```sh
sudo apt install openssh-server ttyd
```

The Ubuntu and Debian ttyd package also starts its own ttyd as root, offering a login prompt on `localhost`. This project runs its own ttyd under your user, so turn the packaged one off:

```sh
sudo systemctl disable --now ttyd
```

### 2. Install Node.js with nvm

Install [nvm](https://github.com/nvm-sh/nvm), then:

```sh
nvm install 22
nvm alias default 22
```

The service runs whichever version nvm's `default` alias points to, so Node updates need no change to this project. See [Updating Node.js](#updating-nodejs).

### 3. Get the code

The service expects the project at `~/Development/web-terminal`:

```sh
mkdir -p ~/Development
git clone <REPO_URL> ~/Development/web-terminal
cd ~/Development/web-terminal
npm ci
```

`npm ci` installs xterm.js (the terminal display) at the exact versions in `package-lock.json`. The page loads it from the computer, never from the internet.

If you put the project somewhere else, change the `WorkingDirectory` line in `systemd/web-terminal.service` to match.

### 4. Install the Bitwarden Secrets Manager CLI (`bws`)

Download the Linux build from the [bws releases page](https://github.com/bitwarden/sdk-sm/releases), check it against the published checksum, and put it in `~/.local/bin`. For example, with version 2.1.0:

```sh
mkdir -p ~/bws-download && cd ~/bws-download
curl -LO https://github.com/bitwarden/sdk-sm/releases/download/bws-v2.1.0/bws-x86_64-unknown-linux-gnu-2.1.0.zip
curl -LO https://github.com/bitwarden/sdk-sm/releases/download/bws-v2.1.0/bws-sha256-checksums-2.1.0.txt
grep bws-x86_64-unknown-linux-gnu-2.1.0.zip bws-sha256-checksums-2.1.0.txt | sha256sum -c -
unzip bws-x86_64-unknown-linux-gnu-2.1.0.zip
install -m 755 bws ~/.local/bin/bws
cd ~ && rm -rf ~/bws-download
bws --version
```

Continue only if the checksum line ends in `OK`.

### 5. Store the secrets in Bitwarden Secrets Manager

In the Bitwarden web vault at vault.bitwarden.com:

1. Open **Secrets Manager** from the product switcher (the grid icon). If asked, create a free organization.
2. **Projects -> New project**, named `web-terminal`.
3. **Secrets -> New secret**, twice, both in the `web-terminal` project. The names must match exactly:

   | Name | Value |
   |---|---|
   | `LISTEN_HOST` | `<COMPUTER_TAILSCALE_IP>` |
   | `ALLOWED_ADDRESSES` | `<IPHONE_TAILSCALE_IP>` (to allow more than one device, separate addresses with commas) |

4. **Machine accounts -> New**, named after this computer. A machine account is a login for a computer rather than a person.
5. On the machine account's **Projects** tab, add `web-terminal` with **Can read** access.
6. On its **Access tokens** tab, create a token and copy it. Bitwarden shows it only once.

### 6. Save the access token on the computer

Run this in a terminal. It asks for `<BITWARDEN_ACCESS_TOKEN>` without showing what you type, and saves it to a file outside the repo that only your user can read:

```sh
mkdir -p ~/.config/web-terminal && (umask 077 && read -rsp "Bitwarden access token: " t && printf 'BWS_ACCESS_TOKEN=%s\n' "$t" > ~/.config/web-terminal/bws.env) && echo && echo saved
```

Check that Bitwarden delivers both secrets, without printing their values:

```sh
(set -a; . ~/.config/web-terminal/bws.env; set +a; bws run -- 'for n in LISTEN_HOST ALLOWED_ADDRESSES; do eval v=\$$n; [ -n "$v" ] && echo "$n: present" || echo "$n: MISSING"; done')
```

### 7. Start the services

```sh
cd ~/Development/web-terminal
systemctl --user link "$PWD/systemd/web-terminal-ttyd.service" "$PWD/systemd/web-terminal.service"
systemctl --user enable --now web-terminal-ttyd.service web-terminal.service
loginctl enable-linger "$USER"
```

`enable-linger` keeps your services running when you are logged out, and starts them at boot before anyone logs in.

Check that it is running:

```sh
systemctl --user status web-terminal
```

The log should say `Listening on port 7681, allowing 1 device(s)`.

### 8. Open it on the iPhone

1. Make sure Tailscale is on on the iPhone.
2. Open `http://<COMPUTER_TAILSCALE_IP>:7681` in Safari or any other iPhone browser.
3. Log in with your Linux password.
4. To open it like an app: **Share -> Add to Home Screen**. If your browser does not offer that option, do it once from Safari.

## Using it

- **Scrolling:** drag a finger over the terminal. It keeps gliding briefly after you lift your finger. Full-screen programs such as `vim`, `less` and `tmux` have no scrollback, so dragging does nothing inside them.
- **Esc, Tab, ⇧Tab and the arrows** send their key immediately.
- **Ctrl** stays on for the next key you type: tap **Ctrl** (it turns blue), then type `c` to send Ctrl+C.
- **Disconnected?** Tap the blue button at the bottom to reconnect.

## Maintenance

### Updating Node.js

Install a newer version and point the `default` alias at it. The service uses it after its next restart:

```sh
nvm install 22          # newest 22.x, picked up automatically
nvm alias default 24    # or move to a new major version
systemctl --user restart web-terminal
```

The service fails to start only if `default` points to a version that is not installed.

### Allowing a different iPhone

Change the `ALLOWED_ADDRESSES` secret in Bitwarden, then restart the gatekeeper:

```sh
systemctl --user restart web-terminal
```

### Replacing the Bitwarden access token

Create a new token on the machine account, run the command in step 6 again, restart the gatekeeper, then revoke the old token in Bitwarden.

### Logs

```sh
journalctl --user -u web-terminal -f        # gatekeeper, including refused devices
journalctl --user -u web-terminal-ttyd -f   # ttyd
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Log says `Missing LISTEN_HOST` or `Missing ALLOWED_ADDRESSES` | The secret is missing from the Bitwarden project, its name is misspelled, or the machine account lacks **Can read** access to the project. |
| The page never loads on the iPhone | Tailscale is off on the phone, or `ALLOWED_ADDRESSES` does not match the phone's current Tailscale address. Check the log for `Refused <address>`. |
| `Forbidden` | The device you are using is not in `ALLOWED_ADDRESSES`. This is the gatekeeper working as intended. |
| Gatekeeper keeps restarting after boot | Tailscale or the internet was not up yet. It retries every 5 seconds until both are available, because it needs the Tailscale address and Bitwarden at startup. |
| The password prompt never appears | The SSH server is not running: `systemctl status ssh`. |

## Security notes

- The traffic is encrypted by Tailscale end to end, so plain `http://` is not readable by anyone between the phone and the computer. Tailscale can also issue HTTPS certificates, but every certificate is recorded in public logs, which makes the computer's Tailscale name publicly visible. HTTPS would mostly matter for browser features that require it, such as reading the clipboard.
- The terminal connection only accepts requests that state which page they came from (the `Origin` header), which stops other websites from opening a terminal in the background.
- Secrets never go in this repo. Keep them in Bitwarden Secrets Manager or any secret manager. 
