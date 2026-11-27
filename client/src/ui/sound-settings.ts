// The Sound panel's controls: the master, music, effects and jukebox levels, and the
// switches for mutes and interface sounds. It reads and writes prefs itself, so the
// settings screen only places it.

import { prefs, type Prefs } from "../prefs";
import { h } from "./dom";
import { toggle } from "./kit";
import { onYouTubeAllowed, setYouTubeAllowed, youtubeAllowed } from "../youtube-consent";

interface Level {
  el: HTMLElement;
  set(percent: number): void;
}

/** A 0..100 slider with its current value shown beside the label. */
function level(label: string, onChange: (percent: number) => void): Level {
  const out = h("output", { class: "settings-value num" });
  const input = h("input", {
    type: "range",
    min: 0,
    max: 100,
    step: 1,
    class: "settings-range",
    "aria-label": label,
    oninput: () => {
      const v = Number(input.value);
      out.textContent = `${v}%`;
      onChange(v);
    },
  });
  return {
    el: h("div", { class: "settings-field" }, h("div", { class: "settings-field-head" }, h("span", { class: "field-label" }, label), out), input),
    set(v) {
      input.value = String(v);
      out.textContent = `${v}%`;
    },
  };
}

/** A switch that shows and sets one boolean pref. */
function flag(label: string, hint: string | null, read: (p: Prefs) => boolean, write: (on: boolean) => void): { el: HTMLElement; set(p: Prefs): void } {
  const el = toggle(label, false, write, hint ?? undefined);
  const box = el.querySelector("input");
  if (!box) throw new Error("toggle without a switch");
  return {
    el,
    set(p) {
      box.checked = read(p);
    },
  };
}

/** The Sound panel's body, kept in step with prefs whenever they change. */
export function soundSettingsSection(): HTMLElement {
  const master = level("Volume", (v) => prefs.set({ volume: v / 100 }));
  const music = level("Music volume", (v) => prefs.set({ musicVolume: v / 100 }));
  const effects = level("Effects volume", (v) => prefs.set({ sfxVolume: v / 100 }));
  const jukebox = level("Jukebox volume", (v) => prefs.set({ jukeboxVolume: v / 100 }));
  const switches = [
    flag("Mute all sound", null, (p) => p.muted, (on) => prefs.set({ muted: on })),
    flag("Mute menu music", null, (p) => p.musicMuted, (on) => prefs.set({ musicMuted: on })),
    flag("Mute match music", "The in-game playlist.", (p) => p.matchMusicMuted, (on) => prefs.set({ matchMusicMuted: on })),
    flag("Interface sounds", "Hovers, clicks, switches, tabs, dialogs and toasts.", (p) => p.uiSounds, (on) => prefs.set({ uiSounds: on })),
    flag("Jukebox popup", "Show the floating jukebox controls when a song plays (audio plays either way).", (p) => p.jukeboxPopup, (on) => prefs.set({ jukeboxPopup: on })),
  ];
  const youtube = toggle(
    "Allow YouTube",
    youtubeAllowed(),
    (on) => setYouTubeAllowed(on),
    "Jukebox videos load YouTube's player only while this is on. The player receives your IP address and may store cookies.",
  );
  const youtubeBox = youtube.querySelector("input");
  if (!youtubeBox) throw new Error("toggle without a switch");
  const unsubscribe = onYouTubeAllowed((on) => {
    youtubeBox.checked = on;
    // The Sound panel is built each time Settings opens: stop listening once it has left the page.
    if (!root.isConnected) unsubscribe();
  });

  const root = h(
    "div",
    { class: "sound-settings" },
    master.el,
    music.el,
    effects.el,
    jukebox.el,
    youtube,
    ...switches.map((s) => s.el),
  );

  const sync = (p: Prefs): void => {
    master.set(Math.round(p.volume * 100));
    music.set(Math.round(p.musicVolume * 100));
    effects.set(Math.round(p.sfxVolume * 100));
    jukebox.set(Math.round(p.jukeboxVolume * 100));
    for (const s of switches) s.set(p);
  };
  sync(prefs.value);
  prefs.subscribe(sync);
  return root;
}
