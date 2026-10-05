import { executeVerification } from './verification.js';
process.env.THINKER_TEST = '1';
process.env.THINKER_TELEMETRY = 'off';
executeVerification(process.argv[2], process.argv[3]).catch(e => { console.error(e); process.exitCode = 1; });
