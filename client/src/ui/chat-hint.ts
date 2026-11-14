// Placeholder for chat inputs: touch players tap the box to type, everyone else presses Enter.

/** The chat input placeholder for this device. */
export function chatPlaceholder(): string {
  const touch = matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  return touch ? "Tap here to send a message" : "Press Enter to send a message";
}
