// Stick axes of connected gamepads. An axis counts only once it has been seen at rest since its pad connected: a
// pedal or wheel axis (a racing wheel or pedal set in Steam) rests at -1 or +1, so reading it at once would steer
// or roll a menu forever.

/** An axis within this distance of zero is at rest. */
const REST = 0.5;

/** Axes seen at rest, keyed `<pad index>:<axis>`. */
const armed = new Set<string>();

window.addEventListener("gamepadconnected", (e) => {
  const prefix = `${e.gamepad.index}:`;
  for (const key of armed) if (key.startsWith(prefix)) armed.delete(key);
});

/** The value of `axis` on `pad` if it counts as input now, else 0. Call it on every poll that reads the axis. */
export function armedAxis(pad: Gamepad, axis: number): number {
  const v = pad.axes[axis] ?? 0;
  const key = `${pad.index}:${axis}`;
  if (Math.abs(v) <= REST) {
    armed.add(key);
    return v;
  }
  return armed.has(key) ? v : 0;
}
