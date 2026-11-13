//! Slot arena with a free list. Removed slots are reused by later inserts;
//! `clear` drops all objects but keeps the backing allocations.

#[derive(Debug, Clone)]
pub struct Arena<T> {
    slots: Vec<Option<T>>,
    free: Vec<u32>,
}

impl<T> Default for Arena<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Arena<T> {
    pub fn new() -> Self {
        Arena {
            slots: Vec::new(),
            free: Vec::new(),
        }
    }

    /// Stores `value` and returns its index.
    pub fn insert(&mut self, value: T) -> u32 {
        if let Some(index) = self.free.pop() {
            self.slots[index as usize] = Some(value);
            index
        } else {
            self.slots.push(Some(value));
            (self.slots.len() - 1) as u32
        }
    }

    /// Removes and returns the object at `index`. Panics if the slot is empty.
    pub fn remove(&mut self, index: u32) -> T {
        let value = self.slots[index as usize]
            .take()
            .expect("arena: removing an empty slot");
        self.free.push(index);
        value
    }

    /// Drops every object and forgets the free list, keeping capacity.
    pub fn clear(&mut self) {
        self.slots.clear();
        self.free.clear();
    }

    pub fn get(&self, index: u32) -> &T {
        self.slots[index as usize]
            .as_ref()
            .expect("arena: empty slot")
    }

    pub fn get_mut(&mut self, index: u32) -> &mut T {
        self.slots[index as usize]
            .as_mut()
            .expect("arena: empty slot")
    }

    pub fn try_get(&self, index: u32) -> Option<&T> {
        self.slots.get(index as usize).and_then(|s| s.as_ref())
    }

    /// Number of live objects.
    pub fn len(&self) -> usize {
        self.slots.len() - self.free.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
