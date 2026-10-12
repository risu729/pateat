declare const PATEAT_BUILD_REVISION: string;

/** An asset Vite emits beside the bundle, imported as its URL. */
declare module "*.svg?url" {
  const url: string;
  export default url;
}
