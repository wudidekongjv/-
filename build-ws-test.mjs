import { build } from "esbuild";

await build({
    entryPoints: ["src/ws-test.js"],
    outfile: "dist/ws-test.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "eof",
});

console.log("built dist/ws-test.js");
