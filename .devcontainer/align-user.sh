#!/usr/bin/env bash
# Align only the container account and writable layer; never change source owners.
set -euo pipefail
[[ $# == 3 ]] || { echo 'Usage: align-user.sh USER HOST_UID HOST_GID' >&2; exit 1; }
user=$1
uid=$2
gid=$3
[[ "$user" =~ ^[a-z_][a-z0-9_-]*$ && "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[1-9][0-9]*$ ]] || { echo 'A named user and non-root numeric host UID/GID are required' >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || { echo 'Account alignment requires root inside the container' >&2; exit 1; }
record=$(getent passwd "$user") || { echo 'Development account is absent' >&2; exit 1; }
IFS=: read -r _ _ previous_uid previous_gid _ user_home _ <<< "$record"
[[ "$previous_uid" != 0 && "$previous_gid" != 0 && "$user_home" == "/home/$user" && -d "$user_home" && ! -L "$user_home" && -d /opt/surtitle-build && ! -L /opt/surtitle-build ]] || { echo 'Unexpected development account or container directory' >&2; exit 1; }
existing=$(getent passwd "$uid" || true)
[[ -z "$existing" || "${existing%%:*}" == "$user" ]] || { echo "Host UID $uid belongs to another container account; choose a base image without that UID collision" >&2; exit 1; }
if [[ "$previous_uid" == "$uid" && "$previous_gid" == "$gid" ]]; then exit 0; fi
if ! getent group "$gid" >/dev/null; then
  groupmod --gid "$gid" "$(id -gn "$user")"
fi
arguments=(--gid "$gid")
if [[ "$previous_uid" != "$uid" ]]; then arguments+=(--uid "$uid"); fi
usermod "${arguments[@]}" "$user"
chown -R --no-dereference "$uid:$gid" "$user_home" /opt/surtitle-build
[[ "$(id -u "$user")" == "$uid" && "$(id -g "$user")" == "$gid" ]] || { echo 'Development account alignment failed' >&2; exit 1; }
