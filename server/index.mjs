import {start} from '../scripts/start.mjs';

// Development can run alongside Vite without an existing dist/. It shares the
// same network-origin and private setup-token rules as the packaged launcher.
await start({openBrowser: false, requireFrontend: false});
