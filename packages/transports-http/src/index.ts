import { CrocoApp, createApp } from "./libs/CrocoApp";
import { ErrorHandler } from "./libs/ErrorHandler";
import { HealthCheckRegistry } from "./libs/HealthCheckRegistry";
import { HttpExecutionContext } from "./libs/HttpExecutionContext";
import { ParamResolver } from "./libs/ParamResolver";
import { PipelineRunner, describeHttpPipelineGraph } from "./libs/PipelineRunner";
import { RouteCompiler } from "./libs/RouteCompiler";

/**
 * Hono 앱을 AWS Lambda 핸들러로 변환하는 어댑터 함수입니다.
 */
export { toLambdaHandler } from "./libs/adapters/LambdaAdapter";

/**
 * Hono 앱을 Node.js HTTP 서버로 실행하는 부트스트랩 함수입니다.
 */
export { startServer } from "./libs/adapters/NodeAdapter";

export type {
  AppConfig,
  BootstrapValidationPolicy,
  CompiledRoute,
  CompiledRoutePipelineGraphConfig,
  CrocoHttpContext,
  CrocoRequest,
  CrocoResponse,
  FilterProvider,
  GuardProvider,
  InterceptorProvider,
  LambdaContext,
  LambdaEvent,
  LambdaEventWithAuthorizer,
  LambdaHandler,
  LambdaRequestContext,
  LambdaRequestContextWithAuthorizer,
  LambdaResponse,
  ListenOptions,
  NodeRequestHandler,
  MiddlewareFunction,
  NodeServerHandle,
  PipeProvider,
} from "./libs/types";

/**
 * HTTP 애플리케이션 구성과 라우트 실행에 사용하는 핵심 공개 API입니다.
 */
export {
  CrocoApp,
  createApp,
  ErrorHandler,
  HealthCheckRegistry,
  HttpExecutionContext,
  ParamResolver,
  PipelineRunner,
  RouteCompiler,
  describeHttpPipelineGraph,
};

/**
 * Lambda 런타임 이벤트와 컨텍스트를 읽는 유틸리티, 타입, 그리고 Hono 앱을 Lambda 핸들러로 변환하는 어댑터 클래스입니다.
 */
export {
  CrocoLambdaAdapter,
  getLambdaContext,
  getLambdaEvent,
  type LambdaExecutionContext,
  type LambdaExecutionEnv,
  type LambdaHandlerOptions,
  type TypedLambdaHandler,
} from "./libs/CrocoLambdaAdapter";

export { getRuntimeContextInitFromEnv } from "./libs/runtimeContext";
export type { RuntimeContextInit } from "./libs/runtimeContext";

export type {
  HealthCheckFunction,
  HealthCheckOptions,
  HealthCheckResult,
  HealthCheckRegistryResult,
  HealthCheckStatus,
} from "./libs/HealthCheckRegistry";

export {
  DIAGNOSTICS_ENDPOINT_PATH,
  DIAGNOSTICS_TOKEN_HEADER,
  METRICS_ENDPOINT_PATH,
  OPERATIONAL_ENDPOINT_PATHS,
  STANDARD_DIAGNOSTICS_ENDPOINT_PATH,
} from "./libs/operationalEndpoints";

export {
  DEV_INSPECTOR_ENDPOINT_PATH,
  DEV_INSPECTOR_TOKEN_HEADER,
  authorizeDevInspectorRequest,
  resolveDevInspector,
  resolveDevInspectorEndpointPolicy,
} from "./libs/devInspectorEndpoint";

export type {
  DiagnosticsAccessContext,
  DiagnosticsEndpointOptions,
  DiagnosticsExposureMode,
  DiagnosticsGuard,
  OperationalLivenessResponse,
  OperationalMetricsResponse,
  SafeDiagnosticsErrorRecord,
  SafeDiagnosticsReport,
} from "./libs/operationalEndpoints";

export {
  DiagnosticsConfigurationProblem,
  type DiagnosticsConfigurationProblemOptions,
  type DiagnosticsLimitOption,
} from "./libs/problems/DiagnosticsEndpointProblems";

export type {
  DevInspectorEndpointOptions,
  DevInspectorEndpointPolicy,
  DevInspectorExposureMode,
} from "./libs/devInspectorEndpoint";

/**
 * 요청 본문 크기를 제한하는 미들웨어와 바이트 단위 헬퍼입니다.
 */
export {
  type BodyLimitOptions,
  bodyLimitMiddleware,
  kb,
  mb,
} from "./libs/middleware/BodyLimitMiddleware";

export {
  HttpBodyLimitConfigurationProblem,
  HttpRequestBodyReadProblem,
  HttpRequestBodyTooLargeProblem,
  HttpRequestBodyUnavailableProblem,
  type HttpRequestBodyTooLargeProblemOptions,
} from "./libs/problems/HttpRequestBodyProblems";

/**
 * 응답 압축을 적용하는 미들웨어와 관련 타입입니다.
 */
export {
  type CompressionEncoding,
  type CompressionOptions,
  compressionMiddleware,
} from "./libs/middleware/CompressionMiddleware";

/**
 * CORS 응답 헤더를 설정하는 미들웨어입니다.
 */
export { type CorsOptions, corsMiddleware } from "./libs/middleware/CorsMiddleware";

/**
 * 명시적인 HTTP 미들웨어 short-circuit marker입니다.
 */
export {
  isMiddlewareShortCircuit,
  shortCircuit,
  type MiddlewareShortCircuit,
} from "./libs/middleware/MiddlewareShortCircuit";

/**
 * 명시적인 HTTP 미들웨어 short-circuit 사유 문자열입니다.
 */
export type { MiddlewareShortCircuitReason } from "./libs/middleware/MiddlewareShortCircuit";

/**
 * graceful shutdown 상태를 관리하는 미들웨어와 제어 함수입니다.
 */
export {
  createGracefulShutdownController,
  type GracefulShutdownController,
  type GracefulShutdownOptions,
  gracefulShutdownMiddleware,
  isShuttingDown,
  resetShutdownState,
  setupGracefulShutdown,
} from "./libs/middleware/GracefulShutdownMiddleware";

export {
  GracefulShutdownConfigurationProblem,
  type GracefulShutdownConfigurationProblemOptions,
  type GracefulShutdownPhase,
  type GracefulShutdownTimeoutOption,
  GracefulShutdownTimeoutProblem,
  type GracefulShutdownTimeoutProblemOptions,
} from "./libs/problems/GracefulShutdownProblems";

/**
 * HTTP 요청에 레이트 리밋 정책을 적용하는 미들웨어 팩토리입니다.
 */
export {
  createRuntimeAwareRateLimitClientIdentityPolicy,
  createRateLimitMiddlewareFactory,
  type RateLimitClientIdentityPolicy,
  type RateLimitHttpOptions,
  type RateLimitMiddlewareFactoryOptions,
  rateLimitHttpMiddleware,
  type TrustedRateLimitProxyHeader,
} from "./libs/middleware/RateLimitMiddleware";

/**
 * 보안 헤더를 일괄 적용하는 미들웨어입니다.
 */
export {
  type SecurityHeadersOptions,
  securityHeadersMiddleware,
} from "./libs/middleware/SecurityHeadersMiddleware";

/**
 * 보안 미들웨어 capability 메타데이터를 선언하고 조회하는 공개 API입니다.
 */
export {
  declareSecurityMiddlewareCapabilities,
  getSecurityMiddlewareCapabilities,
  hasSecurityMiddlewareCapability,
  type SecurityMiddlewareCapability,
} from "./libs/middleware/SecurityMiddlewareMarker";
export type { PipelineConfig } from "./libs/PipelineRunner";
export type { HttpPipelineGraphConfig } from "./libs/PipelineRunner";

export {
  createHttpAppConfig,
  HTTP_TRANSPORT_OPTIONS_TOKEN,
  httpTransport,
} from "./libs/HttpTransportPlugin";
export type {
  HttpControllerContribution,
  HttpMiddlewareContribution,
  HttpTransportPluginOptions,
  HttpTransportRuntimeOptions,
} from "./libs/HttpTransportPlugin";
export type { CompileOptions } from "./libs/RouteCompiler";
