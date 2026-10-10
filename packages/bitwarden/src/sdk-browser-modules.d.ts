declare module "@bitwarden/sdk-internal/index.js" {
  export * from "@bitwarden/sdk-internal";
  export function init(exports: WebAssembly.Exports): void;
}

declare module "@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.js" {
  const bindings: WebAssembly.ModuleImports;
  export = bindings;
}

declare module "@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.wasm?url" {
  const asset: string;
  export default asset;
}
