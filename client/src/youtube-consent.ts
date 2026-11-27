// Whether the player may load YouTube: jukebox videos and room thumbnails. Off until the player allows it, from the
// jukebox panel or Settings; the choice is kept on this device. Nothing from YouTube loads while it is off.

import { local } from "./storage";
import { YOUTUBE_ALLOWED_KEY } from "./storage-keys";

type Listener = (on: boolean) => void;

const listeners = new Set<Listener>();

function readAllowed(): boolean {
  try {
    return local.getItem(YOUTUBE_ALLOWED_KEY) === "1";
  } catch {
    return false;
  }
}

let allowed = readAllowed();

/** Whether YouTube may load on this device. */
export function youtubeAllowed(): boolean {
  return allowed;
}

/** Allows or refuses YouTube on this device and tells every listener. */
export function setYouTubeAllowed(on: boolean): void {
  allowed = on;
  try {
    local.setItem(YOUTUBE_ALLOWED_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  for (const listener of listeners) listener(on);
}

/** Calls `listener` whenever the choice changes; returns the function that stops it. */
export function onYouTubeAllowed(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
