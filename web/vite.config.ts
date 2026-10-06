/**
 * @File : web/vite.config.ts
 * @Time : 2026-10-05 03:20
 * @Author : Cetrp
 * @Description : Vite 配置：规格资产目录别名、离线单文件构建模式与开发服务器。
 */

import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 生成配置。
 *
 * @param {{ mode: string }} environment Vite 环境。
 * @returns {import('vite').UserConfig} Vite 配置。
 */
export default defineConfig(({ mode }) => {
  const is_single_file = mode === 'singlefile';
  const api_origin = process.env.VITE_SIMLAB_API_ORIGIN || 'http://127.0.0.1:8000';
  const novnc_origin = process.env.VITE_SIMLAB_NOVNC_ORIGIN || 'http://127.0.0.1:6080';
  return {
    base: './',
    plugins: [react(), ...(is_single_file ? [viteSingleFile({ removeViteModuleLoader: true })] : [])],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@assets': fileURLToPath(new URL('../assets', import.meta.url))
      }
    },
    build: {
      outDir: is_single_file ? 'dist-single' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      chunkSizeWarningLimit: 4096,
      assetsInlineLimit: is_single_file ? 100000000 : 4096,
      cssCodeSplit: !is_single_file,
      rollupOptions: is_single_file ? { output: { inlineDynamicImports: true } } : {}
    },
    server: {
      host: '0.0.0.0',
      port: 5181,
      strictPort: true,
      proxy: {
        '/api': {
          target: api_origin,
          changeOrigin: true,
          xfwd: true
        },
        '/ws': {
          target: api_origin.replace(/^http/, 'ws'),
          ws: true,
          changeOrigin: true
        },
        '/g0-novnc': {
          target: novnc_origin,
          ws: true,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/g0-novnc/, '') || '/'
        },
        '/novnc': {
          target: novnc_origin,
          ws: true,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/novnc/, '') || '/'
        }
      }
    }
  };
});
