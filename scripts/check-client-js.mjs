import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const start = html.indexOf("<script>") + 8;
const end = html.lastIndexOf("</script>");
if (start < 8 || end < 0) {
  console.error("check-client-js: no inline script in public/index.html");
  process.exit(1);
}
const js = html.slice(start, end);
try {
  // eslint-disable-next-line no-new-func
  new Function(js);
} catch (err) {
  console.error("check-client-js: public/index.html script does not parse:", err.message);
  process.exit(1);
}
console.log("check-client-js: ok");