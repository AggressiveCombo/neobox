//! `b2World.Solve` and `b2World.SolveTOI`: island building by depth-first
//! search, and the time-of-impact sub-stepping loop.

use crate::common::math::MIN_VALUE;
use crate::common::settings::{MAX_TOI_CONTACTS_PER_ISLAND, MAX_TOI_JOINTS_PER_ISLAND};
use crate::dynamics::TimeStep;
use crate::dynamics::body;
use crate::dynamics::contact::{self, Contact, ContactListener};
use crate::dynamics::joints::JointBase;
use crate::dynamics::store::Store;
use crate::dynamics::world::World;
use crate::ids::{BodyId, ContactId};

/// The body on the far side of contact `id` from `me` (box2dweb `ContactEdge.other`).
fn contact_other(store: &Store, id: ContactId, me: BodyId) -> BodyId {
    let c = store.contact(id);
    let a = store.fixture(c.fixture_a).body;
    if a == me {
        store.fixture(c.fixture_b).body
    } else {
        a
    }
}

/// The body on the far side of a joint from `me` (box2dweb `JointEdge.other`).
fn joint_other(base: &JointBase, me: BodyId) -> BodyId {
    if base.body_a == me {
        base.body_b
    } else {
        base.body_a
    }
}

impl World {
    /// `b2World.Solve`: solves every awake island, syncs fixtures of awake non-static
    /// bodies, then looks for new contacts.
    pub(crate) fn solve(&mut self, step: &TimeStep, listener: &mut dyn ContactListener) {
        self.island.clear();
        for &id in &self.bodies {
            self.store.body_mut(id).set_island_flag(false);
        }
        for &id in &self.contact_manager.contact_list {
            self.store.contact_mut(id).flags &= !Contact::ISLAND_FLAG;
        }
        for &id in &self.joints {
            self.store.joint_mut(id).base_mut().island_flag = false;
        }

        for bi in (0..self.bodies.len()).rev() {
            let seed = self.bodies[bi];
            {
                let b = self.store.body(seed);
                if b.island_flag() || !b.is_awake() || !b.is_active() || b.is_static() {
                    continue;
                }
            }

            self.island.clear();
            self.stack.clear();
            self.stack.push(seed);
            self.store.body_mut(seed).set_island_flag(true);

            while let Some(m) = self.stack.pop() {
                self.island.add_body(m);
                if !self.store.body(m).is_awake() {
                    self.store.body_mut(m).set_awake(true);
                }
                if self.store.body(m).is_static() {
                    continue;
                }

                let contact_count = self.store.body(m).contact_list.len();
                for i in (0..contact_count).rev() {
                    let cid = self.store.body(m).contact_list[i];
                    let c = self.store.contact(cid);
                    if c.flags & Contact::ISLAND_FLAG != 0
                        || c.is_sensor()
                        || !c.is_enabled()
                        || !c.is_touching()
                    {
                        continue;
                    }
                    self.island.add_contact(cid);
                    self.store.contact_mut(cid).flags |= Contact::ISLAND_FLAG;
                    let other = contact_other(&self.store, cid, m);
                    if !self.store.body(other).island_flag() {
                        self.stack.push(other);
                        self.store.body_mut(other).set_island_flag(true);
                    }
                }

                let joint_count = self.store.body(m).joint_list.len();
                for i in (0..joint_count).rev() {
                    let jid = self.store.body(m).joint_list[i];
                    let base = self.store.joint(jid).base();
                    if base.island_flag {
                        continue;
                    }
                    let other = joint_other(base, m);
                    if !self.store.body(other).is_active() {
                        continue;
                    }
                    self.island.add_joint(jid);
                    self.store.joint_mut(jid).base_mut().island_flag = true;
                    if !self.store.body(other).island_flag() {
                        self.stack.push(other);
                        self.store.body_mut(other).set_island_flag(true);
                    }
                }
            }

            self.island.solve(
                &mut self.store,
                step,
                self.gravity,
                self.allow_sleep,
                listener,
            );

            for i in 0..self.island.bodies.len() {
                let id = self.island.bodies[i];
                if self.store.body(id).is_static() {
                    self.store.body_mut(id).set_island_flag(false);
                }
            }
        }
        self.stack.clear();

        for i in (0..self.bodies.len()).rev() {
            let id = self.bodies[i];
            let b = self.store.body(id);
            if b.is_awake() && b.is_active() && !b.is_static() {
                body::synchronize_fixtures(&mut self.store, &mut self.contact_manager.broad_phase, id);
            }
        }
        self.contact_manager.find_new_contacts(&mut self.store);
    }

    /// `b2World.SolveTOI`: repeatedly finds the earliest time of impact among continuous
    /// contacts, advances the bodies to it, and solves the touching island in a sub-step.
    pub(crate) fn solve_toi(&mut self, step: &TimeStep, listener: &mut dyn ContactListener) {
        self.island.clear();
        for &id in &self.bodies {
            let b = self.store.body_mut(id);
            b.set_island_flag(false);
            b.sweep.t0 = 0.0;
        }
        for &id in &self.contact_manager.contact_list {
            self.store.contact_mut(id).flags &= !(Contact::TOI_FLAG | Contact::ISLAND_FLAG);
        }
        for &id in &self.joints {
            self.store.joint_mut(id).base_mut().island_flag = false;
        }

        // box2dweb escapes after 100 passes (logging to the console, which is omitted here).
        for _ in 0..100 {
            let mut min_contact: Option<ContactId> = None;
            let mut min_toi = 1.0_f64;
            for ci in (0..self.contact_manager.contact_list.len()).rev() {
                let cid = self.contact_manager.contact_list[ci];
                let c = self.store.contact(cid);
                if c.is_sensor() || !c.is_enabled() || !c.is_continuous() {
                    continue;
                }

                let toi = if c.flags & Contact::TOI_FLAG != 0 {
                    c.toi
                } else {
                    let (fa, fb) = (c.fixture_a, c.fixture_b);
                    let sid = self.store.fixture(fa).body;
                    let aid = self.store.fixture(fb).body;
                    let s_active = {
                        let b = self.store.body(sid);
                        b.is_dynamic() && b.is_awake()
                    };
                    let a_active = {
                        let b = self.store.body(aid);
                        b.is_dynamic() && b.is_awake()
                    };
                    if !s_active && !a_active {
                        continue;
                    }

                    let t0_s = self.store.body(sid).sweep.t0;
                    let t0_a = self.store.body(aid).sweep.t0;
                    let mut d = t0_s;
                    if t0_s < t0_a {
                        d = t0_a;
                        self.store.body_mut(sid).sweep.advance(d);
                    } else if t0_a < t0_s {
                        d = t0_s;
                        self.store.body_mut(aid).sweep.advance(d);
                    }

                    let t = contact::compute_toi(
                        &self.store,
                        cid,
                        &self.store.body(sid).sweep,
                        &self.store.body(aid).sweep,
                    );
                    let t = if t > 0.0 && t < 1.0 {
                        let t = (1.0 - t) * d + t;
                        if t > 1.0 { 1.0 } else { t }
                    } else {
                        t
                    };
                    let ct = self.store.contact_mut(cid);
                    ct.toi = t;
                    ct.flags |= Contact::TOI_FLAG;
                    t
                };

                if MIN_VALUE < toi && toi < min_toi {
                    min_contact = Some(cid);
                    min_toi = toi;
                }
            }

            let Some(cid) = min_contact else {
                break;
            };
            if 1.0 - 100.0 * MIN_VALUE < min_toi {
                break;
            }

            let (fa, fb) = {
                let c = self.store.contact(cid);
                (c.fixture_a, c.fixture_b)
            };
            let sid = self.store.fixture(fa).body;
            let aid = self.store.fixture(fb).body;
            let backup_s = self.store.body(sid).sweep;
            let backup_a = self.store.body(aid).sweep;
            self.store.body_mut(sid).advance(min_toi);
            self.store.body_mut(aid).advance(min_toi);
            contact::update(&mut self.store, cid, listener);
            self.store.contact_mut(cid).flags &= !Contact::TOI_FLAG;

            if self.store.contact(cid).is_sensor() || !self.store.contact(cid).is_enabled() {
                self.store.body_mut(sid).sweep = backup_s;
                self.store.body_mut(aid).sweep = backup_a;
                self.store.body_mut(sid).synchronize_transform();
                self.store.body_mut(aid).synchronize_transform();
                continue;
            }

            if !self.store.contact(cid).is_touching() {
                continue;
            }

            let seed = if self.store.body(sid).is_dynamic() { sid } else { aid };
            self.island.clear();
            self.toi_queue.clear();
            self.toi_queue.push(seed);
            self.store.body_mut(seed).set_island_flag(true);
            let mut head = 0;
            while head < self.toi_queue.len() {
                let o = self.toi_queue[head];
                head += 1;
                self.island.add_body(o);
                if !self.store.body(o).is_awake() {
                    self.store.body_mut(o).set_awake(true);
                }
                if !self.store.body(o).is_dynamic() {
                    continue;
                }

                let contact_count = self.store.body(o).contact_list.len();
                for i in (0..contact_count).rev() {
                    if self.island.contacts.len() == MAX_TOI_CONTACTS_PER_ISLAND {
                        break;
                    }
                    let ec = self.store.body(o).contact_list[i];
                    let c = self.store.contact(ec);
                    if c.flags & Contact::ISLAND_FLAG != 0
                        || c.is_sensor()
                        || !c.is_enabled()
                        || !c.is_touching()
                    {
                        continue;
                    }
                    self.island.add_contact(ec);
                    self.store.contact_mut(ec).flags |= Contact::ISLAND_FLAG;
                    let other = contact_other(&self.store, ec, o);
                    if !self.store.body(other).island_flag() {
                        if !self.store.body(other).is_static() {
                            self.store.body_mut(other).advance(min_toi);
                            self.store.body_mut(other).set_awake(true);
                        }
                        self.toi_queue.push(other);
                        self.store.body_mut(other).set_island_flag(true);
                    }
                }

                let joint_count = self.store.body(o).joint_list.len();
                for i in (0..joint_count).rev() {
                    let jid = self.store.body(o).joint_list[i];
                    let base = self.store.joint(jid).base();
                    if self.island.joints.len() == MAX_TOI_JOINTS_PER_ISLAND || base.island_flag {
                        continue;
                    }
                    let other = joint_other(base, o);
                    if !self.store.body(other).is_active() {
                        continue;
                    }
                    self.island.add_joint(jid);
                    self.store.joint_mut(jid).base_mut().island_flag = true;
                    if !self.store.body(other).island_flag() {
                        if !self.store.body(other).is_static() {
                            self.store.body_mut(other).advance(min_toi);
                            self.store.body_mut(other).set_awake(true);
                        }
                        self.toi_queue.push(other);
                        self.store.body_mut(other).set_island_flag(true);
                    }
                }
            }

            let dt = (1.0 - min_toi) * step.dt;
            let sub_step = TimeStep {
                dt,
                inv_dt: 1.0 / dt,
                dt_ratio: 0.0,
                velocity_iterations: step.velocity_iterations,
                position_iterations: step.position_iterations,
                warm_starting: false,
            };
            self.island.solve_toi(&mut self.store, &sub_step, listener);

            for i in 0..self.island.bodies.len() {
                let o = self.island.bodies[i];
                self.store.body_mut(o).set_island_flag(false);
                if self.store.body(o).is_awake() && self.store.body(o).is_dynamic() {
                    body::synchronize_fixtures(
                        &mut self.store,
                        &mut self.contact_manager.broad_phase,
                        o,
                    );
                    let contact_count = self.store.body(o).contact_list.len();
                    for j in 0..contact_count {
                        let ec = self.store.body(o).contact_list[j];
                        self.store.contact_mut(ec).flags &= !Contact::TOI_FLAG;
                    }
                }
            }
            for i in 0..self.island.contacts.len() {
                let ec = self.island.contacts[i];
                self.store.contact_mut(ec).flags &= !(Contact::TOI_FLAG | Contact::ISLAND_FLAG);
            }
            for i in 0..self.island.joints.len() {
                let jid = self.island.joints[i];
                self.store.joint_mut(jid).base_mut().island_flag = false;
            }
            self.contact_manager.find_new_contacts(&mut self.store);
        }
    }
}
