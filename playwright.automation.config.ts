import baseConfig from "./playwright.config";

/**
 * Task 10 专用配置：完全复用正式配置，只覆盖 webServer 命令。
 *
 * 原因：正式配置的 webServer 会先执行 `npm run build:all`，而根 `tsc` 目前被用户未提交的
 * `tests/e2e/tutorial-video.spec.ts`（缺 DOM 全局）阻断。按要求不修改该文件或根 tsconfig，
 * 因此这里改用“只构建前端 + 直接启动 e2e server”的命令；其余设置全部继承正式配置。
 *
 * 不新增 Playwright 基础设施，仅覆盖一行命令。
 */
export default {
  ...baseConfig,
  webServer: {
    command: "npm run frontend:build && npm run e2e:server",
    url: "http://127.0.0.1:4722/api/health",
    reuseExistingServer: false,
    timeout: 180_000
  }
};
