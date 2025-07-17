import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from 'fs';
import path from 'path';

const prod = process.argv[2] === "production";

const context = await esbuild.context({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["obsidian", "electron", ...builtins],
    format: "cjs",
    target: "es2018",
    logLevel: "info",
    sourcemap: "inline",
    sourcesContent: !prod,
    treeShaking: true,
    outfile: "main.js",
});

if (prod) {
    context.rebuild().catch(() => process.exit(1));
    context.dispose();
} else {
    context.watch().catch(() => process.exit(1));
}
// 构建成功后拷贝 manifest.json 到 build/
fs.copyFileSync('manifest.json', 'build/manifest.json');