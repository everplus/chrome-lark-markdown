import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { copyFileSync, readFileSync, writeFileSync, cpSync, mkdirSync, existsSync } from 'fs'

const STATIC_DIRS = ['background', 'content', 'lib', 'icons']

function copyExtensionFiles() {
  return {
    name: 'copy-extension-files',
    closeBundle: {
      sequential: true,
      handler() {
        const outDir = resolve(__dirname, 'dist')
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

        // Generate build manifest.json
        const manifest = JSON.parse(readFileSync(resolve(__dirname, 'manifest.json'), 'utf-8'))
        manifest.action.default_popup = 'popup.html'
        writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

        for (const dir of STATIC_DIRS) {
          cpSync(resolve(__dirname, dir), resolve(outDir, dir), { recursive: true })
        }
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), copyExtensionFiles()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        preview: resolve(__dirname, 'preview.html'),
      },
    },
  },
})
