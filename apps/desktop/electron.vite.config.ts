import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// VS Code 的扩展宿主会给子进程注入 ELECTRON_RUN_AS_NODE=1，该变量会被透传给
// electron.exe，让它在纯 Node 模式下运行：主进程里 require('electron') 只返回可执行
// 文件路径，启动即报 "Cannot read properties of undefined (reading
// 'registerSchemesAsPrivileged')"。这里清掉，保证从任意终端 pnpm dev 都能起来。
delete process.env.ELECTRON_RUN_AS_NODE

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'database-worker': resolve('src/main/storage/worker.ts')
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: { plugins: [react()] }
})
