//! `b2Island` (box2dweb `Box2D.Dynamics.b2Island`): a connected set of awake bodies with the
//! contacts and joints that tie them together, solved as one unit.
//!
//! Lists are reused across steps: [`Island::clear`] only resets lengths, so no step allocates
//! once the vectors have grown to their working size.

use crate::common::math::{Vec2, clamp, dot, min_f};
use crate::common::settings::{
    ANGULAR_SLEEP_TOLERANCE, CONTACT_BAUMGARTE, LINEAR_SLEEP_TOLERANCE, MAX_ROTATION,
    MAX_ROTATION_SQUARED, MAX_TRANSLATION, MAX_TRANSLATION_SQUARED, TIME_TO_SLEEP,
};
use crate::dynamics::TimeStep;
use crate::dynamics::contact::{ContactImpulse, ContactListener};
use crate::dynamics::contact_solver::ContactSolver;
use crate::dynamics::joints;
use crate::dynamics::store::Store;
use crate::ids::{BodyId, ContactId, JointId};

pub struct Island {
    pub(crate) bodies: Vec<BodyId>,
    pub(crate) contacts: Vec<ContactId>,
    pub(crate) joints: Vec<JointId>,
    solver: ContactSolver,
    /// Scratch passed to `post_solve`. box2dweb keeps one shared `s_impulse`, so entries past a
    /// contact's point count retain their previous values; this field preserves that.
    impulse: ContactImpulse,
}

impl Default for Island {
    fn default() -> Self {
        Self::new()
    }
}

impl Island {
    pub fn new() -> Self {
        Self {
            bodies: Vec::new(),
            contacts: Vec::new(),
            joints: Vec::new(),
            solver: ContactSolver::new(),
            impulse: ContactImpulse {
                normal_impulses: [0.0; 2],
                tangent_impulses: [0.0; 2],
            },
        }
    }

    /// `b2Island.Clear`.
    pub fn clear(&mut self) {
        self.bodies.clear();
        self.contacts.clear();
        self.joints.clear();
    }

    /// `b2Island.AddBody`. box2dweb's `m_islandIndex` is written but never read, so it is not stored.
    pub fn add_body(&mut self, id: BodyId) {
        self.bodies.push(id);
    }

    /// `b2Island.AddContact`.
    pub fn add_contact(&mut self, id: ContactId) {
        self.contacts.push(id);
    }

    /// `b2Island.AddJoint`.
    pub fn add_joint(&mut self, id: JointId) {
        self.joints.push(id);
    }

    /// `b2Island.Solve`.
    pub fn solve(
        &mut self,
        store: &mut Store,
        step: &TimeStep,
        gravity: Vec2,
        allow_sleep: bool,
        listener: &mut dyn ContactListener,
    ) {
        for &id in &self.bodies {
            let b = store.body_mut(id);
            if !b.is_dynamic() {
                continue;
            }
            b.linear_velocity.x += step.dt * (gravity.x + b.inv_mass * b.force.x);
            b.linear_velocity.y += step.dt * (gravity.y + b.inv_mass * b.force.y);
            b.angular_velocity += step.dt * b.inv_i * b.torque;
            b.linear_velocity
                .multiply(clamp(1.0 - step.dt * b.linear_damping, 0.0, 1.0));
            b.angular_velocity *= clamp(1.0 - step.dt * b.angular_damping, 0.0, 1.0);
        }

        self.solver.initialize(store, &self.contacts);
        self.solver.init_velocity_constraints(store, step);
        for &j in &self.joints {
            joints::init_velocity_constraints(store, j, step);
        }
        for _ in 0..step.velocity_iterations {
            for &j in &self.joints {
                joints::solve_velocity_constraints(store, j, step);
            }
            self.solver.solve_velocity_constraints(store);
        }
        // box2dweb's joint `FinalizeVelocityConstraints` is the empty base-class method for every
        // joint type, so there is nothing to call here.
        self.solver.finalize_velocity_constraints(store);

        integrate_positions(&self.bodies, store, step);

        for _ in 0..step.position_iterations {
            let contacts_ok = self.solver.solve_position_constraints(store, CONTACT_BAUMGARTE);
            let mut joints_ok = true;
            for &j in &self.joints {
                joints_ok &= joints::solve_position_constraints(store, j);
            }
            if contacts_ok && joints_ok {
                break;
            }
        }

        self.report(store, listener);

        if allow_sleep {
            let mut min_sleep_time = f64::MAX; // Number.MAX_VALUE
            let lin_tol_sq = LINEAR_SLEEP_TOLERANCE * LINEAR_SLEEP_TOLERANCE;
            let ang_tol_sq = ANGULAR_SLEEP_TOLERANCE * ANGULAR_SLEEP_TOLERANCE;
            for &id in &self.bodies {
                let b = store.body_mut(id);
                if b.is_static() {
                    continue;
                }
                if !b.is_sleeping_allowed()
                    || b.angular_velocity * b.angular_velocity > ang_tol_sq
                    || dot(b.linear_velocity, b.linear_velocity) > lin_tol_sq
                {
                    b.sleep_time = 0.0;
                    min_sleep_time = 0.0;
                } else {
                    b.sleep_time += step.dt;
                    min_sleep_time = min_f(min_sleep_time, b.sleep_time);
                }
            }

            if min_sleep_time >= TIME_TO_SLEEP {
                for &id in &self.bodies {
                    store.body_mut(id).set_awake(false);
                }
            }
        }
    }

    /// `b2Island.SolveTOI`: sub-stepping solve used after a time of impact, with no sleep pass.
    pub fn solve_toi(
        &mut self,
        store: &mut Store,
        sub_step: &TimeStep,
        listener: &mut dyn ContactListener,
    ) {
        // no contact `InitVelocityConstraints` (warm start) here, as in box2dweb:
        // the constraints keep the impulses `Initialize` copied from the manifolds
        self.solver.initialize(store, &self.contacts);
        for &j in &self.joints {
            joints::init_velocity_constraints(store, j, sub_step);
        }
        for _ in 0..sub_step.velocity_iterations {
            self.solver.solve_velocity_constraints(store);
            for &j in &self.joints {
                joints::solve_velocity_constraints(store, j, sub_step);
            }
        }

        integrate_positions(&self.bodies, store, sub_step);

        for _ in 0..sub_step.position_iterations {
            let contacts_ok = self.solver.solve_position_constraints(store, 0.75);
            let mut joints_ok = true;
            for &j in &self.joints {
                joints_ok &= joints::solve_position_constraints(store, j);
            }
            if contacts_ok && joints_ok {
                break;
            }
        }

        self.report(store, listener);
    }

    /// `b2Island.Report`: forwards each contact's accumulated impulses to `post_solve`.
    fn report(&mut self, store: &mut Store, listener: &mut dyn ContactListener) {
        for (constraint, &contact) in self.solver.constraints.iter().zip(self.contacts.iter()) {
            for s in 0..constraint.point_count {
                self.impulse.normal_impulses[s] = constraint.points[s].normal_impulse;
                self.impulse.tangent_impulses[s] = constraint.points[s].tangent_impulse;
            }
            listener.post_solve(store, contact, &self.impulse);
        }
    }
}

/// Position integration shared by `Solve` and `SolveTOI`: clamps the step's translation and
/// rotation, then advances each non-static body's sweep and transform.
fn integrate_positions(bodies: &[BodyId], store: &mut Store, step: &TimeStep) {
    for &id in bodies {
        let b = store.body_mut(id);
        if b.is_static() {
            continue;
        }
        let h = step.dt * b.linear_velocity.x;
        let p = step.dt * b.linear_velocity.y;
        if h * h + p * p > MAX_TRANSLATION_SQUARED {
            b.linear_velocity.normalize();
            b.linear_velocity.x *= MAX_TRANSLATION * step.inv_dt;
            b.linear_velocity.y *= MAX_TRANSLATION * step.inv_dt;
        }
        let ang_step = step.dt * b.angular_velocity;
        if ang_step * ang_step > MAX_ROTATION_SQUARED {
            if b.angular_velocity < 0.0 {
                b.angular_velocity = -MAX_ROTATION * step.inv_dt;
            } else {
                b.angular_velocity = MAX_ROTATION * step.inv_dt;
            }
        }
        b.sweep.c0.set_v(b.sweep.c);
        b.sweep.a0 = b.sweep.a;
        b.sweep.c.x += step.dt * b.linear_velocity.x;
        b.sweep.c.y += step.dt * b.linear_velocity.y;
        b.sweep.a += step.dt * b.angular_velocity;
        b.synchronize_transform();
    }
}
