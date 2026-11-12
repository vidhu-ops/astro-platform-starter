import fs from "node:fs";
import path from "node:path";

const ranges = [
  [0x1f300, 0x1f5ff],
  [0x1f600, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa00, 0x1fa6f],
  [0x1fa70, 0x1faff],
  [0x2600, 0x26ff],
  [0x2700, 0x27bf],
  [0x2300, 0x23ff],
  [0x2b50, 0x2b55],
];

const out = new Set();
for (const [start, end] of ranges) {
  for (let cp = start; cp <= end; cp++) {
    try {
      const ch = String.fromCodePoint(cp);
      if (/\p{Extended_Pictographic}/u.test(ch)) out.add(ch);
    } catch {
      /* skip */
    }
  }
}
const extras =
  "❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💟☮️✝️☪️🕉️☸️✡️🔯🕎☯️☦️🛐⛎♈♉♊♋♌♍♎♏♐♑♒♓".split("");
for (const e of extras) out.add(e);

const list = [...out];
const target = path.join(process.cwd(), "public", "emoji-list.json");
fs.writeFileSync(target, JSON.stringify(list));
console.log("wrote", list.length, "emojis to", target);
