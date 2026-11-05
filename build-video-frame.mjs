import { build } from "esbuild";

await build({
    entryPoints: ["src/video-frame.js"],
    outfile: "dist/video-frame.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "eof",
});

console.log("built dist/video-frame.js");
