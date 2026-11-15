// Entry point: applies the colour theme, sets the favicon to the logo, mounts
// the app, and greets touch-only devices with the phone welcome.

import { start } from "./app";
import { startTheme } from "./theme";
import { LOGO_URL } from "./ui/logo";
import { showPhoneSplash } from "./ui/phone-splash";

startTheme();
start();
showPhoneSplash();

const icon = document.createElement("link");
icon.rel = "icon";
icon.type = "image/svg+xml";
icon.href = LOGO_URL;
document.head.appendChild(icon);
