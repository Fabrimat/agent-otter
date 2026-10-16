// Must be the FIRST import of main.tsx: protocol schemas are built at import time and zod decides there whether to probe `new Function`.
// That probe is a reported violation under our strict CSP (no 'unsafe-eval'); interpreted mode has none.
import * as z from 'zod/v4';

z.config({ jitless: true });
