// A failed server request. The message is player-facing copy; the status stays on the error for code that
// needs it. Never put a status code or URL in a message: the player sees it (toasts, error panels).

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(httpCopy(status));
    this.name = "HttpError";
    this.status = status;
  }
}

function httpCopy(status: number): string {
  if (status === 404) return "That could not be found.";
  if (status >= 500) return "The server ran into a problem. Try again in a moment.";
  return "The server could not complete that request. Try again.";
}
