// socket.io-client ships without bundled type declarations, and we only use it
// behind a dynamic import typed as `any` (see feeder/sources/pocsag.ts). This
// stub satisfies `next build`'s type check without pulling in @types for a
// different major version of the library.
declare module "socket.io-client";
