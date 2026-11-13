// Entry point: sets the favicon from the inline logo, then mounts the app.

import { start } from "./app";
import { logoSvg } from "./ui/logo";

start();

const icon = document.createElement("link");
icon.rel = "icon";
icon.type = "image/svg+xml";
icon.href = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(logoSvg(64)))}`;
document.head.appendChild(icon);

