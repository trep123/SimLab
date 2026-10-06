/**
 * @File : web/vitest.config.ts
 * @Time : 2026-10-05 12:20
 * @Author : Cetrp
 * @Description : Vitest 配置：沿用 Vite 别名，测试位于 web/tests。
 */

import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * 生成配置。
 *
 * @returns {import('vitest/config').UserConfig} 配置。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@assets': fileURLToPath(new URL('../assets', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /* 设备开机需要回放启动日志（约 4 秒/台），单测超时放宽到 30 秒。 */
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
