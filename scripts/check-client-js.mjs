import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let n = 0;
while ((match = re.exec(html))) {
  const js = match[1].trim();
  if (!js) continue;
  n++;
  try {
    // eslint-disable-next-line no-new-func
    new Function(js);
  } catch (err) {
    console.error(`check-client-js: script block ${n} does not parse: ${err.message}`);
    process.exit(1);
  }
}
if (!n) {
  console.error("check-client-js: no inline scripts in public/index.html");
  process.exit(1);
}
console.log(`check-client-js: ok (${n} block${n === 1 ? "" : "s"})`);