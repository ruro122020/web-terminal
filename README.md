# web-terminal

A terminal for your iPhone that runs in the browser and connects to a Linux computer over Tailscale. It has a scrollback of 10,000 lines, finger scrolling, and a bar of keys the iPhone keyboard lacks (Esc, Tab, Shift+Tab, Ctrl and the arrow keys).

Only one device can open it: the iPhone you allow. Everyone else is refused, including your other Tailscale devices.

## How it works

```
iPhone browser --> Tailscale --> gatekeeper (Rust) --> private socket file --> ttyd --> ssh to computer
```

- **Tailscale** connects your iPhone and the computer from anywhere, and encrypts everything between them.
- **The gatekeeper** (`gatekeeper/`, a small Rust program built on the hyper HTTP library) is the only program listening on the network. It listens on the computer's Tailscale address, drops every device except the allowed iPhone without replying, serves the terminal page, and forwards the terminal connection to ttyd.
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

The SSH server listens on every network the computer is on by default, so any device on your home Wi-Fi could try passwords against it and skip the gatekeeper entirely. This project only needs it on the computer itself, so limit it to that:

```sh
printf 'ListenAddress 127.0.0.1\nListenAddress ::1\n' | sudo tee /etc/ssh/sshd_config.d/10-localhost-only.conf
sudo systemctl daemon-reload
sudo systemctl restart ssh.socket
```

On Ubuntu 22.10 and later the SSH server is started on demand through `ssh.socket`; on other systems use `sudo systemctl restart ssh` instead. Check the result with `ss -ltn | grep ':22 '`: it should list only `127.0.0.1:22` and `[::1]:22`. This stops other computers from using this SSH server. If you use Tailscale SSH, that is a separate program and keeps working.

### 2. Install Rust and Node.js

- **Rust** builds the gatekeeper. Install it with [rustup](https://rustup.rs).
- **Node.js and npm** download xterm.js (the terminal display the page uses) and run the tests. The running service does not use Node. Any current version works; [nvm](https://github.com/nvm-sh/nvm) is an easy way to install it.

### 3. Get the code

Clone the project anywhere you like, as long as the path has no spaces, `%`, `$`, quotes or backslashes (systemd gives those a meaning of their own); step 7 installs the services for wherever it is:

```sh
git clone <REPO_URL> web-terminal
cd web-terminal
npm ci
npm run build
```

- `npm ci` installs xterm.js at the exact versions in `package-lock.json`. The page loads it from the computer, never from the internet.
- `npm run build` compiles the gatekeeper to `gatekeeper/target/release/gatekeeper`, which the service runs.

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

### 7. Install and start the services

From the project folder:

```sh
systemd/install.sh
loginctl enable-linger "$USER"
```

`install.sh` writes the two service files to `~/.config/systemd/user/` with this folder's path filled in, then enables and starts the services. Run it from a terminal on the computer or a plain SSH session, not from inside the web terminal: it restarts ttyd, which ends every web terminal session. `enable-linger` keeps your services running when you are logged out, and starts them at boot before anyone logs in.

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

### Updating the gatekeeper

After pulling changes to `gatekeeper/`, rebuild it and restart the service. Changes to the page (`public/`) need neither, because the gatekeeper reads those files on every request.

```sh
npm run build
systemctl --user restart web-terminal
```

### Moving the project or changing a service file

The installed services carry the project folder's path and a copy of each file in `systemd/`. After moving the folder or editing one of those files, run the install command again from the project folder (not from inside the web terminal, see step 7):

```sh
systemd/install.sh
```

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

## Tests

The tests use only loopback addresses (`127.0.0.1`) and never need your Bitwarden secrets.

### Gatekeeper tests

```sh
npm run test:gatekeeper
```

These are written in Rust, in `gatekeeper/tests`. They start real copies of the gatekeeper with a stand-in for ttyd, and connect from two loopback addresses (`127.0.0.1` allowed, `127.0.0.2` not) to play the iPhone and another device. They check that:

- the gatekeeper stops with exit code 78 when a setting is missing or invalid, and listens only on `LISTEN_HOST`
- devices that are not allowed are dropped without a reply
- requests using another site's name are refused (the defense against DNS rebinding)
- only the page files are served, each with its exact contents and security headers
- the terminal connection carries data both ways, closes on both sides, and forwards only the headers ttyd needs
- the browser gets a complete WebSocket handshake it will accept, ttyd's refusals stay refusals, and data sent together with a handshake is not lost
- malformed requests, abrupt disconnects and a stopped ttyd never stop the gatekeeper, and connections are limited

### Key and service tests

```sh
npm test
```

These check the exact bytes each key bar key sends, including Ctrl with letters from other alphabets, and that the two service files agree with each other and with the gatekeeper: the socket path, the Bitwarden launcher, the compiled gatekeeper, and the exit code that stops restarts. They also check that `systemd/install.sh` fills the project folder into the service files.

### System tests

```sh
npm run test:system
```

These run the exact ttyd command from `systemd/web-terminal-ttyd.service` behind the gatekeeper and check that a session reaches this computer's SSH password prompt. They stop at the prompt and never type a password. They also run systemd's own checks on both service files as `systemd/install.sh` writes them. They need ttyd and the SSH server running (step 1).

### Browser tests

These open the real page in a phone-sized touch browser, with a real ttyd behind it. They check:

- finger scrolling, its glide, and swiping inside full-screen programs and programs that use the mouse (like Claude Code's full-screen mode)
- that tapping a bar key keeps the keyboard open, the bytes every key sends in both arrow modes, holding an arrow, and Ctrl
- that the program is told the terminal's size, including after turning the phone sideways, and that the key bar stays at the bottom of the visible area
- disconnecting, reconnecting with the button, and reconnecting by itself when you come back to the page.

They need ttyd installed (step 1) and Playwright's headless Chrome, downloaded once:

```sh
npx playwright install chromium-headless-shell
npm run test:browser
```

On Linux versions newer than Playwright officially supports (Ubuntu 26.04, for example), the download needs one extra setting: `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 npx playwright install chromium-headless-shell`. Running the tests does not need it.

These tests run in Chrome, not the iPhone's own browser engine (WebKit), so a change to touch or keyboard behavior still needs a check on the phone.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The service stopped and the log says `Missing LISTEN_HOST`, `Missing ALLOWED_ADDRESSES` or `must be` | A setting is missing or not an IP address: the secret is missing from the Bitwarden project, its name is misspelled, or the machine account lacks **Can read** access to the project. The gatekeeper exits with code 78 and systemd does not retry, because retrying cannot fix a setting. Fix it in Bitwarden, then run `systemctl --user restart web-terminal`. |
| The page never loads on the iPhone, or the connection resets | Tailscale is off on the phone, or `ALLOWED_ADDRESSES` does not match the phone's current Tailscale address. Devices that are not allowed are dropped without a reply, so the browser only says it cannot connect. Check the log for `Refused <address>`. |
| `Misdirected request` | The page was opened by a name instead of `http://<COMPUTER_TAILSCALE_IP>:7681` (for example, the computer's Tailscale name). The gatekeeper only answers requests addressed to that exact address and port, which is how it refuses other websites. Use the address. |
| Gatekeeper keeps restarting after boot | Tailscale or the internet was not up yet. It retries every 5 seconds until both are available, because it needs the Tailscale address and Bitwarden at startup. |
| The password prompt never appears | The SSH server is not running: `systemctl status ssh`. |

## Security notes

- The traffic is encrypted by Tailscale end to end, so plain `http://` is not readable by anyone between the phone and the computer. Tailscale can also issue HTTPS certificates, but every certificate is recorded in public logs, which makes the computer's Tailscale name publicly visible. HTTPS would mostly matter for browser features that require it, such as reading the clipboard.
- A website you open on the iPhone could try to make the browser connect here under the website's own name (DNS rebinding: the site's name is switched to point at this computer). The gatekeeper refuses any request not addressed to `<COMPUTER_TAILSCALE_IP>:7681`, and refuses terminal connections whose `Origin` header (the page they came from) is not this page. ttyd's own origin check cannot stop this, because it only compares those two headers with each other.
- Other websites cannot show this page inside a hidden frame (`frame-ancestors 'none'`), which stops them from tricking you into typing into it.
- At most 20 connections reach the gatekeeper and 3 terminal sessions run in ttyd at once, and both services run with systemd sandboxing options.
- The gatekeeper only guards its own port. Step 1 limits the SSH server to the computer itself so it is not a second way in. For a network-level layer as well, Tailscale access rules (ACLs, set in the Tailscale admin console) can allow only the iPhone to reach port 7681.
- Secrets never go in this repo. Keep them in Bitwarden Secrets Manager or any secret manager. 
