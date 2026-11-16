// Entry point: applies the colour theme, sets the favicon to the logo, mounts
// the app, and greets touch-only devices with the phone welcome.

import { installUiSounds } from "./audio";
import { start } from "./app";
import { startTheme } from "./theme";
import { watchServiceWorker } from "./sw-update";
import { LOGO_URL } from "./ui/logo";
import { showPhoneSplash } from "./ui/phone-splash";

startTheme();
const store = start();
installUiSounds();
showPhoneSplash();

// Service worker: caches the app shell (offline after one online visit) and takes over updates.
watchServiceWorker(store);

const icon = document.createElement("link");
icon.rel = "icon";
icon.type = "image/svg+xml";
icon.href = LOGO_URL;
document.head.appendChild(icon);
