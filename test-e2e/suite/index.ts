import * as path from 'node:path';

import { glob } from 'glob';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 60000 });
  const testsRoot = __dirname;

  const files = await glob('**/*.test.js', { cwd: testsRoot });
  if (files.length === 0) {
    throw new Error(`No E2E test files matched '**/*.test.js' in ${testsRoot}.`);
  }
  for (const file of files) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  await new Promise<void>((resolve, reject) => {
    const runner = mocha.run((failures) => {
      if (failures > 0) reject(new Error(`${failures} tests failed.`));
      else if (runner.stats!.tests === 0) reject(new Error('E2E suite ran 0 tests.'));
      else resolve();
    });
  });
}
