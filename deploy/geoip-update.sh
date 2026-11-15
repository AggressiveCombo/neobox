#!/bin/sh
# Keeps DB-IP's free "IP to City Lite" database current for the room list's
# distances and flags (licence CC BY 4.0, https://db-ip.com; neobox credits it
# on its About page). DB-IP publishes a new file in the first days of each
# month. Run daily by neobox-geoip.timer: it downloads at most once a month.
#
#   geoip-update.sh [destination]   (default /var/lib/neobox/dbip-city-lite.mmdb)
#
# The new file replaces the old one by renaming, so a running server keeps
# reading the old copy until it notices the change (within a minute).
set -eu

dest="${1:-/var/lib/neobox/dbip-city-lite.mmdb}"
dir=$(dirname "$dest")
stamp="$dest.month"
month=$(date -u +%Y-%m)
previous=$(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y-%m)

if [ -f "$dest" ] && [ "$(cat "$stamp" 2>/dev/null || true)" = "$month" ]; then
	exit 0
fi

tmp=$(mktemp "$dir/.dbip.XXXXXX")
trap 'rm -f "$tmp" "$tmp.gz"' EXIT

fetch() {
	curl -fsSL --retry 3 -o "$tmp.gz" "https://download.db-ip.com/free/dbip-city-lite-$1.mmdb.gz"
}

if fetch "$month"; then
	got=$month
elif [ ! -f "$dest" ] && fetch "$previous"; then
	# first install early in a month: last month's file until the new one is out
	got=$previous
else
	echo "dbip-city-lite-$month is not published yet; keeping the current database" >&2
	exit 0
fi

gunzip -c "$tmp.gz" >"$tmp"
# every MaxMind-format database ends with this metadata marker
if ! tail -c 131072 "$tmp" | grep -q "MaxMind.com"; then
	echo "downloaded file is not a MaxMind-format database" >&2
	exit 1
fi
chmod 644 "$tmp"
mv -f "$tmp" "$dest"
echo "$got" >"$stamp"
echo "geolocation database updated to $got"
