/**
 * 调试构建配置：关闭压缩与混淆，便于定位运行期异常堆栈。
 */
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@assets': fileURLToPath(new URL('../assets', import.meta.url))
    }
  },
  build: { minify: false, outDir: 'dist-debug', sourcemap: false }
});
