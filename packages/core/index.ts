// @docent/core: Pairwatch's pure modules, straight from the submodule. Nothing here touches the
// Claude Code engine; these files also run inside the mod. Namespaced so that two modules exporting
// the same name can never clash.
export * as timeline from '../../vendor/pairwatch/pairwatch/hooks/core/timeline.ts'
export * as explain from '../../vendor/pairwatch/pairwatch/hooks/core/explain.ts'
export * as bash from '../../vendor/pairwatch/pairwatch/hooks/core/bash.ts'
export * as stage from '../../vendor/pairwatch/pairwatch/hooks/core/stage.ts'
export * as stations from '../../vendor/pairwatch/pairwatch/hooks/core/stations.ts'
export * as concepts from '../../vendor/pairwatch/pairwatch/hooks/core/concepts.ts'
export * as conceptIds from '../../vendor/pairwatch/pairwatch/hooks/core/concept-ids.ts'
export * as lessons from '../../vendor/pairwatch/pairwatch/hooks/core/lessons.ts'
export * as narrate from '../../vendor/pairwatch/pairwatch/hooks/core/narrate.ts'
export * as text from '../../vendor/pairwatch/pairwatch/hooks/core/text.ts'
export * as view from '../../vendor/pairwatch/pairwatch/hooks/core/view.ts'
export * as redact from '../../vendor/pairwatch/pairwatch/hooks/core/redact.ts'
export * as md from '../../vendor/pairwatch/pairwatch/hooks/core/md.ts'

export type {
  Activity,
  AgentLane,
  AskState,
  BashCategory,
  Concept,
  FileTouch,
  LessonState,
  Level,
  Narration,
  Prefs,
  RawEvent,
  SceneData,
  SessionModel,
  Station,
  Stats,
  Step,
  StepStatus,
  ToolEnd,
  ToolObs,
} from '../../vendor/pairwatch/pairwatch/types/index.d.ts'
