// build.ts defines BUILD_ID: this build's id (also written to build-id.txt, which the server reads). Unset in dev runs.
declare const BUILD_ID: string | undefined;

/** This client's build id, sent in the hello: a server on another build refuses the game connection. */
export const buildId: string | undefined = typeof BUILD_ID === "string" ? BUILD_ID : undefined;
