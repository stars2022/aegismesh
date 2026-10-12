import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.AIC_API_PROXY_TARGET || 'http://127.0.0.1:8000',
    },
  },
  build: {
    // 画布编辑器（tiptap + prosemirror）本身约 520KB，只在打开画布时懒加载，属于预期体积。
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // 第三方库单独成包：业务代码更新时浏览器仍可复用这些长期缓存的文件。
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor-editor', test: /node_modules[\\/](@tiptap|prosemirror-[^\\/]+|linkifyjs|marked|orderedmap|rope-sequence|w3c-keyname)[\\/]/ },
            { name: 'vendor-markdown', test: /node_modules[\\/](react-markdown|remark-[^\\/]+|rehype-[^\\/]+|micromark[^\\/]*|mdast-[^\\/]+|hast-[^\\/]+|unist-[^\\/]+|unified|vfile[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities[^\\/]*|devlop|bail|trough|is-plain-obj|ccount|escape-string-regexp|markdown-table|longest-streak|zwitch|trim-lines|html-url-attributes|estree-util-is-identifier-name|style-to-js|style-to-object|inline-style-parser)[\\/]/ },
          ],
        },
      },
    },
  },
})
