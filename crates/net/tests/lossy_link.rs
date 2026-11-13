//! Netcode over a hostile link: two predicting clients and the server
//! exchange frames through a channel that drops 25% of packets and delivers
//! the rest out of order with 20–150 ms of jitter, both ways (the unreliable
//! WebRTC transport). Every input change a client makes must reach the
//! authoritative timeline in order, and both clients must end on exactly
//! the server's state.

use neobox_net::{checksum, ClientFrame, ClientSession, MatchStart, ServerFrame, ServerMatch, TickData};
use neobox_sim::{GameSettings, MapData};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn chance(&mut self, p: f64) -> bool {
        (self.next() % 10_000) as f64 / 10_000.0 < p
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo)
    }
}

/// Packets in flight: (delivery time ms, destination, bytes).
struct Link {
    rng: Rng,
    flight: Vec<(u64, usize, Vec<u8>)>,
    loss: f64,
}

impl Link {
    fn send(&mut self, now: u64, to: usize, bytes: Vec<u8>) {
        if !self.rng.chance(self.loss) {
            let at = now + self.rng.range(20, 150);
            self.flight.push((at, to, bytes));
        }
    }
    fn due(&mut self, now: u64) -> Vec<(usize, Vec<u8>)> {
        let mut out = Vec::new();
        self.flight.retain(|(at, to, b)| {
            if *at <= now {
                out.push((*to, b.clone()));
                false
            } else {
                true
            }
        });
        out
    }
}

const SERVER: usize = 99;

fn start() -> MatchStart {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../maps/01-proving-grounds.json");
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let code = MapData::from_json(&json["map"]).unwrap().to_code();
    MatchStart {
        seed: 5,
        start_tick: 0,
        tick_hz: 30.0,
        players: vec![(0, 1.0), (1, 1.0)],
        settings: GameSettings::default(),
        maps: vec![code],
        intro: false,
        rotation: false,
    }
}

#[test]
fn clients_converge_and_lose_no_input() {
    let start = start();
    let mut server = ServerMatch::new(start.clone()).unwrap();
    let mut clients = [ClientSession::new(start.clone(), Some(0)).unwrap(), ClientSession::new(start, Some(1)).unwrap()];
    let mut link = Link { rng: Rng(0x5eed), flight: Vec::new(), loss: 0.25 };
    let mut inputs = Rng(42);
    // every distinct mask each client chose, in order
    let mut intended: [Vec<u8>; 2] = [vec![0], vec![0]];
    // every mask the server applied for each player, in order
    let mut applied: [Vec<u8>; 2] = [vec![0], vec![0]];
    let mut history: Vec<TickData> = Vec::new();
    let mut acks = [0u32; 2];
    // one change per tick: later changes in the same tick replace earlier
    // ones by design (only the last one is ever simulated)
    let mut changed_at = [u32::MAX; 2];

    let input_ticks = 600u32;
    let lead = 5; // client ticks ahead of the server
    let mut now = 0u64;
    while server.tick < input_ticks + 200 {
        now += 1;
        // deliver
        for (to, bytes) in link.due(now) {
            if to == SERVER {
                // the test link tags the sender in the last byte
                let (body, sender) = bytes.split_at(bytes.len() - 1);
                let ClientFrame::Input(f) = ClientFrame::decode(body).unwrap() else { panic!("unexpected frame") };
                let sender = sender[0] as usize;
                acks[sender] = acks[sender].max(f.ack);
                server.submit(sender as u32, &f);
            } else {
                match ServerFrame::decode(&bytes).unwrap() {
                    ServerFrame::Batch { ticks, input_ack, .. } => {
                        clients[to].on_ticks(&ticks);
                        clients[to].input_ack(input_ack);
                        assert!(!clients[to].desynced, "client {to} desynced");
                    }
                    other => panic!("unexpected {other:?}"),
                }
            }
        }
        // server tick every 33 ms
        if now % 33 == 0 {
            let data = server.step();
            for &(p, m) in &data.changes {
                if applied[p as usize].last() != Some(&m) {
                    applied[p as usize].push(m);
                }
            }
            history.push(data);
            for (c, &ack) in acks.iter().enumerate() {
                let ticks: Vec<TickData> = history.iter().filter(|d| d.tick >= ack).cloned().collect();
                if !ticks.is_empty() {
                    let frame = ServerFrame::Batch { ticks, input_ack: server.input_ack(c as u32), margin16: 0 };
                    link.send(now, c, frame.encode());
                }
            }
        }
        // clients run every 16 ms (60 Hz display)
        if now % 16 == 0 {
            for (c, s) in clients.iter_mut().enumerate() {
                let target = server.tick + lead;
                let head = s.head();
                if head < input_ticks && head != changed_at[c] && inputs.chance(0.2) {
                    let m = (inputs.next() & 0xff) as u8 & !3 | if inputs.chance(0.5) { 1 } else { 2 };
                    if intended[c].last() != Some(&m) {
                        s.local_input(head, m);
                        intended[c].push(m);
                        changed_at[c] = head;
                    }
                } else if head >= input_ticks && intended[c].last() != Some(&0) {
                    s.local_input(head, 0);
                    intended[c].push(0);
                }
                s.advance_to(target);
                let mut bytes = ClientFrame::Input(s.input_frame(s.head(), 32)).encode();
                bytes.push(c as u8);
                link.send(now, SERVER, bytes);
            }
        }
    }
    // drain: perfect link from here on
    link.loss = 0.0;
    for _ in 0..400 {
        now += 1;
        for (to, bytes) in link.due(now) {
            if to != SERVER {
                if let ServerFrame::Batch { ticks, input_ack, .. } = ServerFrame::decode(&bytes).unwrap() {
                    clients[to].on_ticks(&ticks);
                    clients[to].input_ack(input_ack);
                }
            }
        }
    }
    for c in 0..2 {
        assert_eq!(applied[c], intended[c], "client {c}: server applied a different input sequence");
        let s = &clients[c];
        assert_eq!(s.known, server.tick, "client {c} confirmed every tick");
        assert_eq!(s.base, server.tick);
        assert_eq!(checksum(s.confirmed_state()), server.checksum(), "client {c} state differs from the server");
        assert!(s.rollbacks > 0, "the lossy link should have caused mispredictions");
    }
}
