import type { DocentApi } from '../shared/ipc'

declare global {
  interface Window {
    docent: DocentApi
  }
}

export {}
