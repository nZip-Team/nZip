import type { Element } from '@lightbery/scope'

interface Page {
  (args: any): {
    title: string
    description: string
    keywords?: string
    content?: Element  
  }
}

export type { Page }
