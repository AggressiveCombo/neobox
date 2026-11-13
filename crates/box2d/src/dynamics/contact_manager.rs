//! Port of `b2ContactManager` (box2dweb `Box2D.Dynamics.b2ContactManager`).
//!
//! box2dweb threads the world contact list and each body's contact edges through
//! intrusive lists that prepend, so iteration is newest-first. The world list here
//! is a `Vec` in creation order walked from the back; body edge lists are `Vec`s
//! owned by `Body`. Every entry carries a creation sequence number so `collide` can
//! resume at "the next older live contact" even after a callback destroys contacts
//! (including the current one) or creates new ones.

use crate::collision::broadphase::BroadPhase;
use crate::dynamics::body::should_collide;
use crate::dynamics::contact::{self, Contact, ContactListener};
use crate::dynamics::store::Store;
use crate::ids::{ContactId, FixtureId};
use std::collections::HashSet;
use std::hash::{BuildHasherDefault, Hasher};

/// Most contacts a world holds. Like [`crate::collision::broadphase::MAX_PAIRS`]
/// this bounds memory and time on maps the original cannot run either; every
/// public Hitbox map tested stays below an eighth of it. Pairs beyond it get no
/// contact (deterministically) and the world reports the overload.
pub const MAX_CONTACTS: usize = 1 << 19;

/// Multiplicative hash for fixture-index pairs (the set is never iterated, so
/// its order cannot leak into the simulation).
#[derive(Default)]
struct PairHasher(u64);

impl Hasher for PairHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(b as u64);
        }
    }
    fn write_u32(&mut self, v: u32) {
        self.write_u64(v as u64);
    }
    fn write_u64(&mut self, v: u64) {
        self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

/// Unordered fixture pair key.
fn pair_key(a: FixtureId, b: FixtureId) -> (u32, u32) {
    if a.0 < b.0 { (a.0, b.0) } else { (b.0, a.0) }
}

/// `b2ContactManager`.
#[derive(Debug)]
pub struct ContactManager {
    /// World contact list in creation order (box2dweb iterates it newest-first).
    pub(crate) contact_list: Vec<ContactId>,
    /// Creation sequence of each `contact_list` entry; strictly increasing.
    contact_seq: Vec<u64>,
    next_seq: u64,
    pub(crate) broad_phase: BroadPhase,
    pub(crate) contact_count: usize,
    /// Reused buffer of pairs reported by `update_pairs`.
    pair_buf: Vec<(FixtureId, FixtureId)>,
    /// Fixture pairs that have a contact (`AddPair`'s duplicate test without
    /// walking a body's whole contact list, which is quadratic on dense maps).
    pairs: HashSet<(u32, u32), BuildHasherDefault<PairHasher>>,
    /// A pair or contact limit was hit since the last reset.
    pub(crate) overloaded: bool,
}

impl Default for ContactManager {
    fn default() -> Self {
        Self::new()
    }
}

/// `b2ContactFilter.ShouldCollide` (`b2_defaultFilter`).
fn filter_should_collide(store: &Store, fixture_a: FixtureId, fixture_b: FixtureId) -> bool {
    let e = &store.fixture(fixture_a).filter;
    let n = &store.fixture(fixture_b).filter;
    if e.group_index == n.group_index && e.group_index != 0 {
        e.group_index > 0
    } else {
        (e.mask_bits & n.category_bits) != 0 && (e.category_bits & n.mask_bits) != 0
    }
}

impl ContactManager {
    /// `b2ContactManager` constructor.
    pub fn new() -> Self {
        ContactManager {
            contact_list: Vec::new(),
            contact_seq: Vec::new(),
            next_seq: 0,
            broad_phase: BroadPhase::new(),
            contact_count: 0,
            pair_buf: Vec::new(),
            pairs: HashSet::default(),
            overloaded: false,
        }
    }

    /// Returns the manager to its freshly constructed state (`b2World.novakReset`
    /// replaces the contact manager with a new one), keeping heap capacity.
    pub fn reset(&mut self) {
        self.contact_list.clear();
        self.contact_seq.clear();
        self.next_seq = 0;
        self.broad_phase.clear();
        self.contact_count = 0;
        self.pair_buf.clear();
        self.pairs.clear();
        self.overloaded = false;
    }

    /// `b2ContactManager.AddPair`: creates a contact for a proxy pair unless the
    /// pair is already in contact, the bodies may not collide, or the filter rejects it.
    pub fn add_pair(&mut self, store: &mut Store, fixture_a: FixtureId, fixture_b: FixtureId) {
        let pre_a = store.fixture(fixture_a).body;
        let pre_b = store.fixture(fixture_b).body;
        if pre_a == pre_b {
            return;
        }
        if self.pairs.contains(&pair_key(fixture_a, fixture_b)) {
            return;
        }
        if !should_collide(store, pre_b, pre_a)
            || !filter_should_collide(store, fixture_a, fixture_b)
        {
            return;
        }
        if self.contact_count >= MAX_CONTACTS {
            self.overloaded = true;
            return;
        }

        let id = contact::create(store, fixture_a, fixture_b);
        // The factory may swap the fixtures; link using the contact's own order.
        let (fa, fb) = {
            let c = store.contact(id);
            (c.fixture_a, c.fixture_b)
        };
        let body_a = store.fixture(fa).body;
        let body_b = store.fixture(fb).body;
        self.contact_list.push(id);
        self.pairs.insert(pair_key(fa, fb));
        self.contact_seq.push(self.next_seq);
        self.next_seq += 1;
        store.body_mut(body_a).push_contact_edge(id);
        store.body_mut(body_b).push_contact_edge(id);
        self.contact_count += 1;
    }

    /// `b2ContactManager.FindNewContacts`: runs `update_pairs` and adds each reported
    /// pair in the order the broad phase produced it.
    pub fn find_new_contacts(&mut self, store: &mut Store) {
        let pairs = &mut self.pair_buf;
        if self.broad_phase.update_pairs(&mut |a, b| pairs.push((a, b))) {
            self.overloaded = true;
        }
        for i in 0..self.pair_buf.len() {
            let (a, b) = self.pair_buf[i];
            self.add_pair(store, a, b);
        }
        self.pair_buf.clear();
    }

    /// `b2ContactManager.Destroy`: ends the contact if it is touching, unlinks it from
    /// the world list and both bodies' edge lists, then frees it.
    pub fn destroy(&mut self, store: &mut Store, id: ContactId, listener: &mut dyn ContactListener) {
        let (fa, fb, touching) = {
            let c = store.contact(id);
            (c.fixture_a, c.fixture_b, c.is_touching())
        };
        let body_a = store.fixture(fa).body;
        let body_b = store.fixture(fb).body;
        if touching {
            listener.end_contact(store, id);
        }
        if let Some(p) = self.contact_list.iter().position(|&c| c == id) {
            self.pairs.remove(&pair_key(fa, fb));
            self.contact_list.remove(p);
            self.contact_seq.remove(p);
            self.contact_count -= 1;
        }
        store.body_mut(body_a).remove_contact_edge(id);
        store.body_mut(body_b).remove_contact_edge(id);
        contact::destroy(store, id);
    }

    /// `b2ContactManager.Collide`: walks the world contact list newest-first, destroys
    /// contacts that no longer pass the filter or whose fat AABBs stopped overlapping,
    /// and updates the rest.
    pub fn collide(&mut self, store: &mut Store, listener: &mut dyn ContactListener) {
        // Only contacts strictly older than the last visited one are visited, so
        // contacts created during the walk are skipped as in box2dweb.
        let mut bound = u64::MAX;
        loop {
            let n = self.contact_seq.partition_point(|&s| s < bound);
            if n == 0 {
                break;
            }
            let idx = n - 1;
            bound = self.contact_seq[idx];
            let id = self.contact_list[idx];
            self.collide_one(store, id, listener);
        }
    }

    /// One iteration of the `b2ContactManager.Collide` loop body for contact `id`.
    fn collide_one(&mut self, store: &mut Store, id: ContactId, listener: &mut dyn ContactListener) {
        let (fa, fb) = {
            let c = store.contact(id);
            (c.fixture_a, c.fixture_b)
        };
        let body_a = store.fixture(fa).body;
        let body_b = store.fixture(fb).body;
        if !store.body(body_a).is_awake() && !store.body(body_b).is_awake() {
            return;
        }
        if (store.contact(id).flags & Contact::FILTER_FLAG) != 0 {
            if !should_collide(store, body_b, body_a) || !filter_should_collide(store, fa, fb) {
                self.destroy(store, id, listener);
                return;
            }
            store.contact_mut(id).flags &= !Contact::FILTER_FLAG;
        }
        // A fixture without a proxy cannot overlap anything; its contact is stale.
        let overlap = match (store.fixture(fa).proxy_id, store.fixture(fb).proxy_id) {
            (Some(pa), Some(pb)) => self.broad_phase.test_overlap(pa, pb),
            _ => false,
        };
        if !overlap {
            self.destroy(store, id, listener);
            return;
        }
        contact::update(store, id, listener);
    }
}
