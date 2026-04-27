import typescript from "@rollup/plugin-typescript";

export default {
  input: "src/index.ts",
  output: [
    { file: "dist/luniq.js", format: "iife", name: "Luniq", sourcemap: true },
    { file: "dist/luniq.esm.js", format: "es", sourcemap: true },
  ],
  plugins: [typescript()],
};
