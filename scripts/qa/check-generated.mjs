import { runGeneratedMaintenance } from '../build/generated.mjs';

if (!(await runGeneratedMaintenance(['check', '--source-only']))) process.exitCode = 1;
