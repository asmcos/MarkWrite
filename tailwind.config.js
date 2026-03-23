/** @type {import('tailwindcss').Config} */
module.exports = {
  // Tailwind v4 采用 content 扫描来生成需要的工具类
  content: [
    './index.html',
    './settings-modal.html',
    './renderer.js',
    './main.js',
    './preload.js',
    './styles.css',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

