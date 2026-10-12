declare const PATEAT_BUILD_REVISION: string;

declare module "*.svg?raw" {
  const content: string;
  export default content;
}
