//! IP geolocation for the room list (distance and host country), from a
//! MaxMind-format city database such as DB-IP's free "IP to City Lite"
//! (`NEOBOX_GEOIP`). Without a database every lookup is unknown and the
//! room list shows no distances or flags.

use maxminddb::{Mmap, Reader, geoip2};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;
use tracing::{info, warn};

/// What the database knows about an address.
#[derive(Clone, Debug, PartialEq)]
pub struct Place {
    /// ISO 3166-1 alpha-2, upper case.
    pub country: Option<String>,
    /// Latitude and longitude in degrees.
    pub coords: Option<(f64, f64)>,
}

struct Loaded {
    modified: SystemTime,
    reader: Arc<Reader<Mmap>>,
}

pub struct Geo {
    path: Option<PathBuf>,
    db: RwLock<Option<Loaded>>,
    /// The last problem logged, so a missing file is reported once, not every minute.
    problem: Mutex<Option<String>>,
}

impl Geo {
    /// Open `path` (absent: geolocation off). A missing or unreadable file
    /// is logged and retried by [`Geo::refresh`].
    pub fn open(path: Option<PathBuf>) -> Geo {
        let geo = Geo { path, db: RwLock::new(None), problem: Mutex::new(None) };
        geo.refresh();
        geo
    }

    /// Reload the database when its file changed (the updater replaces it
    /// monthly by renaming a new file over it). A database already loaded
    /// stays in use while the file is missing or broken.
    pub fn refresh(&self) {
        let Some(path) = &self.path else { return };
        let modified = match std::fs::metadata(path).and_then(|m| m.modified()) {
            Ok(m) => m,
            Err(e) => return self.report(format!("geolocation database {} unavailable: {e}", path.display())),
        };
        if self.db.read().unwrap().as_ref().is_some_and(|l| l.modified == modified) {
            return;
        }
        // SAFETY: the file is never written in place: updates rename a new
        // file over the path, so this mapping keeps the old file's contents.
        match unsafe { Reader::open_mmap(path) } {
            Ok(reader) => {
                info!(path = %path.display(), kind = %reader.metadata().database_type, "geolocation database loaded");
                *self.db.write().unwrap() = Some(Loaded { modified, reader: Arc::new(reader) });
                *self.problem.lock().unwrap() = None;
            }
            Err(e) => self.report(format!("geolocation database {} unreadable: {e}", path.display())),
        }
    }

    fn report(&self, problem: String) {
        let mut last = self.problem.lock().unwrap();
        if last.as_deref() != Some(problem.as_str()) {
            warn!("{problem}");
            *last = Some(problem);
        }
    }

    /// Where `ip` is, if the database knows. Private and loopback addresses
    /// are never found. IPv4 clients of a dual-stack socket (`::ffff:a.b.c.d`)
    /// are looked up as IPv4.
    pub fn lookup(&self, ip: IpAddr) -> Option<Place> {
        let reader = self.db.read().unwrap().as_ref()?.reader.clone();
        let found = reader.lookup(ip.to_canonical()).ok()?;
        let city = found.decode::<geoip2::City>().ok()??;
        let country = city.country.iso_code.map(|c| c.to_ascii_uppercase());
        let coords = city.location.latitude.zip(city.location.longitude);
        (country.is_some() || coords.is_some()).then_some(Place { country, coords })
    }

    pub fn country(&self, ip: IpAddr) -> Option<String> {
        self.lookup(ip).and_then(|p| p.country)
    }
}

/// Great-circle distance in whole kilometres (the original's haversine with
/// its earth radius of 6372.797 km).
pub fn distance_km(a: (f64, f64), b: (f64, f64)) -> u32 {
    let rad = std::f64::consts::PI / 180.0;
    let (lat1, lat2) = (a.0 * rad, b.0 * rad);
    let dlat = lat2 - lat1;
    let dlon = (b.1 - a.1) * rad;
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    (6372.797 * 2.0 * h.sqrt().atan2((1.0 - h).sqrt())).round() as u32
}

/// `"lat,lon"` in degrees (`NEOBOX_LOCATION`).
pub fn parse_location(s: &str) -> Option<(f64, f64)> {
    let (lat, lon) = s.split_once(',')?;
    let lat: f64 = lat.trim().parse().ok()?;
    let lon: f64 = lon.trim().parse().ok()?;
    ((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)).then_some((lat, lon))
}

/// Infer an ISO 3166-1 alpha-2 country code from a server's `NEOBOX_REGION` label
/// (such as "Chicago", "Frankfurt", "New York", "Tokyo", or "Warsaw, PL"), so the
/// flag shown beside the server's city matches that server rather than the host's IP.
pub fn region_country(region: &str) -> Option<String> {
    let trimmed = region.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Explicit trailing ISO code such as "Chicago, US" or "Frankfurt (DE)".
    if let Some((_, tail)) = trimmed.rsplit_once(',').or_else(|| trimmed.rsplit_once('(')) {
        let code = tail.trim().trim_end_matches(')').trim();
        if code.len() == 2 && code.bytes().all(|b| b.is_ascii_alphabetic()) {
            return Some(code.to_ascii_uppercase());
        }
    }
    let lower = trimmed.to_ascii_lowercase();
    let code = match lower.as_str() {
        s if s.contains("chicago")
            || s.contains("new york")
            || s.contains("nyc")
            || s.contains("newark")
            || s.contains("ashburn")
            || s.contains("virginia")
            || s.contains("dallas")
            || s.contains("miami")
            || s.contains("los angeles")
            || s.contains("san jose")
            || s.contains("san francisco")
            || s.contains("silicon valley")
            || s.contains("seattle")
            || s.contains("atlanta")
            || s.contains("denver")
            || s.contains("phoenix")
            || s.contains("boston")
            || s.contains("hillsboro")
            || s.contains("usa")
            || s.contains("united states")
            || s.starts_with("us-")
            || s.starts_with("us ") =>
        {
            "US"
        }
        s if s.contains("frankfurt")
            || s.contains("nuremberg")
            || s.contains("falkenstein")
            || s.contains("berlin")
            || s.contains("munich")
            || s.contains("germany") =>
        {
            "DE"
        }
        s if s.contains("london") || s.contains("manchester") || s.contains("united kingdom") || s == "uk" => "GB",
        s if s.contains("paris") || s.contains("gravelines") || s.contains("strasbourg") || s.contains("france") => "FR",
        s if s.contains("amsterdam") || s.contains("netherlands") => "NL",
        s if s.contains("warsaw") || s.contains("krakow") || s.contains("poland") => "PL",
        s if s.contains("helsinki") || s.contains("finland") => "FI",
        s if s.contains("stockholm") || s.contains("sweden") => "SE",
        s if s.contains("madrid") || s.contains("barcelona") || s.contains("spain") => "ES",
        s if s.contains("milan") || s.contains("rome") || s.contains("italy") => "IT",
        s if s.contains("zurich") || s.contains("switzerland") => "CH",
        s if s.contains("vienna") || s.contains("austria") => "AT",
        s if s.contains("istanbul") || s.contains("ankara") || s.contains("turkey") || s.contains("türkiye") => "TR",
        s if s.contains("tokyo") || s.contains("osaka") || s.contains("japan") => "JP",
        s if s.contains("seoul") || s.contains("korea") => "KR",
        s if s.contains("singapore") => "SG",
        s if s.contains("sydney") || s.contains("melbourne") || s.contains("australia") => "AU",
        s if s.contains("mumbai") || s.contains("bangalore") || s.contains("chennai") || s.contains("delhi") || s.contains("india") => "IN",
        s if s.contains("sao paulo") || s.contains("são paulo") || s.contains("brazil") => "BR",
        s if s.contains("toronto") || s.contains("montreal") || s.contains("vancouver") || s.contains("canada") => "CA",
        s if s.contains("hong kong") => "HK",
        s if s.contains("taipei") || s.contains("taiwan") => "TW",
        s if s.contains("dublin") || s.contains("ireland") => "IE",
        s if s.contains("prague") || s.contains("czech") => "CZ",
        s if s.contains("bucharest") || s.contains("romania") => "RO",
        s if s.contains("sofia") || s.contains("bulgaria") => "BG",
        s if s.contains("johannesburg") || s.contains("cape town") || s.contains("south africa") => "ZA",
        s if s.contains("dubai") || s.contains("uae") => "AE",
        s if s.contains("mexico") => "MX",
        s if s.contains("santiago") || s.contains("chile") => "CL",
        s if s.contains("buenos aires") || s.contains("argentina") => "AR",
        _ => return None,
    };
    Some(code.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distances_match_known_city_pairs() {
        // London - Paris is about 344 km, New York - Warsaw about 6860 km
        assert_eq!(distance_km((51.5074, -0.1278), (48.8566, 2.3522)), 344);
        let ny_warsaw = distance_km((40.7128, -74.0060), (52.2297, 21.0122));
        assert!((6850..=6870).contains(&ny_warsaw), "{ny_warsaw}");
        assert_eq!(distance_km((10.0, 20.0), (10.0, 20.0)), 0);
    }

    #[test]
    fn locations_parse_only_in_range() {
        assert_eq!(parse_location(" 52.23, 21.01 "), Some((52.23, 21.01)));
        assert_eq!(parse_location("91,0"), None);
        assert_eq!(parse_location("0,181"), None);
        assert_eq!(parse_location("52.23"), None);
        assert_eq!(parse_location("a,b"), None);
    }

    #[test]
    fn fixture_places_documentation_ranges() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/geo-test.mmdb");
        let geo = Geo::open(Some(path));
        let de = geo.lookup("198.51.100.7".parse().unwrap()).unwrap();
        assert_eq!(de, Place { country: Some("DE".into()), coords: Some((50.1109, 8.6821)) });
        assert_eq!(geo.country("203.0.113.200".parse().unwrap()).as_deref(), Some("US"));
        assert_eq!(geo.country("::ffff:192.0.2.1".parse().unwrap()).as_deref(), Some("GB"));
        assert_eq!(geo.lookup("127.0.0.1".parse().unwrap()), None);
        assert_eq!(Geo::open(None).lookup("198.51.100.7".parse().unwrap()), None);
    }
}
