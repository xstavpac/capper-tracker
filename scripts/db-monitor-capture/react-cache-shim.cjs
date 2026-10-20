// React cache() exists only in server builds; outside Next it is undefined. Pass-through.
const react = require(require.resolve("react", { paths: [process.cwd()] }));
if (typeof react.cache !== "function") react.cache = (fn) => fn;
