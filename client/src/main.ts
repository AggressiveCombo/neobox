// Entry point: sets the favicon to the logo, then mounts the app.

import { start } from "./app";
import { LOGO_URL } from "./ui/logo";

start();

const icon = document.createElement("link");
icon.rel = "icon";
icon.type = "image/svg+xml";
icon.href = LOGO_URL;
document.head.appendChild(icon);
