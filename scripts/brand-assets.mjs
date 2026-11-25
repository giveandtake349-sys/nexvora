// Regenerates binary brand assets (logo, app icon, favicon) from base64 text
// stored in assets/brand-assets.json. The GitHub snapshot push route only
// accepts UTF-8 text, so binary images cannot be committed directly — this
// script runs on `postinstall` (including on Vercel) so the files exist
// before `next build` reads them. Safe to re-run; outputs are byte-stable.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "assets", "brand-assets.json"), "utf8"));
for (const { path, base64 } of data.files) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(base64, "base64"));
  console.log(`brand-assets: wrote ${path}`);
}
