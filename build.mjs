import { build } from "esbuild";

await build({
    entryPoints: ["src/index.js"],
    outfile: "dist/director.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "eof",
});

console.log("built dist/director.js");
