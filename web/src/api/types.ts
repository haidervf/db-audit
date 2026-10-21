/**
 * API types used by the UI. Everything comes from the shared contract (`shared/types.ts`) and the analyzer
 * contract (`server/analyze/tsql/types.ts`); imports are type-only so nothing from the server is bundled.
 *
 * The "view" types below widen a few fields to `| undefined` so the UI degrades gracefully against a server
 * that does not (yet) send them (no analysis, no AI, no uses/usedBy).
 */
import type * as S from '../../../shared/types';

export type {
  AuthMode,
  JobsSource,
  JobSourceKind,
  DbEndpoint,
  ConnectionInput,
  ConnectionProfile,
  EndpointCheck,
  ConnectionTestResult,
  ObjectKind,
  ObjectSummary,
  Dependency,
  DependencyRef,
  ParameterInfo,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  CheckConstraintInfo,
  TableDetails,
  ProcedureDetails,
  ViewDetails,
  FunctionDetails,
  TriggerDetails,
  ModuleSettings,
  DefinitionStatus,
  TargetMember,
  JobExecution,
  JobSummary,
  RefreshRequest,
  RefreshRun,
  RunWarning,
  WarningObjectRef,
  SegmentCounts,
  GraphNode,
  GraphEdge,
  GraphNodeKind,
  Graph,
  ConnectionSummary,
  ApiError,
  InsightCategoryId,
  InsightSeverity,
  InsightItem,
  Insight,
  InsightCategory,
  InsightsReport,
  AiInsightFinding,
  AiInsightsContent,
  AiInsightsAnalysis,
} from '../../../shared/types';

export type {
  ModuleAnalysis,
  ObjectRef,
  TableAccess,
  TableOp,
  ProcCall,
  OutlineNode,
  StatementKind,
  DynamicSql,
} from '../../../server/analyze/tsql/types';

export type {
  Segment,
  ResolvedRef,
  AnalysisPayload,
  AnalysisFlags,
  UsageEdge,
  AiDescriptionContent,
  AiDescription,
  AiEffort,
  AiStatus,
  AiSettingsInput,
} from './pending';

import type { AiDescription, AnalysisFlags, AnalysisPayload, UsageEdge } from './pending';

export interface JobUsing {
  jobId?: string;
  jobName: string;
  stepId: number;
  source?: S.JobSourceKind;
  via?: 'analysis' | 'text-match';
}

export type ObjectSummaryView = Omit<S.ObjectSummary, 'analysisFlags'> & { analysisFlags?: AnalysisFlags | null };

export type ObjectDetailView = Omit<S.ObjectDetail, 'analysis' | 'ai' | 'jobsUsing' | 'uses' | 'usedBy' | 'analysisFlags'> & {
  analysis: AnalysisPayload | null;
  ai: AiDescription | null;
  analysisFlags?: AnalysisFlags | null;
  uses?: UsageEdge[];
  usedBy?: UsageEdge[];
  jobsUsing: JobUsing[];
};

export type JobStepView = Omit<S.JobStep, 'analysis'> & { analysis: AnalysisPayload | null };

export type JobDetailView = Omit<S.JobDetail, 'steps' | 'ai'> & { steps: JobStepView[]; ai: AiDescription | null };
