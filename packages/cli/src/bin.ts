#!/usr/bin/env node
import { realIo, run } from './main.js';

process.exitCode = await run(process.argv.slice(2), realIo());
