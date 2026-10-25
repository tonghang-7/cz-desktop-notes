import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const env = { ...process.env };
// 部分编辑器/终端会预设 ELECTRON_RUN_AS_NODE，那样 Electron 会以 Node 模式跑起来，
// 不创建窗口。启动前清掉它。
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
