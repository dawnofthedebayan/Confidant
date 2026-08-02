import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    // transformers.js pulls these in only on the node path; the plugin runs
    // the browser/wasm path, so keeping them external avoids bundling ONNX
    // native bindings that Obsidian can't load anyway.
    "onnxruntime-node",
    "sharp",
    ...builtinModules,
  ],
  format: "cjs",
  // transformers.js uses BigInt literals, so es2020 is the floor here.
  // Obsidian's Electron is well past that.
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  platform: "browser",
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
