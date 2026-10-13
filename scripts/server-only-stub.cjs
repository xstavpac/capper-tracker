// Preloaded by scripts/run-tests.mjs (node --require) and imported first by the t2-harness scripts. The `server-only` package throws on import
// anywhere but a React Server build, which is the point of it: a server data module that reaches
// a client bundle fails `next build`. A test or script run under tsx is neither, so this marks the
// package as already loaded (and empty) before any module asks for it.
//
// To run one guarded module by hand:
//   node --require ./scripts/server-only-stub.cjs --import tsx <file>
const path = require.resolve("server-only");
require.cache[path] = Object.assign(new (require("node:module"))(path), { filename: path, loaded: true, exports: {} });
