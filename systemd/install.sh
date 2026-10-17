#!/bin/bash
# Installs the web-terminal services as user services, so they run under your account without root.
#
# The unit files in systemd/ are templates: wherever they need the location of this project they
# say @PROJECT_DIR@ instead of a real path, because the path differs on every machine. This script
# reads each template, replaces @PROJECT_DIR@ with the absolute path of this checkout, and writes
# the result into ~/.config/systemd/user, which is where systemd looks for a user's own services.
# It then tells systemd to pick up the new files, enables the services so they start at login, and
# (re)starts them so the running copies use the new files.
#
# The installed files are copies, not links, so they do not follow the repo. Run this again after
# moving the project (the baked-in path is now wrong) or after editing a unit file in systemd/
# (the installed copy is now out of date). Run it from a terminal on the computer or a plain SSH
# session, not from inside the web terminal: it restarts ttyd, which ends every web terminal session.
#
#   systemd/install.sh                  install the services and (re)start them
#   systemd/install.sh --render-to DIR  only write the filled-in unit files to DIR (the tests use this)
set -euo pipefail

# CDPATH= keeps cd from looking for a relative folder elsewhere and printing where it went.
project_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
units=(web-terminal-ttyd.service web-terminal.service)

# Unit files give these characters a meaning of their own (%h is the home folder, $VAR is a variable,
# quotes and backslashes group words), and the escaping differs by line. Refusing such a path is
# simpler than getting that subtly wrong.
case "$project_dir" in
  *[[:space:]%\$\"\'\\]*)
    echo "install.sh: the project path contains whitespace, %, \$, a quote or a backslash, which a unit file cannot carry as-is: $project_dir" >&2
    exit 1;;
esac

# Writes each unit file to DIR with @PROJECT_DIR@ replaced on every line. The quotes around the
# replacement keep bash from treating any character in the path specially.
write_units() {
  mkdir -p "$1"
  if [ "$(cd -- "$1" && pwd -P)" = "$project_dir/systemd" ]; then
    echo "install.sh: refusing to write over the templates in $project_dir/systemd" >&2
    exit 1
  fi
  for unit in "${units[@]}"; do
    tmp=$(mktemp "$1/.$unit.XXXXXX")
    while IFS= read -r line || [ -n "$line" ]; do
      printf '%s\n' "${line//@PROJECT_DIR@/"$project_dir"}"
    done < "$project_dir/systemd/$unit" > "$tmp"
    # mv replaces whatever is at the destination, including a link that an earlier setup made
    # with `systemctl --user link`; writing through such a link would overwrite the repo's own file.
    mv -f "$tmp" "$1/$unit"
  done
}

if [ $# -eq 2 ] && [ "$1" = --render-to ]; then
  write_units "$2"
  exit 0
elif [ $# -ne 0 ]; then
  echo "usage: $0 [--render-to DIR]" >&2
  exit 2
fi

# Without any of these the gatekeeper fails at every start and systemd retries forever,
# so refuse now rather than report success.
missing() { echo "install.sh: $1 is missing; $2" >&2; exit 1; }
[ -x "$project_dir/gatekeeper/target/release/gatekeeper" ] || missing 'the compiled gatekeeper' 'run npm run build first (README step 3)'
[ -x "$HOME/.local/bin/bws" ] || missing "$HOME/.local/bin/bws" 'install the Bitwarden CLI (README step 4)'
[ -f "$HOME/.config/web-terminal/bws.env" ] || missing "$HOME/.config/web-terminal/bws.env" 'save the Bitwarden access token (README step 6)'

# The same folder the unit files assume with %h/.config, so XDG_CONFIG_HOME is deliberately not consulted.
write_units "$HOME/.config/systemd/user"
systemctl --user daemon-reload
# reenable rewrites the links that start the services at boot; after a move they still point at the old place.
systemctl --user reenable "${units[@]}"
# restart rather than start: services that are already running have the old folder.
systemctl --user restart "${units[@]}"
echo "Installed the web-terminal services for $project_dir"
