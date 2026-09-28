/**
 * Process lifecycle flag. On SIGTERM the process first reports "not ready" (so a load
 * balancer stops sending new requests), then drains in-flight work, then exits.
 */
let shuttingDown = false;

export const lifecycle = {
  get shuttingDown() {
    return shuttingDown;
  },
  beginShutdown() {
    shuttingDown = true;
  },
};
