import { execFileSync } from 'node:child_process';

import { OPENAPI_SCHEMA_URL } from '../src/client/constants.js';

const OUTPUT_PATH = 'src/client/schema.d.ts';

// openapi-typescript is run via `pnpm dlx` (isolated, temporary environment)
// rather than installed as a devDependency: it relies on the classic
// TypeScript Compiler API (`ts.factory`), which the project's typescript@7
// (native compiler preview) no longer exposes. Running it in isolation lets
// it resolve its own compatible typescript without downgrading the project's
// toolchain.
const generateApiTypes = () => {
  console.log(`Generating ${OUTPUT_PATH} from ${OPENAPI_SCHEMA_URL} ...`);

  execFileSync(
    'pnpm',
    ['dlx', 'openapi-typescript@7', OPENAPI_SCHEMA_URL, '-o', OUTPUT_PATH],
    { stdio: 'inherit' },
  );
};

generateApiTypes();
