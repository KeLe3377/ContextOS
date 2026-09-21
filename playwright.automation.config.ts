import baseConfig from "./playwright.config";

/**
 * 自动化验收专用配置：完全复用正式配置，只覆盖 webServer 命令。
 *
 * 正式配置的 webServer 会先跑 `npm run build:all`（含后端 tsc）。后端类型检查已在门禁里
 * 单独跑过，这里只需构建前端并直接启动 e2e server，避免每次 E2E 重复整仓构建；
 * 其余设置（projects、重试、trace）全部继承正式配置。不新增 Playwright 基础设施。
 */
export default {
  ...baseConfig,
  webServer: {
    command: "npm run frontend:build && npm run e2e:server",
    url: "http://127.0.0.1:4722/api/health",
    reuseExistingServer: false,
    timeout: 180_000,
    env: { ...process.env, CONTEXTOS_E2E_AUTOMATION_FIXTURE: "1" }
  }
};
