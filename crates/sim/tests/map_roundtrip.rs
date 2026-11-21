//! Export compatibility: a shape whose `p` has an odd length (a trailing x with
//! no y, as in most published Hitbox maps) must export the same `p` the original
//! writes, and survive a code round trip unchanged.

use neobox_sim::MapData;
use serde_json::{json, Value};

fn odd_point_map() -> Value {
    json!({
        "b": [{ "1": 0, "14": 0, "s": [
            { "p": [-30.0, 10.0, 30.0, 10.0, 30.0, 12.0, -30.0] }
        ] }],
        "j": [],
        "s": [ { "1": 10.0, "2": 9.0, "5": true } ],
        "set": { "15": 60.0, "16": 30.0, "18": 15.0 }
    })
}

#[test]
fn odd_length_points_export_without_a_null_y() {
    let map = MapData::from_json(&odd_point_map()).expect("valid map");
    let exported = map.to_json();
    assert_eq!(
        exported["b"][0]["s"][0]["p"],
        json!([-30, 10, 30, 10, 30, 12, -30]),
        "a missing y must be omitted, not written as null"
    );
}

#[test]
fn odd_length_points_round_trip_through_a_code() {
    let map = MapData::from_json(&odd_point_map()).expect("valid map");
    let again = MapData::from_code(&map.to_code()).expect("re-decodes");
    assert_eq!(again.to_json(), map.to_json());
}
