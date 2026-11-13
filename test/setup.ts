import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs before config imports, including when a test is invoked directly with tsx.
const dataDir = mkdtempSync(join(tmpdir(), 'minimi-test-'));
process.env.DATA_DIR = dataDir;
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));
