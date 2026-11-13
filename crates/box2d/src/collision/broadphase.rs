//! Port of `b2DynamicTreeBroadPhase` (Box2D.Collision): a dynamic tree plus the move
//! buffer and pair buffer that drive `UpdatePairs`.

use crate::collision::aabb::{AABB, RayCastInput};
use crate::collision::dynamic_tree::DynamicTree;
use crate::common::math::Vec2;
use crate::ids::FixtureId;

pub const NULL_PROXY: u32 = u32::MAX;

/// Most proxy pairs one `update_pairs` call collects. Box2D has no limit, so a
/// map of thousands of overlapping shapes asks for billions of pairs (the
/// original freezes the tab; a server would run out of memory). Every public
/// Hitbox map tested stays below a tenth of this. Hitting it is deterministic:
/// all peers drop the same pairs and report the overload.
pub const MAX_PAIRS: usize = 1 << 20;

/// `b2DynamicTreePair`. Entries are reused across calls like the JS pair buffer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Pair {
    proxy_a: u32,
    proxy_b: u32,
}

/// `b2DynamicTreeBroadPhase`.
#[derive(Debug)]
pub struct BroadPhase {
    tree: DynamicTree,
    move_buffer: Vec<u32>,
    pair_buffer: Vec<Pair>,
    pair_count: usize,
    proxy_count: usize,
    stack: Vec<u32>,
}

impl BroadPhase {
    pub fn new() -> Self {
        BroadPhase {
            tree: DynamicTree::new(),
            move_buffer: Vec::new(),
            pair_buffer: Vec::new(),
            pair_count: 0,
            proxy_count: 0,
            stack: Vec::new(),
        }
    }

    /// `b2DynamicTreeBroadPhase.prototype.CreateProxy`.
    pub fn create_proxy(&mut self, aabb: AABB, user: FixtureId) -> u32 {
        let proxy = self.tree.create_proxy(aabb, user);
        self.proxy_count += 1;
        self.buffer_move(proxy);
        proxy
    }

    /// `b2DynamicTreeBroadPhase.prototype.DestroyProxy`.
    pub fn destroy_proxy(&mut self, proxy: u32) {
        self.unbuffer_move(proxy);
        self.proxy_count -= 1;
        self.tree.destroy_proxy(proxy);
    }

    /// `b2DynamicTreeBroadPhase.prototype.MoveProxy`.
    pub fn move_proxy(&mut self, proxy: u32, aabb: AABB, displacement: Vec2) {
        if self.tree.move_proxy(proxy, aabb, displacement) {
            self.buffer_move(proxy);
        }
    }

    /// `b2DynamicTreeBroadPhase.prototype.TestOverlap`: overlap of the two fat AABBs.
    pub fn test_overlap(&self, proxy_a: u32, proxy_b: u32) -> bool {
        let a = self.tree.get_fat_aabb(proxy_a);
        let b = self.tree.get_fat_aabb(proxy_b);
        a.test_overlap(&b)
    }

    /// `b2DynamicTreeBroadPhase.prototype.GetUserData`.
    pub fn get_user_data(&self, proxy: u32) -> FixtureId {
        self.tree.get_user_data(proxy)
    }

    /// `b2DynamicTreeBroadPhase.prototype.GetFatAABB`.
    pub fn get_fat_aabb(&self, proxy: u32) -> AABB {
        self.tree.get_fat_aabb(proxy)
    }

    /// `b2DynamicTreeBroadPhase.prototype.GetProxyCount`.
    pub fn get_proxy_count(&self) -> usize {
        self.proxy_count
    }

    /// `b2DynamicTreeBroadPhase.prototype.UpdatePairs`. Each moved proxy queries the tree with
    /// its fat AABB; found pairs are recorded as `(moved, found)` (the JS object comparisons
    /// make `proxyA` always the moved proxy), then adjacent duplicates are collapsed and
    /// `callback(userA, userB)` is invoked once per distinct pair in buffer order.
    /// Collection stops at [`MAX_PAIRS`]; returns whether it did.
    pub fn update_pairs(&mut self, callback: &mut dyn FnMut(FixtureId, FixtureId)) -> bool {
        self.pair_count = 0;
        let mut overflow = false;
        for i in 0..self.move_buffer.len() {
            let moved = self.move_buffer[i];
            let fat = self.tree.get_fat_aabb(moved);
            let tree = &self.tree;
            let pair_buffer = &mut self.pair_buffer;
            let pair_count = &mut self.pair_count;
            tree.query_with_stack(
                &mut self.stack,
                &mut |found: u32| {
                    if found == moved {
                        return true;
                    }
                    if *pair_count == MAX_PAIRS {
                        overflow = true;
                        return false;
                    }
                    if *pair_count == pair_buffer.len() {
                        pair_buffer.push(Pair::default());
                    }
                    pair_buffer[*pair_count] = Pair {
                        proxy_a: moved,
                        proxy_b: found,
                    };
                    *pair_count += 1;
                    true
                },
                fat,
            );
            if overflow {
                break;
            }
        }
        self.move_buffer.clear();

        let mut n = 0usize;
        while n < self.pair_count {
            let a = self.pair_buffer[n];
            let user_a = self.tree.get_user_data(a.proxy_a);
            callback(user_a, self.tree.get_user_data(a.proxy_b));
            n += 1;
            while n < self.pair_count {
                let m = self.pair_buffer[n];
                if m.proxy_a != a.proxy_a || m.proxy_b != a.proxy_b {
                    break;
                }
                n += 1;
            }
        }
        overflow
    }

    /// `b2DynamicTreeBroadPhase.prototype.Query`. `callback` returns `false` to stop early.
    pub fn query(&self, callback: &mut dyn FnMut(FixtureId) -> bool, aabb: AABB) {
        let tree = &self.tree;
        tree.query(&mut |proxy: u32| callback(tree.get_user_data(proxy)), aabb);
    }

    /// `b2DynamicTreeBroadPhase.prototype.RayCast`. The callback receives the sub-input and the
    /// hit fixture's user data; its return value follows `DynamicTree::ray_cast`.
    pub fn ray_cast(
        &self,
        callback: &mut dyn FnMut(&RayCastInput, FixtureId) -> f64,
        input: RayCastInput,
    ) {
        let tree = &self.tree;
        tree.ray_cast(
            &mut |sub: &RayCastInput, proxy: u32| callback(sub, tree.get_user_data(proxy)),
            input,
        );
    }

    /// `b2DynamicTreeBroadPhase.prototype.Rebalance`.
    pub fn rebalance(&mut self, iterations: usize) {
        self.tree.rebalance(iterations);
    }

    /// Resets the broadphase to its freshly constructed state.
    pub fn clear(&mut self) {
        self.tree.clear();
        self.move_buffer.clear();
        self.pair_buffer.clear();
        self.pair_count = 0;
        self.proxy_count = 0;
    }

    /// `b2DynamicTreeBroadPhase.prototype.BufferMove`.
    fn buffer_move(&mut self, proxy: u32) {
        self.move_buffer.push(proxy);
    }

    /// `b2DynamicTreeBroadPhase.prototype.UnBufferMove`. JS does `splice(indexOf(t), 1)`; when the
    /// proxy is absent `indexOf` is -1 and `splice(-1, 1)` removes the last element.
    fn unbuffer_move(&mut self, proxy: u32) {
        match self.move_buffer.iter().position(|&p| p == proxy) {
            Some(i) => {
                self.move_buffer.remove(i);
            }
            None => {
                self.move_buffer.pop();
            }
        }
    }
}
