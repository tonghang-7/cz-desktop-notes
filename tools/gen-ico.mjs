import fs from 'node:fs';
import path from 'node:path';

const src = path.join(process.cwd(), 'assets', 'icon.png');
const out = path.join(process.cwd(), 'assets', 'icon.ico');

const png = fs.readFileSync(src);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

const entry = Buffer.alloc(16);
entry[0] = 0;
entry[1] = 0;
entry[2] = 0;
entry[3] = 0;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(6 + 16, 12);

fs.writeFileSync(out, Buffer.concat([header, entry, png]));
console.log(`wrote assets/icon.ico  (${png.length + 22} bytes, 256x256 png-in-ico)`);
