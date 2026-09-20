# 安装包重建与发版流水线（2026-09-20）

日期：2026-09-20
类型：问题修复 + 流程固化
状态：已完成

---

## 1. 摘要

用户问：“现在是有安装包作为发行，给别人用，测试。而源码应该也是修改后，可以跑的，对吗？”

实测结论是**一半对**：

- **源码路径 ✅** —— `npm run dev` 实测能起，两个 bug 修复都在线生效。
- **安装包路径 ❌** —— 当时 `inst/contextos-installer.exe` 比 HEAD 落后 **3 个提交**，其中两个是用户可见的真 bug。如果直接发出去，测试者会踩到。

已处理：重新构建产物、重新编译安装包、装后逐项核对通过。
已固化：把“重建 + 自检”做成脚本，避免下次再靠人记。

---

## 2. 源码路径：实测通过

```bash
npm run dev        # = tsx apps/daemon/src/main.ts，默认端口 4721
```

实测结果：

| 检查 | 结果 |
|---|---|
| `GET /api/health` | `{"version":"0.1.3","schemaVersion":11,"processState":"ready"}` |
| `GET /` | HTTP 200（前端静态资源正常） |
| `GET /api/workspace/overview` | `contextHealth: {"activeSources":1,"pausedSources":0,"evidenceSnapshots":8,...}` |
| `GET /api/sessions/:id/desktop-sync` | `status: "UNBOUND"`，`capabilities: {desktopReadSync:true, managedCliResume:false, desktopUiControl:false}` |

两个 bug 修复都确认在线生效：

- `79bc9a8`（概览 KPI 字段名）—— `activeSources` 有值了；
- `ece39b4`（Desktop 绑定回写 external id）—— Desktop 同步接口正常返回能力位。

---

## 3. 发现的问题：安装包落后 3 个提交

### 3.1 时间线

| 时间 | 事件 |
|---|---|
| 09-19 21:29:29 | `df93772` feat: Codex Desktop 只读同步（Level A） |
| **09-19 21:42** | **`inst/contextos-installer.exe` 生成** |
| 09-19 21:43:55 | `f69534d` fix: 启动脚本加固 + 卸载清理 + 版本 0.1.3 |
| 09-19 21:57:08 | `ece39b4` fix: 绑定后回写 external session id |
| 09-19 22:03:32 | `79bc9a8` fix: 恢复 ASCII 标识符与 contextHealth 字段名 |
| 09-19 22:12:33 | `c51f862` feat: 会话页自动轮询 Desktop 同步 |

即：安装包打进了 `df93772`，之后落的 `ece39b4` / `79bc9a8` / `c51f862` **全都不在包里**。
（包内 `dist/packages/application/src/core/desktop-sync-service.js` 的 mtime 是 09-19 21:31，与上面吻合。）

### 3.2 逐项核对（静默安装到临时目录后 grep 包内文件）

| 检查项 | 旧包 | 应有 | 影响 |
|---|---|---|---|
| `bindExternalSession`（`ece39b4`） | **0** ❌ | 2 | Desktop 同步绑定后点「在智能体中继续」**新起线程**，而不是 resume 同一 UUID |
| 前端 `active数据源`（坏标识符） | **2** ❌ | 0 | 概览页 KPI **全是空的** |
| 前端 `activeSources`（好，`79bc9a8`） | **0** ❌ | 2 | 同上 |
| 前端 `desktopSyncAuto`（`c51f862`） | **0** ❌ | 4 | 会话页没有自动同步开关 |

两个用户可见后果：

1. **概览页 KPI 全空**（活动数据源 / 暂停数据源 / 证据快照 / 过期上下文）
2. **Desktop 绑定后 continue 静默地开新线程** —— 这个不报错，很难被发现

### 3.3 根因

`dist/`、`frontend/dist/`、`inst/` 三项都在 `.gitignore` 里、**不进版本库**。所以安装包和当前 HEAD 是否一致，没有任何机制保证，全靠人记。

---

## 4. 处理

### 4.1 重建

```bash
mv frontend/dist .workbuddy-ai/tmp/frontend-dist-old   # 必须，否则 vite emptyOutDir 被批量删除保护拦截
npm run build:all                                       # tsc + vite build，19s 无错
mv inst/contextos-installer.exe .workbuddy-ai/tmp/...   # 备份旧包
"/c/Program Files (x86)/Inno Setup 6/ISCC.exe" contextos.iss
```

| 项 | 旧 | 新 |
|---|---|---|
| 安装包 | 2,297,973 字节（09-19 21:42） | **2,298,490 字节（09-20 09:28）** |
| 前端 bundle | `index-Ly8neiTc.js` | `index-XmfbnN2S.js` |

旧包备份在 `.workbuddy-ai/tmp/installer-stale-0.1.3-pre3fixes.exe`。

### 4.2 验证

1. 新包静默装到**另一个**临时目录 → 上表 4 项全部通过；
2. 用**打包后的编译产物**直接启动（`node dist/apps/daemon/src/main.js`，独立数据目录 + 4722 端口）→ `/api/health` 返回 `version 0.1.3` / `schemaVersion 11` / `ready`。

---

## 5. 固化：发版脚本

| 文件 | 作用 |
|---|---|
| `scripts/verify-install.mjs` | 自检逻辑的**唯一实现**（node）。9 项检查，退出码 0/1/2 |
| `scripts/release-build.ps1` | 编排：前置检查 → `npm run build:all` → ISCC → 静默安装 → 调 mjs 自检（UTF-8 **带 BOM**） |
| `scripts/release-build.cmd` | 双击入口（`chcp 65001`） |

用法：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-build.ps1
# 或双击 scripts\release-build.cmd
```

只自检、不重建：

```bash
node scripts/verify-install.mjs <安装目录>
node scripts/verify-install.mjs --installer inst/contextos-installer.exe
```

自检的 9 项：Desktop 绑定回写 external id、后端 contextHealth 字段名、前端无乱码标识符 `active数据源`、前端 `activeSources`、前端 `desktopSyncAuto`、启动脚本 `Test-NodeCommand`、迁移文件 ≥ 11、前端入口存在、daemon 入口存在。

### 5.1 自检脚本做过正反向测试

**反向**（拿旧包装出来的目录）：

```
[FAIL] Desktop 绑定回写 external id
[FAIL] 前端无乱码标识符 active数据源
[FAIL] 前端使用 activeSources
[FAIL] Desktop 同步自动轮询
自检未通过：4/9 项失败。不要分发这个安装包。   退出码=1
```

**正向**（新包，`--installer` 完整流程）：**9/9 通过**，退出码 0，自动卸载并清理临时目录。

两条一起说明脚本不是“永远返回 OK”的摆设。

### 5.2 已知限制

`.ps1` 只做了**语法解析校验**（`Parser::ParseFile` → PARSE OK），**未在本环境实跑** —— 当前沙箱的 PowerShell 工具无法执行外部程序（node/npm/ISCC/安装包），且从 bash 调 `powershell` 会被安全策略拒绝。需用户在正常 PowerShell 里跑一次确认。

---

## 6. 本次改动清单

**新增**

- `docs/2026-09-20-codex-appserver-readonly-sync-plan.md` —— app-server 只读同步改造设计（现状 + L0/L1/L2 三档方案 + 风险 + 验证计划）
- `docs/2026-09-20-installer-rebuild-and-release-pipeline.md` —— 本文档
- `scripts/verify-install.mjs`
- `scripts/release-build.ps1`
- `scripts/release-build.cmd`

**修改**

- `README.md` —— 「Windows 安装包」章节改为“发版请用脚本”，并写明 `dist/` 不进版本库导致的坑

**未纳入版本库（按设计如此）**

- `inst/contextos-installer.exe` —— `inst/` 在 `.gitignore` 中
- `dist/`、`frontend/dist/` —— 编译产物，`.gitignore` 中
- `.workbuddy-ai/tmp/` 下的临时安装目录、旧包备份、陈旧锁 —— `.workbuddy-ai/` 在 `.gitignore` 中

**未提交（非本次改动，工具自动生成）**

- `.codegraph/`（8 MB 索引库）、`AGENTS.md`、`CLAUDE.md` —— 由产品自身生成，不属于本次改动范围

---

## 7. 发版操作手册（以后照这个来）

```powershell
# 1. 确认工作区干净、HEAD 是想要的版本
git status
git log --oneline -3

# 2. 一键重建 + 自检
powershell -ExecutionPolicy Bypass -File scripts\release-build.ps1

# 3. 看到「自检通过。安装包可以分发。」再发出去
```

任何一项自检失败 → 脚本非 0 退出，**不要分发**。

手工等价命令：

```powershell
npm run build:all
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" contextos.iss
node scripts\verify-install.mjs --installer inst\contextos-installer.exe
```

---

## 8. 提交前的测试情况

```
Test Files  1 failed | 21 passed (22)
     Tests  1 failed | 108 passed (109)
```

失败项：`transcript-import-api.test.ts > imports transcript evidence into a completed session and preserves capsule history`，错误是 `Session did not reach COMPLETED`。

**与本次改动无关**（本次没碰任何源码）。单独重跑该文件 8/8 通过、耗时 1.6s：

```bash
node ./node_modules/vitest/vitest.mjs run tests/integration/transcript-import-api.test.ts
# ✓ 8 passed (8)
```

成因：`waitForSessionStatus` 以 25 ms 轮询等待状态，在 22 个文件并行跑、CPU 被占满时会超时。属于**已知的不稳定测试**，未在本轮处理。

## 9. 待办

- [ ] 用户在正常 PowerShell 里实跑一次 `scripts/release-build.cmd`，确认脚本端到端可用
- [ ] 真机/虚拟机全新环境验证（无 Node、无网络的机器）—— 一直未覆盖
- [ ] 唯一未验证项：启动脚本最后一步“执行 node”在本沙箱无法验证，用户应双击桌面快捷方式确认一次
- [ ] 修掉 `transcript-import-api.test.ts` 的 flaky：把 25 ms 固定轮询改成带上限的条件等待（或提高超时），避免 CI 上偶发红
