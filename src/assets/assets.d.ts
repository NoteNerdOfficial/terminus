/** Images bundled into main.js as data URLs (esbuild's "dataurl" loader). */
declare module "*.gif" {
  const dataUrl: string;
  export default dataUrl;
}
