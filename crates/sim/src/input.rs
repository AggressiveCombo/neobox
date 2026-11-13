//! Player input for one tick (8 buttons, packed as a byte).

pub const LEFT: u8 = 1;
pub const RIGHT: u8 = 2;
pub const UP: u8 = 4;
pub const DOWN: u8 = 8;
/// Force push (default key X).
pub const PUSH: u8 = 16;
/// Rocket / special (default key Z).
pub const ROCKET: u8 = 32;
/// Bat (default key C).
pub const BAT: u8 = 64;
/// Grab / parachute (default key V).
pub const GRAB: u8 = 128;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Input {
    pub left: bool,
    pub right: bool,
    pub up: bool,
    pub down: bool,
    pub push: bool,
    pub rocket: bool,
    pub bat: bool,
    pub grab: bool,
}

impl Input {
    pub fn from_mask(m: u8) -> Input {
        Input {
            left: m & LEFT != 0,
            right: m & RIGHT != 0,
            up: m & UP != 0,
            down: m & DOWN != 0,
            push: m & PUSH != 0,
            rocket: m & ROCKET != 0,
            bat: m & BAT != 0,
            grab: m & GRAB != 0,
        }
    }

    pub fn mask(&self) -> u8 {
        (self.left as u8) * LEFT
            | (self.right as u8) * RIGHT
            | (self.up as u8) * UP
            | (self.down as u8) * DOWN
            | (self.push as u8) * PUSH
            | (self.rocket as u8) * ROCKET
            | (self.bat as u8) * BAT
            | (self.grab as u8) * GRAB
    }
}
