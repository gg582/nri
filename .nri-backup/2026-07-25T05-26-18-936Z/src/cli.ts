#!/usr/bin/env node
import { main } from './index';
import { validateRequest } from './validateRequest';

const rawRequest = process.argv.slice(2).join(' ') || '';

try {
  validateRequest(rawRequest);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

main();
