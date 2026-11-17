//! A recording must reproduce the authoritative match exactly: every state
//! the replay player reaches, by stepping or by seeking backwards and
//! forwards, equals the server's state at that tick. Includes a late join,
//! a leave, and a recording that starts mid-match from a snapshot. A client
//! joining from that snapshot (with the held input masks) must converge too.

use neobox_net::{checksum, encode_state, ClientSession, MatchStart, Replay, ReplayPlayer, ReplayRecorder, ServerMatch, TickData, KEYFRAME_INTERVAL};
use neobox_sim::{GameSettings, MapData};

fn start() -> MatchStart {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../maps/01-proving-grounds.json");
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let code = MapData::from_json(&json["map"]).unwrap().to_code();
    MatchStart {
        seed: 9,
        start_tick: 0,
        tick_hz: 30.0,
        players: vec![(0, 1.0), (1, 1.0), (2, 1.0)],
        settings: GameSettings::default(),
        maps: vec![code],
        intro: false,
        rotation: false,
    }
}

const TICKS: u32 = 1000;

#[test]
fn replay_reproduces_the_server_match() {
    let start = start();
    let mut server = ServerMatch::new(start.clone()).unwrap();
    let mut full = ReplayRecorder::new(start.clone(), None);
    let mut late: Option<ReplayRecorder> = None;
    let mut late_client: Option<ClientSession> = None;
    let mut since_join: Vec<TickData> = Vec::new();
    let mut hashes = vec![checksum(&server.state)];
    let mut rng = 0x1234_5678_9abc_def0u64;
    for tick in 0..TICKS {
        if tick == 400 {
            server.join(3, 1.0);
        }
        if tick == 700 {
            server.leave(1);
        }
        if tick == 500 {
            late = Some(ReplayRecorder::new(start.clone(), Some((server.tick, encode_state(&server.state), server.held_masks()))));
            late_client = Some(ClientSession::from_snapshot(start.clone(), None, server.tick, &server.snapshot(), &server.held_masks()).unwrap());
        }
        for p in 0..4u32 {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            if rng % 7 == 0 {
                let frame = neobox_net::InputFrame { ack: 0, now: server.tick, changes: vec![(server.input_ack(p) + 1, server.tick, (rng >> 8) as u8)] };
                server.submit(p, &frame);
            }
        }
        let data = server.step();
        full.push(std::slice::from_ref(&data));
        if let Some(l) = late.as_mut() {
            l.push(std::slice::from_ref(&data));
            since_join.push(data.clone());
        }
        hashes.push(checksum(&server.state));
    }
    let mut client = late_client.unwrap();
    for chunk in since_join.chunks(40) {
        client.on_ticks(chunk);
    }
    assert!(client.desync.is_none());
    assert_eq!(checksum(client.confirmed_state()), hashes[TICKS as usize], "late-joining client diverged");

    // the file round-trips through JSON
    let names = vec![(0, "a".to_string()), (1, "b".to_string())];
    let replay = Replay::from_json(full.finish(names).to_json().as_bytes()).unwrap();
    let mut player = ReplayPlayer::new(replay).unwrap();
    assert_eq!((player.first_tick(), player.end_tick()), (0, TICKS));

    // straight playback
    while player.step() {
        assert_eq!(checksum(player.states().1), hashes[player.tick() as usize], "tick {}", player.tick());
    }
    // seeking: backwards (keyframes), short and long jumps forwards
    for &t in &[3, KEYFRAME_INTERVAL * 2 + 17, 90, 999, 0, 650, 651, TICKS] {
        player.seek(t);
        assert_eq!(player.tick(), t);
        assert_eq!(checksum(player.states().1), hashes[t as usize], "seek to {t}");
    }

    // a recording that starts at a late-join snapshot
    let late = Replay::from_json(late.unwrap().finish(Vec::new()).to_json().as_bytes()).unwrap();
    let mut player = ReplayPlayer::new(late).unwrap();
    assert_eq!(player.first_tick(), 500);
    player.seek(TICKS);
    assert_eq!(checksum(player.states().1), hashes[TICKS as usize]);
}
