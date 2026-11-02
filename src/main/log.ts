import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 主进程的失败出口。
 *
 * 打包版没有控制台，`console.error` 等于扔进黑洞 —— 用户那边只表现成「窗口突然没了」
 * 或者「点了没反应」，而事后一点现场都捞不到。所以真正的错误必须落到
 * `userData/logs/main.log`，排查时直接读文件。
 *
 * 这个模块自身绝不抛错：记日志把主流程搞挂，是最蠢的一种失败方式。
 */

/** 超过就轮转成 .1，只留上一份 —— 常驻应用跑几个月也不该把磁盘写满。 */
const MAX_BYTES = 512 * 1024;

let cached: string | null = null;

function logFile(): string | null {
  if (cached) return cached;
  try {
    cached = path.join(app.getPath('userData'), 'logs', 'main.log');
  } catch {
    return null;
  }
  return cached;
}

function describe(v: unknown): string {
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v); // 循环引用之类
  }
}

export function logError(label: string, err: unknown) {
  const line = `[${new Date().toISOString()}] ${label}: ${describe(err)}\n`;
  console.error(line.trimEnd());

  const file = logFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size >= MAX_BYTES) {
      fs.renameSync(file, file + '.1');
    }
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    /* 写不进去也不能把调用方带死 */
  }
}

/** 给对话框显示用；拿不到路径时返回 null。 */
export function getLogFile() {
  return logFile();
}
