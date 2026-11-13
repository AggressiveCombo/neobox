//! Port of `b2DynamicTree` (Box2D.Collision): an AABB tree stored in an arena
//! with an intrusive free list. Node indices are `u32`; `NULL_NODE` marks absence.

use crate::collision::aabb::{AABB, RayCastInput};
use crate::common::math::{Vec2, abs_v, cross_fv, js_max, js_min, subtract_vv};
use crate::common::settings::{AABB_EXTENSION, AABB_MULTIPLIER};
use crate::ids::FixtureId;

pub const NULL_NODE: u32 = u32::MAX;

/// Stand-in for JS `null` user data on internal nodes. Callers only read user data of leaves.
const NULL_USER_DATA: FixtureId = FixtureId(u32::MAX);

/// `b2DynamicTreeNode`. While on the free list, `parent` links to the next free node.
#[derive(Clone, Copy, Debug)]
struct Node {
    aabb: AABB,
    user_data: FixtureId,
    parent: u32,
    child1: u32,
    child2: u32,
}

impl Node {
    fn is_leaf(&self) -> bool {
        self.child1 == NULL_NODE
    }
}

/// Center-distance metric (`|cx - ox| + |cy - oy|`) used by `InsertLeaf` to pick a child.
fn center_distance(aabb: &AABB, o: Vec2) -> f64 {
    ((aabb.lower_bound.x + aabb.upper_bound.x) / 2.0 - o.x).abs()
        + ((aabb.lower_bound.y + aabb.upper_bound.y) / 2.0 - o.y).abs()
}

/// `b2DynamicTree`.
#[derive(Debug)]
pub struct DynamicTree {
    nodes: Vec<Node>,
    root: u32,
    free_list: u32,
    path: u32,
}

impl DynamicTree {
    pub fn new() -> Self {
        DynamicTree {
            nodes: Vec::new(),
            root: NULL_NODE,
            free_list: NULL_NODE,
            path: 0,
        }
    }

    /// `b2DynamicTree.prototype.CreateProxy`: inserts a leaf with the fattened `aabb`.
    pub fn create_proxy(&mut self, aabb: AABB, user: FixtureId) -> u32 {
        let e = self.allocate_node();
        let node = &mut self.nodes[e as usize];
        node.aabb.lower_bound.x = aabb.lower_bound.x - AABB_EXTENSION;
        node.aabb.lower_bound.y = aabb.lower_bound.y - AABB_EXTENSION;
        node.aabb.upper_bound.x = aabb.upper_bound.x + AABB_EXTENSION;
        node.aabb.upper_bound.y = aabb.upper_bound.y + AABB_EXTENSION;
        node.user_data = user;
        self.insert_leaf(e);
        e
    }

    /// `b2DynamicTree.prototype.DestroyProxy`.
    pub fn destroy_proxy(&mut self, id: u32) {
        self.remove_leaf(id);
        self.free_node(id);
    }

    /// `b2DynamicTree.prototype.MoveProxy`. Returns `true` if the leaf was reinserted.
    pub fn move_proxy(&mut self, id: u32, aabb: AABB, displacement: Vec2) -> bool {
        if self.nodes[id as usize].aabb.contains(&aabb) {
            return false;
        }
        self.remove_leaf(id);
        let s = AABB_EXTENSION
            + AABB_MULTIPLIER
                * (if displacement.x > 0.0 {
                    displacement.x
                } else {
                    -displacement.x
                });
        let r = AABB_EXTENSION
            + AABB_MULTIPLIER
                * (if displacement.y > 0.0 {
                    displacement.y
                } else {
                    -displacement.y
                });
        let node = &mut self.nodes[id as usize];
        node.aabb.lower_bound.x = aabb.lower_bound.x - s;
        node.aabb.lower_bound.y = aabb.lower_bound.y - r;
        node.aabb.upper_bound.x = aabb.upper_bound.x + s;
        node.aabb.upper_bound.y = aabb.upper_bound.y + r;
        self.insert_leaf(id);
        true
    }

    /// `b2DynamicTree.prototype.Rebalance`: removes and reinserts `iterations` leaves,
    /// selected by the rotating `path` bit pattern.
    pub fn rebalance(&mut self, iterations: usize) {
        if self.root == NULL_NODE {
            return;
        }
        for _ in 0..iterations {
            let mut e = self.root;
            let mut n: u32 = 0;
            while !self.nodes[e as usize].is_leaf() {
                let node = &self.nodes[e as usize];
                e = if (self.path >> n) & 1 == 1 {
                    node.child2
                } else {
                    node.child1
                };
                n = (n + 1) & 31;
            }
            self.path = self.path.wrapping_add(1);
            self.remove_leaf(e);
            self.insert_leaf(e);
        }
    }

    /// `b2DynamicTree.prototype.GetFatAABB`.
    pub fn get_fat_aabb(&self, id: u32) -> AABB {
        self.nodes[id as usize].aabb
    }

    /// `b2DynamicTree.prototype.GetUserData`.
    pub fn get_user_data(&self, id: u32) -> FixtureId {
        self.nodes[id as usize].user_data
    }

    /// Removes all nodes. Equivalent to constructing a fresh tree.
    pub fn clear(&mut self) {
        self.nodes.clear();
        self.root = NULL_NODE;
        self.free_list = NULL_NODE;
        self.path = 0;
    }

    /// `b2DynamicTree.prototype.Query`. `callback` returns `false` to stop early.
    pub fn query(&self, callback: &mut dyn FnMut(u32) -> bool, aabb: AABB) {
        let mut stack = Vec::new();
        self.query_with_stack(&mut stack, callback, aabb);
    }

    /// `Query` using a caller-owned traversal stack (cleared on entry), to avoid per-call allocation.
    pub fn query_with_stack(
        &self,
        stack: &mut Vec<u32>,
        callback: &mut dyn FnMut(u32) -> bool,
        aabb: AABB,
    ) {
        if self.root == NULL_NODE {
            return;
        }
        stack.clear();
        stack.push(self.root);
        while let Some(id) = stack.pop() {
            let node = &self.nodes[id as usize];
            if node.aabb.test_overlap(&aabb) {
                if node.is_leaf() {
                    if !callback(id) {
                        return;
                    }
                } else {
                    stack.push(node.child1);
                    stack.push(node.child2);
                }
            }
        }
    }

    /// `b2DynamicTree.prototype.RayCast`. `callback` returns the new max fraction:
    /// `0` stops, a positive value clips the ray box, a negative value ignores the hit.
    pub fn ray_cast(
        &self,
        callback: &mut dyn FnMut(&RayCastInput, u32) -> f64,
        input: RayCastInput,
    ) {
        let mut stack = Vec::new();
        self.ray_cast_with_stack(&mut stack, callback, input);
    }

    /// `RayCast` using a caller-owned traversal stack (cleared on entry).
    pub fn ray_cast_with_stack(
        &self,
        stack: &mut Vec<u32>,
        callback: &mut dyn FnMut(&RayCastInput, u32) -> f64,
        input: RayCastInput,
    ) {
        if self.root == NULL_NODE {
            return;
        }
        let e = input.p1;
        let n = input.p2;
        let mut r = subtract_vv(e, n);
        r.normalize();
        let a = cross_fv(1.0, r);
        let l = abs_v(a);
        let mut c = input.max_fraction;
        let mut h = AABB::default();
        let mut p = e.x + c * (n.x - e.x);
        let mut y = e.y + c * (n.y - e.y);
        h.lower_bound.x = js_min(e.x, p);
        h.lower_bound.y = js_min(e.y, y);
        h.upper_bound.x = js_max(e.x, p);
        h.upper_bound.y = js_max(e.y, y);

        stack.clear();
        stack.push(self.root);
        while let Some(id) = stack.pop() {
            let node = &self.nodes[id as usize];
            if !node.aabb.test_overlap(&h) {
                continue;
            }
            let f = node.aabb.get_center();
            let d = node.aabb.get_extents();
            if (a.x * (e.x - f.x) + a.y * (e.y - f.y)).abs() - l.x * d.x - l.y * d.y > 0.0 {
                continue;
            }
            if node.is_leaf() {
                let sub = RayCastInput {
                    p1: input.p1,
                    p2: input.p2,
                    max_fraction: input.max_fraction,
                };
                c = callback(&sub, id);
                if c == 0.0 {
                    return;
                }
                if c > 0.0 {
                    p = e.x + c * (n.x - e.x);
                    y = e.y + c * (n.y - e.y);
                    h.lower_bound.x = js_min(e.x, p);
                    h.lower_bound.y = js_min(e.y, y);
                    h.upper_bound.x = js_max(e.x, p);
                    h.upper_bound.y = js_max(e.y, y);
                }
            } else {
                stack.push(node.child1);
                stack.push(node.child2);
            }
        }
    }

    /// `b2DynamicTree.prototype.AllocateNode`: pops the free list or grows the arena.
    fn allocate_node(&mut self) -> u32 {
        if self.free_list != NULL_NODE {
            let id = self.free_list;
            let node = &mut self.nodes[id as usize];
            self.free_list = node.parent;
            node.parent = NULL_NODE;
            node.child1 = NULL_NODE;
            node.child2 = NULL_NODE;
            return id;
        }
        self.nodes.push(Node {
            aabb: AABB::default(),
            user_data: NULL_USER_DATA,
            parent: NULL_NODE,
            child1: NULL_NODE,
            child2: NULL_NODE,
        });
        (self.nodes.len() - 1) as u32
    }

    /// `b2DynamicTree.prototype.FreeNode`: pushes onto the free list.
    fn free_node(&mut self, id: u32) {
        self.nodes[id as usize].parent = self.free_list;
        self.free_list = id;
    }

    /// `b2DynamicTree.prototype.InsertLeaf`.
    fn insert_leaf(&mut self, leaf: u32) {
        if self.root == NULL_NODE {
            self.root = leaf;
            self.nodes[leaf as usize].parent = NULL_NODE;
            return;
        }

        let o = self.nodes[leaf as usize].aabb.get_center();
        let mut e = self.root;
        if !self.nodes[e as usize].is_leaf() {
            loop {
                let s = self.nodes[e as usize].child1;
                let r = self.nodes[e as usize].child2;
                e = if center_distance(&self.nodes[s as usize].aabb, o)
                    < center_distance(&self.nodes[r as usize].aabb, o)
                {
                    s
                } else {
                    r
                };
                if self.nodes[e as usize].is_leaf() {
                    break;
                }
            }
        }

        let sibling = e;
        let old_parent = self.nodes[sibling as usize].parent;
        let leaf_aabb = self.nodes[leaf as usize].aabb;
        let sibling_aabb = self.nodes[sibling as usize].aabb;
        let new_parent = self.allocate_node();
        {
            let np = &mut self.nodes[new_parent as usize];
            np.parent = old_parent;
            np.user_data = NULL_USER_DATA;
            np.aabb.combine_from(&leaf_aabb, &sibling_aabb);
        }
        self.nodes[new_parent as usize].child1 = sibling;
        self.nodes[new_parent as usize].child2 = leaf;
        self.nodes[sibling as usize].parent = new_parent;
        self.nodes[leaf as usize].parent = new_parent;

        if old_parent != NULL_NODE {
            if self.nodes[old_parent as usize].child1 == sibling {
                self.nodes[old_parent as usize].child1 = new_parent;
            } else {
                self.nodes[old_parent as usize].child2 = new_parent;
            }

            let mut l = new_parent;
            let mut a = old_parent;
            while a != NULL_NODE {
                if self.nodes[a as usize]
                    .aabb
                    .contains(&self.nodes[l as usize].aabb)
                {
                    break;
                }
                let c1 = self.nodes[a as usize].child1;
                let c2 = self.nodes[a as usize].child2;
                let a1 = self.nodes[c1 as usize].aabb;
                let a2 = self.nodes[c2 as usize].aabb;
                self.nodes[a as usize].aabb.combine_from(&a1, &a2);
                l = a;
                a = self.nodes[a as usize].parent;
            }
        } else {
            self.root = new_parent;
        }
    }

    /// `b2DynamicTree.prototype.RemoveLeaf`.
    fn remove_leaf(&mut self, leaf: u32) {
        if leaf == self.root {
            self.root = NULL_NODE;
            return;
        }

        let e = self.nodes[leaf as usize].parent;
        let mut n = self.nodes[e as usize].parent;
        let o = if self.nodes[e as usize].child1 == leaf {
            self.nodes[e as usize].child2
        } else {
            self.nodes[e as usize].child1
        };

        if n != NULL_NODE {
            if self.nodes[n as usize].child1 == e {
                self.nodes[n as usize].child1 = o;
            } else {
                self.nodes[n as usize].child2 = o;
            }
            self.nodes[o as usize].parent = n;
            self.free_node(e);

            while n != NULL_NODE {
                let s = self.nodes[n as usize].aabb;
                let c1 = self.nodes[n as usize].child1;
                let c2 = self.nodes[n as usize].child2;
                let a1 = self.nodes[c1 as usize].aabb;
                let a2 = self.nodes[c2 as usize].aabb;
                self.nodes[n as usize].aabb = AABB::combine(&a1, &a2);
                if s.contains(&self.nodes[n as usize].aabb) {
                    break;
                }
                n = self.nodes[n as usize].parent;
            }
        } else {
            self.root = o;
            self.nodes[o as usize].parent = NULL_NODE;
            self.free_node(e);
        }
    }
}
