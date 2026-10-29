import { createVercelHandler } from '../server/vercel-runtime.mjs';

// Native Node.js function for the Vite app. NODEJS_HELPERS=0 preserves the raw
// body stream, allowing the API to enforce byte limits before JSON decoding.
export default createVercelHandler();
