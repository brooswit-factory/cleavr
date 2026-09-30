// esbuild's text loader (build.mjs) turns a `.css` import into the
// stylesheet's raw text content — used to inline xterm's CSS into the
// panel's shadow root (src/content/terminal.ts) without a <link> tag or any
// network fetch, since MV3 forbids remote script/stylesheets.
declare module "*.css" {
  const content: string;
  export default content;
}
