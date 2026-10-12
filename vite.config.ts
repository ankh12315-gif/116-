import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

export default defineConfig({
  plugins: [react(),{name:'local-sensor-api',configureServer(server){
    const api=require(path.resolve('server/api.cjs')).createApi(path.resolve('public'),path.resolve('docs/v11/runtime-events'));
    server.middlewares.use((req,res,next)=>{void api(req,res).then((handled:boolean)=>{if(!handled)next();}).catch(next);});
  }}],
  // 使用相对基路径，适配任意部署目录（docs/06 §E）
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1600,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'src/__tests__/**/*.test.ts',
      'src/__tests__/**/*.test.tsx',
    ],
    // 纯逻辑测试跑 node 环境：jsdom 需要写临时目录，沙箱/只读环境下会 EPERM
    environmentMatchGlobs: [['src/__tests__/coords.test.ts', 'node']],
  },
});
