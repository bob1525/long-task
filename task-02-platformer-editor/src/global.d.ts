import type { GameDebugApi } from './debug'

declare global {
  interface Window {
    __GAME__?: GameDebugApi
  }
}

export {}
