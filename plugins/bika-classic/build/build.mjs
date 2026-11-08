import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = resolve(root, "../bika");
const require = createRequire(resolve(core, "package.json"));
const { rspack } = require("@rspack/core");
const localInfo = resolve(root, "src/info.ts");
const coreSrc = resolve(core, "src");

// Compile proven adapters into this installation; do not import another
// installed plugin at runtime. Only the core's metadata and identity modules
// are substituted. Unrecognized future source IDs fail the bundle audit below.
const config = {
  mode: "production",
  entry: resolve(root, "src/index.ts"),
  target: "web",
  devtool: false,
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        loader: "builtin:swc-loader",
        options: { jsc: { parser: { syntax: "typescript" }, target: "es2020" } },
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js", ".json"],
    modules: [resolve(core, "node_modules"), "node_modules"],
  },
  output: {
    path: resolve(root, "dist"),
    filename: "breeze-plugin-bika-classic.bundle.cjs",
    library: { type: "commonjs2" },
  },
  plugins: [
    new rspack.NormalModuleReplacementPlugin(/^\.\/(info|bika-identity)$/, (resource) => {
      if (resource.context === coreSrc)
        resource.request =
          resource.request === "./info" ? localInfo : resolve(root, "src/identity.ts");
    }),
  ],
};

await new Promise((done, reject) => {
  rspack(config, (error, stats) => {
    if (error) return reject(error);
    if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
    console.log(stats.toString({ all: false, timings: true, assets: true }));
    done();
  });
});
const bundle = resolve(root, "dist/breeze-plugin-bika-classic.bundle.cjs");
const { default: plugin } = require(bundle);
const info = await plugin.getInfo();
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (pkg.version !== info.version || info.uuid !== "97b8ebb1-9f1f-423c-9847-acd7b0ccd31f")
  throw new Error("Package/manifest identity mismatch");
const oldIds = ["e9f18928-3ba8-4d86-a12e-b53a62f47933", "0a0e5858-a467-4702-994a-79e608a4589d"];
const bytes = await readFile(bundle, "utf8");
if (oldIds.some((id) => bytes.includes(id)))
  throw new Error("Legacy source ID leaked into standalone bundle");
await writeFile(resolve(root, "manifest.json"), `${JSON.stringify(info, null, 2)}\n`);
console.log(`Validated local manifest: ${info.name} ${info.version} (${info.uuid})`);
