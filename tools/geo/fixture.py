"""Writes crates/server/tests/data/geo-test.mmdb: a tiny city database in the
GeoIP2/DB-IP layout for the geolocation tests and the end-to-end suite.

It only covers the documentation address ranges of RFC 5737, which never
appear on the internet, mapped to made-up but plausible places:

    192.0.2.0/24     GB  London
    198.51.100.0/24  DE  Frankfurt
    203.0.113.0/24   US  New York

Run with the MIT-licensed writer installed:
    pip install mmdb-writer netaddr
    python tools/geo/fixture.py
"""

from pathlib import Path

from mmdb_writer import MMDBWriter
from netaddr import IPSet

PLACES = [
    ("192.0.2.0/24", "GB", 51.5074, -0.1278),
    ("198.51.100.0/24", "DE", 50.1109, 8.6821),
    ("203.0.113.0/24", "US", 40.7128, -74.0060),
]

OUT = Path(__file__).resolve().parents[2] / "crates" / "server" / "tests" / "data" / "geo-test.mmdb"


def main() -> None:
    writer = MMDBWriter(ip_version=6, ipv4_compatible=True, database_type="neobox-test-city", description="neobox test fixture")
    for network, country, lat, lon in PLACES:
        writer.insert_network(IPSet([network]), {"country": {"iso_code": country}, "location": {"latitude": lat, "longitude": lon}})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    writer.to_db_file(str(OUT))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
