/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  // CLI 卡片的 gradient class 来自后端 cli-manifest.js（动态绑定），Tailwind 静态扫描看不到。
  // 这里列出所有 manifest 用到的 + 1Shell 引擎卡 + 默认 fallback。
  safelist: [
    'from-orange-400', 'to-pink-500',
    'from-slate-700', 'to-slate-900',
    'from-emerald-400', 'to-teal-500',
    'from-slate-400', 'to-slate-500',
    'from-blue-500', 'to-purple-500',
    'from-cyan-500', 'to-blue-500',
  ],
  theme: {
    extend: {
      colors: {
        shell: {
          outer: '#334155',
          'outer-dark': '#0b0e18',
          panel: '#f8fafc',
          'panel-dark': '#111827',
          term: '#F5F2E9',
          'term-dark': '#0d1117',
          accent: '#4f8cff',
          'accent-soft': 'rgba(79,140,255,0.12)',
          purple: '#7c3aed',
          success: '#059669',
          warn: '#d97706',
          danger: '#dc2626',
        },
      },
      fontFamily: {
        mono: ['"Cascadia Code"', '"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
