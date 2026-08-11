// Deliberately its own plain module, not exported from expandable-rows.tsx -
// that file has "use client" at the top, and Next's RSC compiler treats
// EVERY export from a "use client" module as an opaque client reference when
// imported elsewhere, even a plain number like this. A Server Component
// (trending-cappers.tsx) importing EXPANDABLE_ROWS_MAX from the client file
// got a reference object instead of 10 at server-render time - .slice(0,
// <that object>) coerced to NaN, then to 0, silently producing an empty
// array every time (this was found and fixed after the exact symptom:
// ExpandableRows always received a 0-length children array despite the
// server-side panel data being non-empty). Keeping this constant in a
// plain .ts file with no "use client" directive means both the Server
// Component that pre-renders rows and the Client Component that slices them
// import the same real number, not a boundary-crossing reference.
export const CONDENSED_COUNT = 3;
export const EXPANDABLE_ROWS_MAX = 10;
