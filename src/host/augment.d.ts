import type { ModelSelection } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(...args: any[]): any
}

import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    logger?: {
      info?: (...args: any[]) => void
      warn?: (...args: any[]) => void
      error?: (...args: any[]) => void
    }
    tools: { register: any; preExecute?: any }
    agents: any
    sessions: any
    skills: any
    /** DSH default-model service (injected by the host; structural shape only). */
    agentDefaultModel: {
      currentSelection(): ModelSelection
    }
    sessionTitle: { rename(session: unknown, title: string): Promise<unknown> | unknown }
    /** Current agent identity inside an agent-scoped context (WeakMap key). */
    agent?: object
  }
}
