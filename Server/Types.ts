import type { Scope, Element } from '@lightbery/scope'

type RenderScope = Scope<undefined>
type ScriptScope = Scope<undefined>

type Page = (scope: RenderScope, args: any) => {
  title: string
  description: string
  keywords?: string
  content?: Element<RenderScope>
}

export type { RenderScope, ScriptScope, Page }
