/// <reference types="vite/client" />

declare module '*.scm?raw' {
  const source: string;
  export default source;
}
