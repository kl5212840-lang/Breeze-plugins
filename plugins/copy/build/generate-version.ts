import { readFile, writeFile } from "node:fs/promises";

async function main() {
  const configPath = new URL("../src/config.ts", import.meta.url);
  const config = await readFile(configPath, "utf-8");
  const match = config.match(/PLUGIN_VERSION\s*=\s*"([^"]*)"/);
  if (!match) {
    throw new Error("PLUGIN_VERSION not found in src/config.ts");
  }
  const version = match[1];

  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  pkg.version = version;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  console.log(`[version] synced package.json <- src/config.ts -> ${version}`);
}

void main().catch((error) => {
  console.error("[version] generate failed:", error);
  process.exit(1);
});
