import { defineConfig } from "@caido-community/dev";
import tailwindCaido from "@caido/tailwindcss";
import vue from "@vitejs/plugin-vue";
import path from "path";
import prefixwrap from "postcss-prefixwrap";
import tailwindcss from "tailwindcss";
import tailwindPrimeui from "tailwindcss-primeui";

const id = "graphx";
export default defineConfig({
  id,
  name: "GraphX",
  description: "Interactive relationship graphs for Caido project scope data",
  version: "0.3.0",
  author: {
    name: "Karan Shergill",
  },
  plugins: [
    {
      kind: "backend",
      id: "backend",
      root: "packages/backend",
    },
    {
      kind: "frontend",
      id: "frontend",
      root: "packages/frontend",
      backend: {
        id: "backend",
      },
      vite: {
        plugins: [
          vue({
            features: {
              propsDestructure: true,
            },
          }),
        ],
        build: {
          rollupOptions: {
            external: [
              "@caido/frontend-sdk",
              "@codemirror/autocomplete",
              "@codemirror/commands",
              "@codemirror/language",
              "@codemirror/lint",
              "@codemirror/search",
              "@codemirror/state",
              "@codemirror/view",
              "@lezer/common",
              "@lezer/highlight",
              "@lezer/lr",
              "vue",
            ],
          },
        },
        resolve: {
          alias: [
            {
              find: "@",
              replacement: path.resolve(__dirname, "packages/frontend/src"),
            },
          ],
        },
        css: {
          postcss: {
            plugins: [
              prefixwrap(`#plugin--${id}`),
              tailwindcss({
                corePlugins: {
                  preflight: false,
                },
                content: [
                  "./packages/frontend/src/**/*.{vue,ts}",
                  "./node_modules/@caido/primevue/dist/primevue.mjs",
                ],
                darkMode: ["selector", '[data-mode="dark"]'],
                plugins: [tailwindPrimeui, tailwindCaido],
              }),
            ],
          },
        },
      },
    },
  ],
});
