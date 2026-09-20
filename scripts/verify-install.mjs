#!/usr/bin/env node
/**
 * ContextOS 安装包内容自检
 *
 * 用法：
 *   node scripts/verify-install.mjs <安装目录>
 *   node scripts/verify-install.mjs --installer <exe> [--dir <临时目录>]
 *
 * 为什么要这个：
 * dist/ 与 frontend/dist/ 都被 .gitignore 排除，inst/*.exe 是否与当前 HEAD
 * 一致完全靠人记。曾经发生过安装包比 HEAD 落后 3 个提交、把两个用户可见的
 * 真 bug 一起发出去的情况。装完 grep 一遍关键标记，比记性好。
 *
 * 退出码：0 = 全部通过；1 = 有失败项；2 = 用法/运行错误。
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const out = { installer: null, dir: null, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--installer") { out.installer = argv[++i]; }
    else if (a === "--dir") { out.dir = argv[++i]; }
    else if (a === "--help" || a === "-h") { out.help = true; }
    else out.positional.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("用法: node scripts/verify-install.mjs <安装目录>");
  console.log("      node scripts/verify-install.mjs --installer <exe> [--dir <临时目录>]");
  process.exit(0);
}

function readTextUtf8(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function readJsBundle(dir) {
  const assets = join(dir, "frontend", "dist", "assets");
  if (!existsSync(assets)) return "";
  return readdirSync(assets)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readTextUtf8(join(assets, name)) ?? "")
    .join("\n");
}

function buildChecks(dir) {
  const bundle = readJsBundle(dir);
  const has = (relPath, needle) => {
    const text = readTextUtf8(join(dir, ...relPath.split("/")));
    return text !== null && text.includes(needle);
  };

  const migDir = join(dir, "migrations");
  const migCount = existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith(".sql")).length : 0;

  return [
    {
      name: "Desktop 绑定回写 external id",
      pass: has("dist/packages/application/src/core/desktop-sync-service.js", "bindExternalSession"),
      detail: "缺失时 continue 会新起线程，而不是 resume 同一 UUID"
    },
    {
      name: "后端 contextHealth 字段名",
      pass: has("dist/apps/daemon/src/http/routes/workspace.js", "activeSources"),
      detail: "概览 KPI 依赖这个字段"
    },
    {
      name: "前端无乱码标识符 active数据源",
      pass: !bundle.includes("active数据源"),
      detail: "存在时概览 KPI 会是空的"
    },
    {
      name: "前端使用 activeSources",
      pass: bundle.includes("activeSources"),
      detail: "概览 KPI 能读到值"
    },
    {
      name: "Desktop 同步自动轮询",
      pass: bundle.includes("desktopSyncAuto"),
      detail: "会话页自动同步开关"
    },
    {
      name: "启动脚本加固 Test-NodeCommand",
      pass: has("scripts/start-contextos.ps1", "Test-NodeCommand"),
      detail: "缺失时 node 有问题会给出空错误信息"
    },
    {
      name: `数据库迁移文件齐全 (期望 >= 11，实际 ${migCount})`,
      pass: migCount >= 11,
      detail: "迁移缺失会导致启动即失败"
    },
    {
      name: "前端入口存在",
      pass: existsSync(join(dir, "frontend", "dist", "index.html")),
      detail: "缺失时打开是 404"
    },
    {
      name: "daemon 入口存在",
      pass: existsSync(join(dir, "dist", "apps", "daemon", "src", "main.js")),
      detail: "编译产物没打进包"
    },
    {
      name: "app-server 线程发现客户端",
      pass: has("dist/packages/infrastructure/src/adapters/codex-app-server-client.js", "thread/list")
         && has("dist/packages/infrastructure/src/adapters/codex-adapter.js", "listExternalSessions"),
      detail: "缺失时 Desktop 同步拿不到候选线程列表"
    },
    {
      name: "候选线程查询路由",
      pass: has("dist/apps/daemon/src/http/routes/core-resources.js", "desktop-sync/candidates"),
      detail: "缺失时前端绑定弹窗是空的（会退回手工填 UUID）"
    }
  ];
}

function fail(message) {
  console.error(`错误: ${message}`);
  process.exit(2);
}

let targetDir = args.positional[0] ?? null;
let cleanupNote = null;

if (args.installer) {
  const installer = resolve(args.installer);
  if (!existsSync(installer)) fail(`找不到安装包: ${installer}`);
  targetDir = resolve(args.dir ?? ".workbuddy-ai/tmp/release-verify");
  mkdirSync(targetDir, { recursive: true });

  const logFile = resolve(".workbuddy-ai/tmp/release-verify.log");
  const result = spawnSync(
    installer,
    ["/VERYSILENT", `/DIR=${targetDir}`, "/NOICONS", "/SUPPRESSMSGBOXES", `/LOG=${logFile}`],
    { stdio: "ignore", shell: false }
  );
  if (result.error) fail(`无法执行安装包: ${result.error.message}`);
  if (result.status !== 0) fail(`静默安装失败 (exit=${result.status})，日志: ${logFile}`);
  console.log(`已静默安装到: ${targetDir}`);

  const unins = join(targetDir, "unins000.exe");
  cleanupNote = unins;
}

if (!targetDir) fail("缺少安装目录。用法: node scripts/verify-install.mjs <安装目录>");
targetDir = resolve(targetDir);
if (!existsSync(targetDir)) fail(`安装目录不存在: ${targetDir}`);

console.log(`\n自检目标: ${targetDir}\n`);

const checks = buildChecks(targetDir);
let failed = 0;
for (const check of checks) {
  if (check.pass) {
    console.log(`  [OK]   ${check.name}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${check.name}  --  ${check.detail}`);
  }
}

if (cleanupNote) {
  const uninsResult = spawnSync(cleanupNote, ["/VERYSILENT", "/SUPPRESSMSGBOXES"], { stdio: "ignore", shell: false });
  if (uninsResult.status !== 0) {
    console.log(`\n提示: 卸载程序退出码 ${uninsResult.status}，临时目录可能残留: ${targetDir}`);
  } else {
    try { rmSync(targetDir, { recursive: true, force: true }); } catch { /* 留着也无妨 */ }
  }
}

console.log("");
if (failed > 0) {
  console.log(`自检未通过：${failed}/${checks.length} 项失败。不要分发这个安装包。`);
  process.exit(1);
}
console.log(`自检全部通过 (${checks.length}/${checks.length})。安装包可以分发。`);
process.exit(0);
