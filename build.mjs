import { build, context } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TARGETS = ["chrome-mv3", "edge-mv3"];
const MANIFEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0UQVcbdZ9smVA7BoQKeDs0vdzwfoLycNboE8fCZsT92YkkA/rXX8IEXQhT9DgUbxSWLgWWoF1Fs2/BJ0TbTZLn71l5pyNyjP/liOVMCWDdnmom396G5yyqd9LAMuPbDNGClLDDY0uS9lQZm0PA1pvfX0celVSspcQz6poHZgrTcsUabHDFbbt1BxGF3jTbpRQpDsKnxFJ+26jthXz1sVWF1U5srLbHrYiet+XvkketP7QCw+mtAesuoTUBPcDTbqayK4VDtWHcIOFbFANcG2uJho7hkCcDMd18/8C0ofrPhl+BiOjdGssxD4E/BjdG5Sdk7GOQY/iz+2rhoFS/iCGwIDAQAB";

function manifest() {
  return {
    manifest_version: 3,
    name: "BrowserUse",
    description: "A Browser Bridge for MCP Clients",
    version: '1.1.4',
    author: "Yis_Rime (https://github.com/YisRime)",
    homepage_url: "https://github.com/YisRime/BrowserUse",
    key: MANIFEST_KEY,
    minimum_chrome_version: "120",
    permissions: ["tabs", "debugger", "storage", "alarms", "management", "downloads"],
    background: { service_worker: "background.js", type: "module" },
    action: {},
  };
}

const BUILD = {
  entryPoints: [join(ROOT, "src", "background.ts")],
  bundle: true,
  format: "esm",
  target: "chrome120",
  legalComments: "none",
};

async function emit(target) {
  const outDir = join(ROOT, ".output", target);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await build({ ...BUILD, outfile: join(outDir, "background.js") });
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest(), null, 2)}\n`);
  return outDir;
}

if (process.argv.includes("--watch")) {
  const ctx = await context({ ...BUILD, outfile: join(ROOT, ".output", TARGETS[0], "background.js") });
  await ctx.watch();
}

for (const target of TARGETS) await emit(target);
