// The one node:buffer API the connector uses (nodejs_compat provides the module at runtime).
declare module "node:buffer" {
  export const Buffer: {
    from(buffer: ArrayBufferLike, byteOffset: number, length: number): { toString(encoding: "base64"): string };
  };
}
