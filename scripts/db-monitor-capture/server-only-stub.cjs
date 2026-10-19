// server-only throws outside a React Server build; mark it loaded+empty, resolved from the cwd worktree (absent on older SHAs).
let path; try { path = require.resolve("server-only", { paths: [process.cwd()] }); } catch {}
if (path) require.cache[path] = Object.assign(new (require("node:module"))(path), { filename: path, loaded: true, exports: {} });
