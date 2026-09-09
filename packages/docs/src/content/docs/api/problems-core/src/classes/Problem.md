---
editUrl: false
next: false
prev: false
title: "Problem"
---

RFC 7807 Problem Details를 표현하는 기본 추상 에러 클래스입니다.

## Extends

- `Error`

## Extended by

- [`ProblemRegistryValidationProblem`](/api/problems-core/src/classes/problemregistryvalidationproblem/)
- [`BadRequestProblem`](/api/access-core/src/classes/badrequestproblem/)
- [`ForbiddenProblem`](/api/access-core/src/classes/forbiddenproblem/)
- [`AdminResourceValidationProblem`](/api/admin-core/src/classes/adminresourcevalidationproblem/)
- [`CreditOperationsValidationProblem`](/api/admin-core/src/classes/creditoperationsvalidationproblem/)
- [`EngagementOperationsValidationProblem`](/api/admin-core/src/classes/engagementoperationsvalidationproblem/)
- [`WebhookOperationsActionValidationProblem`](/api/admin-core/src/classes/webhookoperationsactionvalidationproblem/)
- [`AdminGeneratedContractProblem`](/api/admin-generated/src/classes/admingeneratedcontractproblem/)
- [`PostHogAnalyticsCaptureProblem`](/api/analytics-posthog/src/classes/posthoganalyticscaptureproblem/)
- [`PostHogAnalyticsFlushProblem`](/api/analytics-posthog/src/classes/posthoganalyticsflushproblem/)
- [`PostHogAnalyticsGroupProblem`](/api/analytics-posthog/src/classes/posthoganalyticsgroupproblem/)
- [`PostHogAnalyticsIdentifyProblem`](/api/analytics-posthog/src/classes/posthoganalyticsidentifyproblem/)
- [`PostHogAnalyticsReadinessProblem`](/api/analytics-posthog/src/classes/posthoganalyticsreadinessproblem/)
- [`ArchitecturePolicyManifestJsonParseProblem`](/api/architecture-policy/src/classes/architecturepolicymanifestjsonparseproblem/)
- [`ArchitecturePolicyManifestSchemaVersionProblem`](/api/architecture-policy/src/classes/architecturepolicymanifestschemaversionproblem/)
- [`ArchitecturePolicyManifestShapeProblem`](/api/architecture-policy/src/classes/architecturepolicymanifestshapeproblem/)
- [`ArchitecturePolicyPackageJsonParseProblem`](/api/architecture-policy/src/classes/architecturepolicypackagejsonparseproblem/)
- [`AuditableDecoratorProblem`](/api/audit-core/src/classes/auditabledecoratorproblem/)
- [`AuditClientIpConfigurationProblem`](/api/audit-core/src/classes/auditclientipconfigurationproblem/)
- [`BetterAuthAuthenticationProblem`](/api/auth-better-auth/src/classes/betterauthauthenticationproblem/)
- [`BetterAuthInvalidSessionProblem`](/api/auth-better-auth/src/classes/betterauthinvalidsessionproblem/)
- [`BetterAuthNotInitializedProblem`](/api/auth-better-auth/src/classes/betterauthnotinitializedproblem/)
- [`BetterAuthSessionLookupProblem`](/api/auth-better-auth/src/classes/betterauthsessionlookupproblem/)
- [`BetterAuthSessionNotFoundProblem`](/api/auth-better-auth/src/classes/betterauthsessionnotfoundproblem/)
- [`BetterAuthUserNotFoundProblem`](/api/auth-better-auth/src/classes/betterauthusernotfoundproblem/)
- [`InvalidWebhookPayloadProblem`](/api/auth-better-auth/src/classes/invalidwebhookpayloadproblem/)
- [`InvalidWebhookSignatureProblem`](/api/auth-better-auth/src/classes/invalidwebhooksignatureproblem/)
- [`ClerkExternalServiceProblem`](/api/auth-clerk/src/classes/clerkexternalserviceproblem/)
- [`ClerkMalformedClaimProblem`](/api/auth-clerk/src/classes/clerkmalformedclaimproblem/)
- [`ClerkPublicUserDataMissingProblem`](/api/auth-clerk/src/classes/clerkpublicuserdatamissingproblem/)
- [`ClerkTokenVerificationProblem`](/api/auth-clerk/src/classes/clerktokenverificationproblem/)
- [`ClerkTokenVerificationUpstreamProblem`](/api/auth-clerk/src/classes/clerktokenverificationupstreamproblem/)
- [`ClerkWebhookDeliveryFailedProblem`](/api/auth-clerk/src/classes/clerkwebhookdeliveryfailedproblem/)
- [`ClerkWebhookDeliveryInFlightProblem`](/api/auth-clerk/src/classes/clerkwebhookdeliveryinflightproblem/)
- [`DuplicateTenantMappingProblem`](/api/auth-clerk/src/classes/duplicatetenantmappingproblem/)
- [`InvalidWebhookPayloadProblem`](/api/auth-clerk/src/classes/invalidwebhookpayloadproblem/)
- [`UnexpectedTenantMappingClaimProblem`](/api/auth-clerk/src/classes/unexpectedtenantmappingclaimproblem/)
- [`WebhookVerificationProblem`](/api/auth-clerk/src/classes/webhookverificationproblem/)
- [`ApiKeyCreationFailedProblem`](/api/auth-core/src/classes/apikeycreationfailedproblem/)
- [`ApiKeyExpiredProblem`](/api/auth-core/src/classes/apikeyexpiredproblem/)
- [`ApiKeyRevokedProblem`](/api/auth-core/src/classes/apikeyrevokedproblem/)
- [`ApiKeyRotationConflictProblem`](/api/auth-core/src/classes/apikeyrotationconflictproblem/)
- [`ApiKeyRotationProtectionProblem`](/api/auth-core/src/classes/apikeyrotationprotectionproblem/)
- [`AuthProviderUnavailableProblem`](/api/auth-core/src/classes/authproviderunavailableproblem/)
- [`ForbiddenProblem`](/api/auth-core/src/classes/forbiddenproblem/)
- [`InvalidApiKeyRotationIdempotencyKeyProblem`](/api/auth-core/src/classes/invalidapikeyrotationidempotencykeyproblem/)
- [`InvalidPermissionActionProblem`](/api/auth-core/src/classes/invalidpermissionactionproblem/)
- [`InvalidPermissionFormatProblem`](/api/auth-core/src/classes/invalidpermissionformatproblem/)
- [`InvalidRouteMetadataTargetProblem`](/api/auth-core/src/classes/invalidroutemetadatatargetproblem/)
- [`UnauthorizedProblem`](/api/auth-core/src/classes/unauthorizedproblem/)
- [`DuplicateTenantMappingProblem`](/api/auth-drizzle/src/classes/duplicatetenantmappingproblem/)
- [`TenantMappingConflictResolutionProblem`](/api/auth-drizzle/src/classes/tenantmappingconflictresolutionproblem/)
- [`DuplicateBatchStepNameProblem`](/api/batch-core/src/classes/duplicatebatchstepnameproblem/)
- [`InvalidBatchChunkSizeProblem`](/api/batch-core/src/classes/invalidbatchchunksizeproblem/)
- [`InvalidBatchStepNameProblem`](/api/batch-core/src/classes/invalidbatchstepnameproblem/)
- [`BillingAccountNotFoundProblem`](/api/billing-core/src/classes/billingaccountnotfoundproblem/)
- [`BillingAccountTenantConflictProblem`](/api/billing-core/src/classes/billingaccounttenantconflictproblem/)
- [`BillingCheckoutCreationProblem`](/api/billing-core/src/classes/billingcheckoutcreationproblem/)
- [`BillingCheckoutInProgressProblem`](/api/billing-core/src/classes/billingcheckoutinprogressproblem/)
- [`BillingLifecycleCommandConflictProblem`](/api/billing-core/src/classes/billinglifecyclecommandconflictproblem/)
- [`BillingLifecycleCommandInProgressProblem`](/api/billing-core/src/classes/billinglifecyclecommandinprogressproblem/)
- [`BillingLifecycleCommandNotFoundProblem`](/api/billing-core/src/classes/billinglifecyclecommandnotfoundproblem/)
- [`InvalidBillingLifecycleIdempotencyKeyProblem`](/api/billing-core/src/classes/invalidbillinglifecycleidempotencykeyproblem/)
- [`InvalidMoneyAmountProblem`](/api/billing-core/src/classes/invalidmoneyamountproblem/)
- [`InvalidMoneyCurrencyProblem`](/api/billing-core/src/classes/invalidmoneycurrencyproblem/)
- [`InvalidPlanReleaseScheduleProblem`](/api/billing-core/src/classes/invalidplanreleasescheduleproblem/)
- [`InvalidPlanReleaseTransitionProblem`](/api/billing-core/src/classes/invalidplanreleasetransitionproblem/)
- [`InvalidPlanVersionDefinitionProblem`](/api/billing-core/src/classes/invalidplanversiondefinitionproblem/)
- [`InvalidPlanVersionRefProblem`](/api/billing-core/src/classes/invalidplanversionrefproblem/)
- [`InvalidSubscriptionQuantityProblem`](/api/billing-core/src/classes/invalidsubscriptionquantityproblem/)
- [`MoneyCurrencyMismatchProblem`](/api/billing-core/src/classes/moneycurrencymismatchproblem/)
- [`MoneyDivisionByZeroProblem`](/api/billing-core/src/classes/moneydivisionbyzeroproblem/)
- [`OverlappingPlanEffectivePeriodProblem`](/api/billing-core/src/classes/overlappingplaneffectiveperiodproblem/)
- [`PlanReleaseProviderCapabilityProblem`](/api/billing-core/src/classes/planreleaseprovidercapabilityproblem/)
- [`PlanReleasePublishConflictProblem`](/api/billing-core/src/classes/planreleasepublishconflictproblem/)
- [`PlanReleaseValidationFailedProblem`](/api/billing-core/src/classes/planreleasevalidationfailedproblem/)
- [`PlanVersionAlreadyPublishedProblem`](/api/billing-core/src/classes/planversionalreadypublishedproblem/)
- [`PlanVersionConflictProblem`](/api/billing-core/src/classes/planversionconflictproblem/)
- [`ProviderCapabilityUnavailableProblem`](/api/billing-core/src/classes/providercapabilityunavailableproblem/)
- [`StalePlanReleaseRevisionProblem`](/api/billing-core/src/classes/staleplanreleaserevisionproblem/)
- [`SubscriptionNotFoundProblem`](/api/billing-core/src/classes/subscriptionnotfoundproblem/)
- [`SubscriptionPlanVersionMismatchProblem`](/api/billing-core/src/classes/subscriptionplanversionmismatchproblem/)
- [`SubscriptionQuantityProviderMismatchProblem`](/api/billing-core/src/classes/subscriptionquantityprovidermismatchproblem/)
- [`SubscriptionQuantityProviderSourceAheadProblem`](/api/billing-core/src/classes/subscriptionquantityprovidersourceaheadproblem/)
- [`SubscriptionQuantityReconciliationConflictProblem`](/api/billing-core/src/classes/subscriptionquantityreconciliationconflictproblem/)
- [`SubscriptionQuantityReconciliationFailedProblem`](/api/billing-core/src/classes/subscriptionquantityreconciliationfailedproblem/)
- [`SubscriptionQuantitySourceMismatchProblem`](/api/billing-core/src/classes/subscriptionquantitysourcemismatchproblem/)
- [`UnknownPlanVersionProblem`](/api/billing-core/src/classes/unknownplanversionproblem/)
- [`UnknownProviderPlanMappingProblem`](/api/billing-core/src/classes/unknownproviderplanmappingproblem/)
- [`WebhookAlreadyProcessedProblem`](/api/billing-core/src/classes/webhookalreadyprocessedproblem/)
- [`WebhookEventIntentsPendingProblem`](/api/billing-core/src/classes/webhookeventintentspendingproblem/)
- [`BillingStatusMappingProblem`](/api/billing-polar/src/classes/billingstatusmappingproblem/)
- [`PolarCheckoutIdempotencyConflictProblem`](/api/billing-polar/src/classes/polarcheckoutidempotencyconflictproblem/)
- [`PolarCustomerNotFoundProblem`](/api/billing-polar/src/classes/polarcustomernotfoundproblem/)
- [`PolarMissingConfigProblem`](/api/billing-polar/src/classes/polarmissingconfigproblem/)
- [`PolarRetryableUpstreamProblem`](/api/billing-polar/src/classes/polarretryableupstreamproblem/)
- [`PolarSubscriptionNotFoundProblem`](/api/billing-polar/src/classes/polarsubscriptionnotfoundproblem/)
- [`PolarTerminalUpstreamProblem`](/api/billing-polar/src/classes/polarterminalupstreamproblem/)
- [`PolarUsageCustomerNotFoundProblem`](/api/billing-polar/src/classes/polarusagecustomernotfoundproblem/)
- [`PolarUsageMeterMappingProblem`](/api/billing-polar/src/classes/polarusagemetermappingproblem/)
- [`PolarValidationProblem`](/api/billing-polar/src/classes/polarvalidationproblem/)
- [`WebhookProcessingProblem`](/api/billing-polar/src/classes/webhookprocessingproblem/)
- [`WebhookValidationProblem`](/api/billing-polar/src/classes/webhookvalidationproblem/)
- [`QStashBatchConfigProblem`](/api/batch-qstash/src/classes/qstashbatchconfigproblem/)
- [`QStashBatchPublishProblem`](/api/batch-qstash/src/classes/qstashbatchpublishproblem/)
- [`QStashBatchValidationProblem`](/api/batch-qstash/src/classes/qstashbatchvalidationproblem/)
- [`CacheDecoratorConfigProblem`](/api/cache-core/src/classes/cachedecoratorconfigproblem/)
- [`CacheInvalidationAssertionProblem`](/api/cache-core/src/classes/cacheinvalidationassertionproblem/)
- [`CacheInvalidationFailedProblem`](/api/cache-core/src/classes/cacheinvalidationfailedproblem/)
- [`CacheInvalidationGraphProblem`](/api/cache-core/src/classes/cacheinvalidationgraphproblem/)
- [`CacheKeyArgumentProblem`](/api/cache-core/src/classes/cachekeyargumentproblem/)
- [`InvalidCacheConfigurationProblem`](/api/cache-core/src/classes/invalidcacheconfigurationproblem/)
- [`InvalidCacheTtlProblem`](/api/cache-core/src/classes/invalidcachettlproblem/)
- [`UnknownCacheInvalidationEventProblem`](/api/cache-core/src/classes/unknowncacheinvalidationeventproblem/)
- [`UnsupportedCacheInvalidationCapabilityProblem`](/api/cache-core/src/classes/unsupportedcacheinvalidationcapabilityproblem/)
- [`CreditAccountMismatchProblem`](/api/credits-core/src/classes/creditaccountmismatchproblem/)
- [`CreditAccountNotFoundProblem`](/api/credits-core/src/classes/creditaccountnotfoundproblem/)
- [`CreditDuplicateConflictProblem`](/api/credits-core/src/classes/creditduplicateconflictproblem/)
- [`CreditEventPublicationProblem`](/api/credits-core/src/classes/crediteventpublicationproblem/)
- [`CreditRefundMismatchProblem`](/api/credits-core/src/classes/creditrefundmismatchproblem/)
- [`CreditReservationMismatchProblem`](/api/credits-core/src/classes/creditreservationmismatchproblem/)
- [`CreditTransactionNotFoundProblem`](/api/credits-core/src/classes/credittransactionnotfoundproblem/)
- [`ExpiredGrantProblem`](/api/credits-core/src/classes/expiredgrantproblem/)
- [`InsufficientCreditsProblem`](/api/credits-core/src/classes/insufficientcreditsproblem/)
- [`InvalidCreditAmountProblem`](/api/credits-core/src/classes/invalidcreditamountproblem/)
- [`InvalidCreditCommandProblem`](/api/credits-core/src/classes/invalidcreditcommandproblem/)
- [`StaleLedgerPositionProblem`](/api/credits-core/src/classes/staleledgerpositionproblem/)
- [`CreditLedgerPersistenceProblem`](/api/credits-drizzle/src/classes/creditledgerpersistenceproblem/)
- [`HealthEventIntentConflictProblem`](/api/customer-health-core/src/classes/healtheventintentconflictproblem/)
- [`HealthEventPublisherNotConfiguredProblem`](/api/customer-health-core/src/classes/healtheventpublishernotconfiguredproblem/)
- [`HealthScoreNotFoundProblem`](/api/customer-health-core/src/classes/healthscorenotfoundproblem/)
- [`HealthTransitionPersistenceRetryExhaustedProblem`](/api/customer-health-core/src/classes/healthtransitionpersistenceretryexhaustedproblem/)
- [`InvalidHealthScoreInputProblem`](/api/customer-health-core/src/classes/invalidhealthscoreinputproblem/)
- [`HealthTransitionSequenceMissingProblem`](/api/customer-health-drizzle/src/classes/healthtransitionsequencemissingproblem/)
- [`InvalidMeteringInputProblem`](/api/customer-health-drizzle/src/classes/invalidmeteringinputproblem/)
- [`BatchResultLengthMismatchProblem`](/api/dataloader-core/src/classes/batchresultlengthmismatchproblem/)
- [`DesktopPreloadGenerationProblem`](/api/desktop-codegen/src/classes/desktoppreloadgenerationproblem/)
- [`DesktopRendererGenerationProblem`](/api/desktop-codegen/src/classes/desktoprenderergenerationproblem/)
- [`DuplicateDiagnosticsProviderProblem`](/api/diagnostics-core/src/classes/duplicatediagnosticsproviderproblem/)
- [`InvalidDiagnosticsTimeoutProblem`](/api/diagnostics-core/src/classes/invaliddiagnosticstimeoutproblem/)
- [`EntitlementDefinitionProblem`](/api/entitlements-core/src/classes/entitlementdefinitionproblem/)
- [`EntitlementDeniedProblem`](/api/entitlements-core/src/classes/entitlementdeniedproblem/)
- [`EntitlementInactiveSubscriptionProblem`](/api/entitlements-core/src/classes/entitlementinactivesubscriptionproblem/)
- [`EntitlementMissingPlanProblem`](/api/entitlements-core/src/classes/entitlementmissingplanproblem/)
- [`EntitlementNotFoundProblem`](/api/entitlements-core/src/classes/entitlementnotfoundproblem/)
- [`EntitlementPlanVersionAlreadyRegisteredProblem`](/api/entitlements-core/src/classes/entitlementplanversionalreadyregisteredproblem/)
- [`EntitlementPlanVersionMismatchProblem`](/api/entitlements-core/src/classes/entitlementplanversionmismatchproblem/)
- [`EntitlementPlanVersionNotFoundProblem`](/api/entitlements-core/src/classes/entitlementplanversionnotfoundproblem/)
- [`EntitlementProviderUnavailableProblem`](/api/entitlements-core/src/classes/entitlementproviderunavailableproblem/)
- [`EntitlementQuotaExceededProblem`](/api/entitlements-core/src/classes/entitlementquotaexceededproblem/)
- [`EntitlementRequirementProblem`](/api/entitlements-core/src/classes/entitlementrequirementproblem/)
- [`DuplicateEventFieldProblem`](/api/events-core/src/classes/duplicateeventfieldproblem/)
- [`DuplicateEventNameProblem`](/api/events-core/src/classes/duplicateeventnameproblem/)
- [`EventAfterCommitOutcomeRequiredProblem`](/api/events-core/src/classes/eventaftercommitoutcomerequiredproblem/)
- [`EventAfterCommitRequiresActiveTransactionProblem`](/api/events-core/src/classes/eventaftercommitrequiresactivetransactionproblem/)
- [`EventBusDrainIncompleteProblem`](/api/events-core/src/classes/eventbusdrainincompleteproblem/)
- [`EventBusIntakeClosedProblem`](/api/events-core/src/classes/eventbusintakeclosedproblem/)
- [`EventBusNotSetProblem`](/api/events-core/src/classes/eventbusnotsetproblem/)
- [`EventDefinitionProblem`](/api/events-core/src/classes/eventdefinitionproblem/)
- [`EventDeserializationError`](/api/events-core/src/classes/eventdeserializationerror/)
- [`EventTransactionContextUnavailableProblem`](/api/events-core/src/classes/eventtransactioncontextunavailableproblem/)
- [`InvalidEventBusDrainTimeoutProblem`](/api/events-core/src/classes/invalideventbusdraintimeoutproblem/)
- [`UnknownEventTypeProblem`](/api/events-core/src/classes/unknowneventtypeproblem/)
- [`BackpressureExceededProblem`](/api/events-inmemory/src/classes/backpressureexceededproblem/)
- [`BackpressureTimeoutProblem`](/api/events-inmemory/src/classes/backpressuretimeoutproblem/)
- [`DeadLetterQueueNotConfiguredProblem`](/api/events-inmemory/src/classes/deadletterqueuenotconfiguredproblem/)
- [`DeadLetterReplayHandlerUnavailableProblem`](/api/events-inmemory/src/classes/deadletterreplayhandlerunavailableproblem/)
- [`EventPublishDroppedProblem`](/api/events-inmemory/src/classes/eventpublishdroppedproblem/)
- [`EventPublishFailedError`](/api/events-inmemory/src/classes/eventpublishfailederror/)
- [`InvalidBackpressureStrategyProblem`](/api/events-inmemory/src/classes/invalidbackpressurestrategyproblem/)
- [`InvalidDeadLetterHandlerIdentityProblem`](/api/events-inmemory/src/classes/invaliddeadletterhandleridentityproblem/)
- [`InvalidDeadLetterPolicyProblem`](/api/events-inmemory/src/classes/invaliddeadletterpolicyproblem/)
- [`InvalidDeadLetterQueueLimitProblem`](/api/events-inmemory/src/classes/invaliddeadletterqueuelimitproblem/)
- [`InvalidDeadLetterRetryCountProblem`](/api/events-inmemory/src/classes/invaliddeadletterretrycountproblem/)
- [`InvalidEventBusConfigurationProblem`](/api/events-inmemory/src/classes/invalideventbusconfigurationproblem/)
- [`UnsupportedDeadLetterValueProblem`](/api/events-inmemory/src/classes/unsupporteddeadlettervalueproblem/)
- [`InboxClaimConflictProblem`](/api/events-tx/src/classes/inboxclaimconflictproblem/)
- [`InvalidTransactionalEventConfigurationProblem`](/api/events-tx/src/classes/invalidtransactionaleventconfigurationproblem/)
- [`OutboxIdempotencyConflictProblem`](/api/events-tx/src/classes/outboxidempotencyconflictproblem/)
- [`OutboxMessageIdConflictProblem`](/api/events-tx/src/classes/outboxmessageidconflictproblem/)
- [`OutboxPublishExhaustedProblem`](/api/events-tx/src/classes/outboxpublishexhaustedproblem/)
- [`OutboxStorageProblem`](/api/events-tx/src/classes/outboxstorageproblem/)
- [`OutboxTransactionRequiredProblem`](/api/events-tx/src/classes/outboxtransactionrequiredproblem/)
- [`TransactionStateProblem`](/api/events-tx/src/classes/transactionstateproblem/)
- [`ExecutionProblem`](/api/execution-core/src/classes/executionproblem/)
- [`InvalidContinuationLeaseDurationProblem`](/api/execution-core/src/classes/invalidcontinuationleasedurationproblem/)
- [`AudienceAlreadyRegisteredProblem`](/api/engagement-core/src/classes/audiencealreadyregisteredproblem/)
- [`AudienceDefinitionInvalidProblem`](/api/engagement-core/src/classes/audiencedefinitioninvalidproblem/)
- [`AudienceMetadataMissingProblem`](/api/engagement-core/src/classes/audiencemetadatamissingproblem/)
- [`AudienceNotRegisteredProblem`](/api/engagement-core/src/classes/audiencenotregisteredproblem/)
- [`AudiencePreviewInvalidProblem`](/api/engagement-core/src/classes/audiencepreviewinvalidproblem/)
- [`AudienceScopeInvalidProblem`](/api/engagement-core/src/classes/audiencescopeinvalidproblem/)
- [`CampaignAlreadyRegisteredProblem`](/api/engagement-core/src/classes/campaignalreadyregisteredproblem/)
- [`CampaignDefinitionInvalidProblem`](/api/engagement-core/src/classes/campaigndefinitioninvalidproblem/)
- [`CampaignDefinitionMismatchProblem`](/api/engagement-core/src/classes/campaigndefinitionmismatchproblem/)
- [`CampaignExecutionInvalidProblem`](/api/engagement-core/src/classes/campaignexecutioninvalidproblem/)
- [`CampaignExecutionNotReadyProblem`](/api/engagement-core/src/classes/campaignexecutionnotreadyproblem/)
- [`CampaignExecutionPublisherMissingProblem`](/api/engagement-core/src/classes/campaignexecutionpublishermissingproblem/)
- [`CampaignNotRegisteredProblem`](/api/engagement-core/src/classes/campaignnotregisteredproblem/)
- [`CampaignSnapshotCreationProblem`](/api/engagement-core/src/classes/campaignsnapshotcreationproblem/)
- [`CampaignSnapshotIncompleteProblem`](/api/engagement-core/src/classes/campaignsnapshotincompleteproblem/)
- [`CampaignSnapshotNotFoundProblem`](/api/engagement-core/src/classes/campaignsnapshotnotfoundproblem/)
- [`CampaignSnapshotPayloadProblem`](/api/engagement-core/src/classes/campaignsnapshotpayloadproblem/)
- [`CampaignStoreConflictProblem`](/api/engagement-core/src/classes/campaignstoreconflictproblem/)
- [`CampaignStoreValidationProblem`](/api/engagement-core/src/classes/campaignstorevalidationproblem/)
- [`EngagementCommandInvalidProblem`](/api/engagement-core/src/classes/engagementcommandinvalidproblem/)
- [`EngagementDeliveryEventCorrelationProblem`](/api/engagement-core/src/classes/engagementdeliveryeventcorrelationproblem/)
- [`EngagementDispatchFailedProblem`](/api/engagement-core/src/classes/engagementdispatchfailedproblem/)
- [`EngagementPersistenceProblem`](/api/engagement-core/src/classes/engagementpersistenceproblem/)
- [`EngagementRecordedDispatchFailureProblem`](/api/engagement-core/src/classes/engagementrecordeddispatchfailureproblem/)
- [`EngagementRenderFailedProblem`](/api/engagement-core/src/classes/engagementrenderfailedproblem/)
- [`EngagementStoreValidationProblem`](/api/engagement-core/src/classes/engagementstorevalidationproblem/)
- [`EngagementSuppressionEvaluationProblem`](/api/engagement-core/src/classes/engagementsuppressionevaluationproblem/)
- [`MessageAlreadyRegisteredProblem`](/api/engagement-core/src/classes/messagealreadyregisteredproblem/)
- [`MessageDataInvalidProblem`](/api/engagement-core/src/classes/messagedatainvalidproblem/)
- [`MessageDefinitionInvalidProblem`](/api/engagement-core/src/classes/messagedefinitioninvalidproblem/)
- [`MessageRendererAlreadyRegisteredProblem`](/api/engagement-core/src/classes/messagerendereralreadyregisteredproblem/)
- [`MessageRendererBindingMismatchProblem`](/api/engagement-core/src/classes/messagerendererbindingmismatchproblem/)
- [`MessageRendererChannelMissingProblem`](/api/engagement-core/src/classes/messagerendererchannelmissingproblem/)
- [`MessageRendererMessageMissingProblem`](/api/engagement-core/src/classes/messagerenderermessagemissingproblem/)
- [`MessageRendererMissingProblem`](/api/engagement-core/src/classes/messagerenderermissingproblem/)
- [`MessageRendererUndeclaredChannelProblem`](/api/engagement-core/src/classes/messagerendererundeclaredchannelproblem/)
- [`RecipientDirectoryLookupProblem`](/api/engagement-core/src/classes/recipientdirectorylookupproblem/)
- [`RecipientDirectoryScopeMismatchProblem`](/api/engagement-core/src/classes/recipientdirectoryscopemismatchproblem/)
- [`RecipientNotFoundProblem`](/api/engagement-core/src/classes/recipientnotfoundproblem/)
- [`ConfigSchemaNotFoundProblem`](/api/framework-config/src/classes/configschemanotfoundproblem/)
- [`ConfigValidationProblem`](/api/framework-config/src/classes/configvalidationproblem/)
- [`InvalidBooleanEnvProblem`](/api/framework-config/src/classes/invalidbooleanenvproblem/)
- [`RuntimeEnvPresetBoundaryProblem`](/api/framework-config/src/classes/runtimeenvpresetboundaryproblem/)
- [`CircularDependencyProblem`](/api/framework-context/src/classes/circulardependencyproblem/)
- [`ContainerResolutionProblem`](/api/framework-context/src/classes/containerresolutionproblem/)
- [`ContainerScopeMismatchProblem`](/api/framework-context/src/classes/containerscopemismatchproblem/)
- [`InvalidShutdownTimeoutProblem`](/api/framework-context/src/classes/invalidshutdowntimeoutproblem/)
- [`MiddlewareProblem`](/api/framework-context/src/classes/middlewareproblem/)
- [`OnShutdownDecoratorProblem`](/api/framework-context/src/classes/onshutdowndecoratorproblem/)
- [`PipelineGraphProblem`](/api/framework-context/src/classes/pipelinegraphproblem/)
- [`PolicyCapabilityProblem`](/api/framework-context/src/classes/policycapabilityproblem/)
- [`PolicyConflictProblem`](/api/framework-context/src/classes/policyconflictproblem/)
- [`PolicyDefinitionProblem`](/api/framework-context/src/classes/policydefinitionproblem/)
- [`RuntimeInspectorConfigurationProblem`](/api/framework-context/src/classes/runtimeinspectorconfigurationproblem/)
- [`ShutdownConfigurationConflictProblem`](/api/framework-context/src/classes/shutdownconfigurationconflictproblem/)
- [`ShutdownHookExecutionProblem`](/api/framework-context/src/classes/shutdownhookexecutionproblem/)
- [`ShutdownHookRegistrationClosedProblem`](/api/framework-context/src/classes/shutdownhookregistrationclosedproblem/)
- [`ShutdownTimeoutProblem`](/api/framework-context/src/classes/shutdowntimeoutproblem/)
- [`InvalidModuleDefinitionProblem`](/api/framework-module/src/classes/invalidmoduledefinitionproblem/)
- [`InvalidModuleLifecycleDeadlineProblem`](/api/framework-module/src/classes/invalidmodulelifecycledeadlineproblem/)
- [`ModuleCircularDependencyProblem`](/api/framework-module/src/classes/modulecirculardependencyproblem/)
- [`ModuleContributionIdentityProblem`](/api/framework-module/src/classes/modulecontributionidentityproblem/)
- [`ModuleDuplicateNameProblem`](/api/framework-module/src/classes/moduleduplicatenameproblem/)
- [`ModuleLifecycleCancelledProblem`](/api/framework-module/src/classes/modulelifecyclecancelledproblem/)
- [`ModuleLifecycleDeadlineExceededProblem`](/api/framework-module/src/classes/modulelifecycledeadlineexceededproblem/)
- [`ModuleLifecycleProblem`](/api/framework-module/src/classes/modulelifecycleproblem/)
- [`ModuleProviderOwnershipProblem`](/api/framework-module/src/classes/moduleproviderownershipproblem/)
- [`ModuleProviderUnavailableProblem`](/api/framework-module/src/classes/moduleproviderunavailableproblem/)
- [`ModuleProviderVisibilityProblem`](/api/framework-module/src/classes/moduleprovidervisibilityproblem/)
- [`ModuleProviderWriteProblem`](/api/framework-module/src/classes/moduleproviderwriteproblem/)
- [`ModuleRegistrationConflictProblem`](/api/framework-module/src/classes/moduleregistrationconflictproblem/)
- [`ModuleRuntimeDisposedProblem`](/api/framework-module/src/classes/moduleruntimedisposedproblem/)
- [`ModuleRuntimeResetConflictProblem`](/api/framework-module/src/classes/moduleruntimeresetconflictproblem/)
- [`ModuleRuntimeStaleContextProblem`](/api/framework-module/src/classes/moduleruntimestalecontextproblem/)
- [`ProblemFetchUnavailableError`](/api/frontend-problems/src/classes/problemfetchunavailableerror/)
- [`ProblemStatusMismatchError`](/api/frontend-problems/src/classes/problemstatusmismatcherror/)
- [`PageDataUnavailableProblem`](/api/frontend-react/src/classes/pagedataunavailableproblem/)
- [`MissingCloudflareVitePluginProblem`](/api/frontend-vite/src/classes/missingcloudflarevitepluginproblem/)
- [`DuplicateIdPrefixProblem`](/api/gid-core/src/classes/duplicateidprefixproblem/)
- [`InvalidIdPrefixProblem`](/api/gid-core/src/classes/invalididprefixproblem/)
- [`DataGovernanceValidationProblem`](/api/governance-core/src/classes/datagovernancevalidationproblem/)
- [`RetentionPolicyViolationProblem`](/api/governance-core/src/classes/retentionpolicyviolationproblem/)
- [`UnsupportedDataDeleteProblem`](/api/governance-core/src/classes/unsupporteddatadeleteproblem/)
- [`UnsupportedDataExportProblem`](/api/governance-core/src/classes/unsupporteddataexportproblem/)
- [`DuplicateHealthIndicatorProblem`](/api/health-core/src/classes/duplicatehealthindicatorproblem/)
- [`InvalidHealthCheckTimeoutProblem`](/api/health-core/src/classes/invalidhealthchecktimeoutproblem/)
- [`InvalidHealthIndicatorIdProblem`](/api/health-core/src/classes/invalidhealthindicatoridproblem/)
- [`BlockedDuringImpersonationProblem`](/api/impersonation-core/src/classes/blockedduringimpersonationproblem/)
- [`ImpersonationEventIntentConflictProblem`](/api/impersonation-core/src/classes/impersonationeventintentconflictproblem/)
- [`ImpersonationIdentityConflictProblem`](/api/impersonation-core/src/classes/impersonationidentityconflictproblem/)
- [`ImpersonationLifecyclePublicationProblem`](/api/impersonation-core/src/classes/impersonationlifecyclepublicationproblem/)
- [`ImpersonationReasonRequiredProblem`](/api/impersonation-core/src/classes/impersonationreasonrequiredproblem/)
- [`ImpersonationSessionActorMismatchProblem`](/api/impersonation-core/src/classes/impersonationsessionactormismatchproblem/)
- [`ImpersonationSessionNotFoundProblem`](/api/impersonation-core/src/classes/impersonationsessionnotfoundproblem/)
- [`ImpersonationTargetNotFoundProblem`](/api/impersonation-core/src/classes/impersonationtargetnotfoundproblem/)
- [`InvalidImpersonationConfigurationProblem`](/api/impersonation-core/src/classes/invalidimpersonationconfigurationproblem/)
- [`InvalidImpersonationEventIntentLimitProblem`](/api/impersonation-core/src/classes/invalidimpersonationeventintentlimitproblem/)
- [`NestedImpersonationProblem`](/api/impersonation-core/src/classes/nestedimpersonationproblem/)
- [`SelfImpersonationProblem`](/api/impersonation-core/src/classes/selfimpersonationproblem/)
- [`PostHogConfigProblem`](/api/integrations-posthog/src/classes/posthogconfigproblem/)
- [`BatchSizeExceededProblem`](/api/invitation-core/src/classes/batchsizeexceededproblem/)
- [`DomainAutoJoinRecoveryProblem`](/api/invitation-core/src/classes/domainautojoinrecoveryproblem/)
- [`DuplicateInvitationProblem`](/api/invitation-core/src/classes/duplicateinvitationproblem/)
- [`InvalidAutoJoinRoleProblem`](/api/invitation-core/src/classes/invalidautojoinroleproblem/)
- [`InvalidInvitationExpiryDurationProblem`](/api/invitation-core/src/classes/invalidinvitationexpirydurationproblem/)
- [`InvitationAlreadyAcceptedProblem`](/api/invitation-core/src/classes/invitationalreadyacceptedproblem/)
- [`InvitationCreationFailedProblem`](/api/invitation-core/src/classes/invitationcreationfailedproblem/)
- [`InvitationEmailMismatchProblem`](/api/invitation-core/src/classes/invitationemailmismatchproblem/)
- [`InvitationExpiredProblem`](/api/invitation-core/src/classes/invitationexpiredproblem/)
- [`InvitationIdempotencyConflictProblem`](/api/invitation-core/src/classes/invitationidempotencyconflictproblem/)
- [`InvitationInvalidStatusProblem`](/api/invitation-core/src/classes/invitationinvalidstatusproblem/)
- [`InvitationNotFoundProblem`](/api/invitation-core/src/classes/invitationnotfoundproblem/)
- [`InvitationRateLimitExceededProblem`](/api/invitation-core/src/classes/invitationratelimitexceededproblem/)
- [`PublicEmailDomainNotAllowedProblem`](/api/invitation-core/src/classes/publicemaildomainnotallowedproblem/)
- [`InvitationTokenCipherProblem`](/api/invitation-drizzle/src/classes/invitationtokencipherproblem/)
- [`DuplicateLifecycleRuleProblem`](/api/lifecycle-core/src/classes/duplicatelifecycleruleproblem/)
- [`InvalidWebhookTimeoutProblem`](/api/lifecycle-core/src/classes/invalidwebhooktimeoutproblem/)
- [`LifecycleActionAdapterProblem`](/api/lifecycle-core/src/classes/lifecycleactionadapterproblem/)
- [`LifecycleRuleActionContractProblem`](/api/lifecycle-core/src/classes/lifecycleruleactioncontractproblem/)
- [`LifecycleRuleCommandConflictProblem`](/api/lifecycle-core/src/classes/lifecyclerulecommandconflictproblem/)
- [`LifecycleRuleDefinitionProblem`](/api/lifecycle-core/src/classes/lifecycleruledefinitionproblem/)
- [`LifecycleRuleTransitionProblem`](/api/lifecycle-core/src/classes/lifecycleruletransitionproblem/)
- [`LifecycleRuleVersionConflictProblem`](/api/lifecycle-core/src/classes/lifecycleruleversionconflictproblem/)
- [`LifecycleRuleVersionDefinitionProblem`](/api/lifecycle-core/src/classes/lifecycleruleversiondefinitionproblem/)
- [`LifecycleRunEvidenceProblem`](/api/lifecycle-core/src/classes/lifecyclerunevidenceproblem/)
- [`LifecycleRunFinalizationProblem`](/api/lifecycle-core/src/classes/lifecyclerunfinalizationproblem/)
- [`MonetizationRecipeCapabilityProblem`](/api/lifecycle-core/src/classes/monetizationrecipecapabilityproblem/)
- [`MonetizationSignalDefinitionProblem`](/api/lifecycle-core/src/classes/monetizationsignaldefinitionproblem/)
- [`MonetizationThresholdClaimProblem`](/api/lifecycle-core/src/classes/monetizationthresholdclaimproblem/)
- [`UnavailableLifecycleRuleVersionProblem`](/api/lifecycle-core/src/classes/unavailablelifecycleruleversionproblem/)
- [`UnknownLifecycleRuleVersionProblem`](/api/lifecycle-core/src/classes/unknownlifecycleruleversionproblem/)
- [`EmbeddingError`](/api/llm-core/src/classes/embeddingerror/)
- [`GenerationError`](/api/llm-core/src/classes/generationerror/)
- [`InvalidLlmPromptProblem`](/api/llm-core/src/classes/invalidllmpromptproblem/)
- [`InvalidLlmResponseProblem`](/api/llm-core/src/classes/invalidllmresponseproblem/)
- [`LlmCompletionEventPublicationProblem`](/api/llm-core/src/classes/llmcompletioneventpublicationproblem/)
- [`LlmOperationAbortedProblem`](/api/llm-core/src/classes/llmoperationabortedproblem/)
- [`LlmProblem`](/api/llm-core/src/classes/llmproblem/)
- [`LlmProviderNotFoundProblem`](/api/llm-core/src/classes/llmprovidernotfoundproblem/)
- [`LlmRateLimitProblem`](/api/llm-core/src/classes/llmratelimitproblem/)
- [`LlmServiceNotInitializedProblem`](/api/llm-core/src/classes/llmservicenotinitializedproblem/)
- [`LlmServiceProblem`](/api/llm-core/src/classes/llmserviceproblem/)
- [`LlmStructuredOutputProblem`](/api/llm-core/src/classes/llmstructuredoutputproblem/)
- [`LlmTokenLimitExceededProblem`](/api/llm-core/src/classes/llmtokenlimitexceededproblem/)
- [`LlmToolExecutionProblem`](/api/llm-core/src/classes/llmtoolexecutionproblem/)
- [`ModelNotFoundError`](/api/llm-core/src/classes/modelnotfounderror/)
- [`OpenAiAbortProblem`](/api/llm-openai/src/classes/openaiabortproblem/)
- [`OpenAiAuthenticationProblem`](/api/llm-openai/src/classes/openaiauthenticationproblem/)
- [`OpenAiInvalidResponseProblem`](/api/llm-openai/src/classes/openaiinvalidresponseproblem/)
- [`OpenAiMissingConfigProblem`](/api/llm-openai/src/classes/openaimissingconfigproblem/)
- [`OpenAiRateLimitProblem`](/api/llm-openai/src/classes/openairatelimitproblem/)
- [`OpenAiRetryableUpstreamProblem`](/api/llm-openai/src/classes/openairetryableupstreamproblem/)
- [`OpenAiTerminalUpstreamProblem`](/api/llm-openai/src/classes/openaiterminalupstreamproblem/)
- [`OpenAiValidationProblem`](/api/llm-openai/src/classes/openaivalidationproblem/)
- [`LlmCostLimitExceededProblem`](/api/llm-metering/src/classes/llmcostlimitexceededproblem/)
- [`LlmMeteringRecordFailedProblem`](/api/llm-metering/src/classes/llmmeteringrecordfailedproblem/)
- [`LlmMeteringServiceRequiredProblem`](/api/llm-metering/src/classes/llmmeteringservicerequiredproblem/)
- [`LlmQuotaExceededProblem`](/api/llm-metering/src/classes/llmquotaexceededproblem/)
- [`PricingNotFoundProblem`](/api/llm-metering/src/classes/pricingnotfoundproblem/)
- [`PricingRegistryConflictProblem`](/api/llm-metering/src/classes/pricingregistryconflictproblem/)
- [`AlreadyMemberProblem`](/api/membership-core/src/classes/alreadymemberproblem/)
- [`InvalidMembershipCommandProblem`](/api/membership-core/src/classes/invalidmembershipcommandproblem/)
- [`InvalidRoleProblem`](/api/membership-core/src/classes/invalidroleproblem/)
- [`LastOwnerProblem`](/api/membership-core/src/classes/lastownerproblem/)
- [`MembershipConstraintProblem`](/api/membership-core/src/classes/membershipconstraintproblem/)
- [`MembershipEventPublicationProblem`](/api/membership-core/src/classes/membershipeventpublicationproblem/)
- [`MembershipIdempotencyConflictProblem`](/api/membership-core/src/classes/membershipidempotencyconflictproblem/)
- [`MembershipNotFoundProblem`](/api/membership-core/src/classes/membershipnotfoundproblem/)
- [`OwnershipTransferRequiredProblem`](/api/membership-core/src/classes/ownershiptransferrequiredproblem/)
- [`RoleHierarchyViolationProblem`](/api/membership-core/src/classes/rolehierarchyviolationproblem/)
- [`SeatLimitExceededProblem`](/api/membership-core/src/classes/seatlimitexceededproblem/)
- [`ServerActionInvalidPathProblem`](/api/meta-vite/src/classes/serveractioninvalidpathproblem/)
- [`ServerActionNotFoundProblem`](/api/meta-vite/src/classes/serveractionnotfoundproblem/)
- [`ServerActionValidationProblem`](/api/meta-vite/src/classes/serveractionvalidationproblem/)
- [`AtomicQuotaNotSupportedProblem`](/api/metering-core/src/classes/atomicquotanotsupportedproblem/)
- [`BillableUsageJournalRequiredProblem`](/api/metering-core/src/classes/billableusagejournalrequiredproblem/)
- [`DuplicateRecordProblem`](/api/metering-core/src/classes/duplicaterecordproblem/)
- [`InvalidMeterDimensionProblem`](/api/metering-core/src/classes/invalidmeterdimensionproblem/)
- [`InvalidMeterProblem`](/api/metering-core/src/classes/invalidmeterproblem/)
- [`InvalidUsageEnvelopeProblem`](/api/metering-core/src/classes/invalidusageenvelopeproblem/)
- [`InvalidUsageQueryProblem`](/api/metering-core/src/classes/invalidusagequeryproblem/)
- [`InvalidUsageValueProblem`](/api/metering-core/src/classes/invalidusagevalueproblem/)
- [`MeteringTransitionProblem`](/api/metering-core/src/classes/meteringtransitionproblem/)
- [`QuotaExceededProblem`](/api/metering-core/src/classes/quotaexceededproblem/)
- [`RedisProblem`](/api/metering-core/src/classes/redisproblem/)
- [`UsageFlushConfigurationProblem`](/api/metering-core/src/classes/usageflushconfigurationproblem/)
- [`UsageEnvelopeConfigurationProblem`](/api/metering-drizzle/src/classes/usageenvelopeconfigurationproblem/)
- [`MissingUpstashMeteringConfigProblem`](/api/metering-upstash/src/classes/missingupstashmeteringconfigproblem/)
- [`UpstashMeteringUpstreamProblem`](/api/metering-upstash/src/classes/upstashmeteringupstreamproblem/)
- [`BillingMetricDroppedProblem`](/api/metrics-billing/src/classes/billingmetricdroppedproblem/)
- [`BillingMetricRecordingProblem`](/api/metrics-billing/src/classes/billingmetricrecordingproblem/)
- [`CarryingCapacitySimulationProblem`](/api/metrics-core/src/classes/carryingcapacitysimulationproblem/)
- [`CarryingCapacityTenantRequiredProblem`](/api/metrics-core/src/classes/carryingcapacitytenantrequiredproblem/)
- [`GrossMarginRequiredProblem`](/api/metrics-core/src/classes/grossmarginrequiredproblem/)
- [`InvalidCarryingCapacityConfigProblem`](/api/metrics-core/src/classes/invalidcarryingcapacityconfigproblem/)
- [`InvalidRetentionMovementProblem`](/api/metrics-core/src/classes/invalidretentionmovementproblem/)
- [`MixedCurrencyMRRProblem`](/api/metrics-core/src/classes/mixedcurrencymrrproblem/)
- [`RetentionMetricsUnavailableProblem`](/api/metrics-core/src/classes/retentionmetricsunavailableproblem/)
- [`SnapshotTenantRequiredProblem`](/api/metrics-core/src/classes/snapshottenantrequiredproblem/)
- [`DatabaseUrlRequiredProblem`](/api/migration-runner/src/classes/databaseurlrequiredproblem/)
- [`InvalidMigrationCountProblem`](/api/migration-runner/src/classes/invalidmigrationcountproblem/)
- [`MigrationFileLoadProblem`](/api/migration-runner/src/classes/migrationfileloadproblem/)
- [`MigrationHistoryDriftProblem`](/api/migration-runner/src/classes/migrationhistorydriftproblem/)
- [`MigrationTransactionRequiredProblem`](/api/migration-runner/src/classes/migrationtransactionrequiredproblem/)
- [`MissingDownFunctionProblem`](/api/migration-runner/src/classes/missingdownfunctionproblem/)
- [`MissingUpFunctionProblem`](/api/migration-runner/src/classes/missingupfunctionproblem/)
- [`UnsupportedDialectProblem`](/api/migration-runner/src/classes/unsupporteddialectproblem/)
- [`UnsupportedMigrationQueryResultProblem`](/api/migration-runner/src/classes/unsupportedmigrationqueryresultproblem/)
- [`NotificationDefaultProviderConflictProblem`](/api/notifications-core/src/classes/notificationdefaultproviderconflictproblem/)
- [`NotificationDeliveryFailedProblem`](/api/notifications-core/src/classes/notificationdeliveryfailedproblem/)
- [`NotificationIdempotencyKeyRequiredProblem`](/api/notifications-core/src/classes/notificationidempotencykeyrequiredproblem/)
- [`NotificationOutboxIdempotencyMismatchProblem`](/api/notifications-core/src/classes/notificationoutboxidempotencymismatchproblem/)
- [`NotificationPreferenceChannelMismatchProblem`](/api/notifications-core/src/classes/notificationpreferencechannelmismatchproblem/)
- [`NotificationPreferenceContextRequiredProblem`](/api/notifications-core/src/classes/notificationpreferencecontextrequiredproblem/)
- [`NotificationPreferenceDeniedProblem`](/api/notifications-core/src/classes/notificationpreferencedeniedproblem/)
- [`NotificationProviderAlreadyRegisteredProblem`](/api/notifications-core/src/classes/notificationprovideralreadyregisteredproblem/)
- [`NotificationProviderCapabilitiesMissingProblem`](/api/notifications-core/src/classes/notificationprovidercapabilitiesmissingproblem/)
- [`NotificationProviderCapabilityChannelMismatchProblem`](/api/notifications-core/src/classes/notificationprovidercapabilitychannelmismatchproblem/)
- [`NotificationProviderCapabilityNameMismatchProblem`](/api/notifications-core/src/classes/notificationprovidercapabilitynamemismatchproblem/)
- [`NotificationProviderChannelMismatchProblem`](/api/notifications-core/src/classes/notificationproviderchannelmismatchproblem/)
- [`NotificationProviderIdempotencyUnsupportedProblem`](/api/notifications-core/src/classes/notificationprovideridempotencyunsupportedproblem/)
- [`NotificationProviderNotConfiguredProblem`](/api/notifications-core/src/classes/notificationprovidernotconfiguredproblem/)
- [`NotificationProviderNotFoundProblem`](/api/notifications-core/src/classes/notificationprovidernotfoundproblem/)
- [`NotificationProviderNotRegisteredProblem`](/api/notifications-core/src/classes/notificationprovidernotregisteredproblem/)
- [`NotificationSendMaxAttemptsInvalidProblem`](/api/notifications-core/src/classes/notificationsendmaxattemptsinvalidproblem/)
- [`NotificationTemplateAlreadyRegisteredProblem`](/api/notifications-core/src/classes/notificationtemplatealreadyregisteredproblem/)
- [`NotificationTemplateNotFoundProblem`](/api/notifications-core/src/classes/notificationtemplatenotfoundproblem/)
- [`NotificationTemplateVariablesInvalidProblem`](/api/notifications-core/src/classes/notificationtemplatevariablesinvalidproblem/)
- [`ReactEmailRenderProblem`](/api/notifications-react-email/src/classes/reactemailrenderproblem/)
- [`ResendIdempotencyConflictProblem`](/api/notifications-resend/src/classes/resendidempotencyconflictproblem/)
- [`ResendMissingConfigProblem`](/api/notifications-resend/src/classes/resendmissingconfigproblem/)
- [`ResendNotificationProblem`](/api/notifications-resend/src/classes/resendnotificationproblem/)
- [`ResendRetryableUpstreamProblem`](/api/notifications-resend/src/classes/resendretryableupstreamproblem/)
- [`ResendTerminalUpstreamProblem`](/api/notifications-resend/src/classes/resendterminalupstreamproblem/)
- [`ResendValidationProblem`](/api/notifications-resend/src/classes/resendvalidationproblem/)
- [`DuplicateOnboardingDefinitionProblem`](/api/onboarding-core/src/classes/duplicateonboardingdefinitionproblem/)
- [`OnboardingContextRequiredProblem`](/api/onboarding-core/src/classes/onboardingcontextrequiredproblem/)
- [`OnboardingDefinitionNotFoundProblem`](/api/onboarding-core/src/classes/onboardingdefinitionnotfoundproblem/)
- [`OnboardingStateSnapshotUnsupportedProblem`](/api/onboarding-core/src/classes/onboardingstatesnapshotunsupportedproblem/)
- [`OnboardingStepCompletionConflictProblem`](/api/onboarding-core/src/classes/onboardingstepcompletionconflictproblem/)
- [`OnboardingStepNotFoundProblem`](/api/onboarding-core/src/classes/onboardingstepnotfoundproblem/)
- [`OutboxClaimConfigurationProblem`](/api/outbox-core/src/classes/outboxclaimconfigurationproblem/)
- [`OutboxDispatchProblem`](/api/outbox-core/src/classes/outboxdispatchproblem/)
- [`OutboxFailureMetadataProblem`](/api/outbox-core/src/classes/outboxfailuremetadataproblem/)
- [`OutboxRecordIdConflictProblem`](/api/outbox-core/src/classes/outboxrecordidconflictproblem/)
- [`OutboxUnitOfWorkContextProblem`](/api/outbox-core/src/classes/outboxunitofworkcontextproblem/)
- [`AmbiguousPaginationParameterProblem`](/api/pagination-core/src/classes/ambiguouspaginationparameterproblem/)
- [`ConflictingPaginationProblem`](/api/pagination-core/src/classes/conflictingpaginationproblem/)
- [`InvalidCursorProblem`](/api/pagination-core/src/classes/invalidcursorproblem/)
- [`InvalidPaginationDirectionProblem`](/api/pagination-core/src/classes/invalidpaginationdirectionproblem/)
- [`NodeEntryCloseTimeoutProblem`](/api/preset-node/src/classes/nodeentryclosetimeoutproblem/)
- [`NodeEntryLifecycleIoProblem`](/api/preset-node/src/classes/nodeentrylifecycleioproblem/)
- [`NodeEntryLifecycleProblem`](/api/preset-node/src/classes/nodeentrylifecycleproblem/)
- [`ControllerProjectConfigProblem`](/api/protocol-codegen/src/classes/controllerprojectconfigproblem/)
- [`ContractGraphDiagnosticError`](/api/protocols-core/src/classes/contractgraphdiagnosticerror/)
- [`DesktopDefinitionProblem`](/api/protocols-desktop/src/classes/desktopdefinitionproblem/)
- [`DesktopWireSchemaProblem`](/api/protocols-desktop/src/classes/desktopwireschemaproblem/)
- [`GraphQLAuthenticationProblem`](/api/protocols-graphql/src/classes/graphqlauthenticationproblem/)
- [`GraphQLAuthorizationProblem`](/api/protocols-graphql/src/classes/graphqlauthorizationproblem/)
- [`GraphQLInternalError`](/api/protocols-graphql/src/classes/graphqlinternalerror/)
- [`GraphQLNotFoundProblem`](/api/protocols-graphql/src/classes/graphqlnotfoundproblem/)
- [`GraphQLValidationProblem`](/api/protocols-graphql/src/classes/graphqlvalidationproblem/)
- [`GuardDeniedProblem`](/api/protocols-graphql/src/classes/guarddeniedproblem/)
- [`RequestValidationProblem`](/api/protocols-rest/src/classes/requestvalidationproblem/)
- [`ResponseValidationProblem`](/api/protocols-rest/src/classes/responsevalidationproblem/)
- [`ValidationProblem`](/api/protocols-rest/src/classes/validationproblem/)
- [`TrpcRouteHandlerError`](/api/protocols-trpc/src/classes/trpcroutehandlererror/)
- [`RateLimitExceededProblem`](/api/ratelimit-core/src/classes/ratelimitexceededproblem/)
- [`RateLimitKeyBuilderProblem`](/api/ratelimit-core/src/classes/ratelimitkeybuilderproblem/)
- [`RateLimitPruneIntervalProblem`](/api/ratelimit-core/src/classes/ratelimitpruneintervalproblem/)
- [`RateLimitRefundUnsupportedProblem`](/api/ratelimit-core/src/classes/ratelimitrefundunsupportedproblem/)
- [`RateLimitWindowProblem`](/api/ratelimit-core/src/classes/ratelimitwindowproblem/)
- [`InvalidRateLimitPolicyProblem`](/api/ratelimit-upstash/src/classes/invalidratelimitpolicyproblem/)
- [`MissingUpstashRateLimitConfigProblem`](/api/ratelimit-upstash/src/classes/missingupstashratelimitconfigproblem/)
- [`UpstashRateLimitUpstreamProblem`](/api/ratelimit-upstash/src/classes/upstashratelimitupstreamproblem/)
- [`BatchLoadDuplicateResultKeyProblem`](/api/repository-core/src/classes/batchloadduplicateresultkeyproblem/)
- [`BatchLoaderFactoryNotRegisteredProblem`](/api/repository-core/src/classes/batchloaderfactorynotregisteredproblem/)
- [`BatchLoaderFactoryResolutionProblem`](/api/repository-core/src/classes/batchloaderfactoryresolutionproblem/)
- [`BatchLoaderScopeCollisionProblem`](/api/repository-core/src/classes/batchloaderscopecollisionproblem/)
- [`BatchLoadResultIdentityMismatchProblem`](/api/repository-core/src/classes/batchloadresultidentitymismatchproblem/)
- [`BatchLoadUnexpectedResultKeyProblem`](/api/repository-core/src/classes/batchloadunexpectedresultkeyproblem/)
- [`BatchLoadUnkeyedResultProblem`](/api/repository-core/src/classes/batchloadunkeyedresultproblem/)
- [`CircuitBreakerOpenProblem`](/api/retry-core/src/classes/circuitbreakeropenproblem/)
- [`CircuitBreakerUnexpectedStateProblem`](/api/retry-core/src/classes/circuitbreakerunexpectedstateproblem/)
- [`DuplicateRecoverHandlerProblem`](/api/retry-core/src/classes/duplicaterecoverhandlerproblem/)
- [`InvalidRetryConfigurationProblem`](/api/retry-core/src/classes/invalidretryconfigurationproblem/)
- [`LambdaTimeoutProblem`](/api/retry-core/src/classes/lambdatimeoutproblem/)
- [`RetryAbortedProblem`](/api/retry-core/src/classes/retryabortedproblem/)
- [`RetryCancellationUnsupportedProblem`](/api/retry-core/src/classes/retrycancellationunsupportedproblem/)
- [`RetryExhaustedProblem`](/api/retry-core/src/classes/retryexhaustedproblem/)
- [`RetrySuccessHookProblem`](/api/retry-core/src/classes/retrysuccesshookproblem/)
- [`IndexNotFoundProblem`](/api/search-core/src/classes/indexnotfoundproblem/)
- [`MissingTenantProblem`](/api/search-core/src/classes/missingtenantproblem/)
- [`SearchableIndexConflictProblem`](/api/search-core/src/classes/searchableindexconflictproblem/)
- [`SearchCapabilityUnavailableProblem`](/api/search-core/src/classes/searchcapabilityunavailableproblem/)
- [`SearchOperationAbortedProblem`](/api/search-core/src/classes/searchoperationabortedproblem/)
- [`SearchSyncIdentityConflictProblem`](/api/search-core/src/classes/searchsyncidentityconflictproblem/)
- [`SearchTransformRegistrationConflictProblem`](/api/search-core/src/classes/searchtransformregistrationconflictproblem/)
- [`StrategyUnavailableProblem`](/api/search-core/src/classes/strategyunavailableproblem/)
- [`TransformNotFoundProblem`](/api/search-core/src/classes/transformnotfoundproblem/)
- [`BulkIndexChunkFailedProblem`](/api/search-drizzle/src/classes/bulkindexchunkfailedproblem/)
- [`BulkIndexDocumentTooWideProblem`](/api/search-drizzle/src/classes/bulkindexdocumenttoowideproblem/)
- [`InvalidSearchQueryProblem`](/api/search-drizzle/src/classes/invalidsearchqueryproblem/)
- [`InvalidSearchRowProblem`](/api/search-drizzle/src/classes/invalidsearchrowproblem/)
- [`MeilisearchIndexNotFoundProblem`](/api/search-meilisearch/src/classes/meilisearchindexnotfoundproblem/)
- [`MeilisearchInvalidRequestProblem`](/api/search-meilisearch/src/classes/meilisearchinvalidrequestproblem/)
- [`MeilisearchRetryableUpstreamProblem`](/api/search-meilisearch/src/classes/meilisearchretryableupstreamproblem/)
- [`MeilisearchTaskCanceledProblem`](/api/search-meilisearch/src/classes/meilisearchtaskcanceledproblem/)
- [`MeilisearchTerminalUpstreamProblem`](/api/search-meilisearch/src/classes/meilisearchterminalupstreamproblem/)
- [`MissingMeilisearchConfigProblem`](/api/search-meilisearch/src/classes/missingmeilisearchconfigproblem/)
- [`TenantTokenNotConfiguredProblem`](/api/search-meilisearch/src/classes/tenanttokennotconfiguredproblem/)
- [`CloudflareImagesMissingConfigProblem`](/api/storage-cloudflare/src/classes/cloudflareimagesmissingconfigproblem/)
- [`CloudflareImagesRetryableUpstreamProblem`](/api/storage-cloudflare/src/classes/cloudflareimagesretryableupstreamproblem/)
- [`CloudflareImagesTerminalUpstreamProblem`](/api/storage-cloudflare/src/classes/cloudflareimagesterminalupstreamproblem/)
- [`CloudflareImagesValidationProblem`](/api/storage-cloudflare/src/classes/cloudflareimagesvalidationproblem/)
- [`CloudinaryMissingConfigProblem`](/api/storage-cloudinary/src/classes/cloudinarymissingconfigproblem/)
- [`CloudinaryRetryableUpstreamProblem`](/api/storage-cloudinary/src/classes/cloudinaryretryableupstreamproblem/)
- [`CloudinaryTerminalUpstreamProblem`](/api/storage-cloudinary/src/classes/cloudinaryterminalupstreamproblem/)
- [`CloudinaryValidationProblem`](/api/storage-cloudinary/src/classes/cloudinaryvalidationproblem/)
- [`StorageProblem`](/api/storage-core/src/classes/storageproblem/)
- [`OtlpEndpointRequiredProblem`](/api/telemetry-sdk-node/src/classes/otlpendpointrequiredproblem/)
- [`SamplerProblem`](/api/telemetry-sdk-node/src/classes/samplerproblem/)
- [`TelemetryAutoInstrumentationProblem`](/api/telemetry-sdk-node/src/classes/telemetryautoinstrumentationproblem/)
- [`TelemetryBatchConfigurationProblem`](/api/telemetry-sdk-node/src/classes/telemetrybatchconfigurationproblem/)
- [`TelemetryForceFlushUnsupportedProblem`](/api/telemetry-sdk-node/src/classes/telemetryforceflushunsupportedproblem/)
- [`TelemetryInitializationConflictProblem`](/api/telemetry-sdk-node/src/classes/telemetryinitializationconflictproblem/)
- [`TelemetryShutdownTimeoutInvalidProblem`](/api/telemetry-sdk-node/src/classes/telemetryshutdowntimeoutinvalidproblem/)
- [`TelemetryShutdownTimeoutProblem`](/api/telemetry-sdk-node/src/classes/telemetryshutdowntimeoutproblem/)
- [`ChangedTestPlanProblem`](/api/testing/src/classes/changedtestplanproblem/)
- [`ContractInvariantProblem`](/api/testing/src/classes/contractinvariantproblem/)
- [`ContractRuntimeMismatchProblem`](/api/testing/src/classes/contractruntimemismatchproblem/)
- [`ContractTestingProblem`](/api/testing/src/classes/contracttestingproblem/)
- [`ExecutableAssuranceContractProblem`](/api/testing/src/classes/executableassurancecontractproblem/)
- [`ExecutableAssuranceUnsatisfiedProblem`](/api/testing/src/classes/executableassuranceunsatisfiedproblem/)
- [`ScenarioContractProblem`](/api/testing/src/classes/scenariocontractproblem/)
- [`TestEvidenceContractError`](/api/testing/src/classes/testevidencecontracterror/)
- [`TestEvidenceFidelityError`](/api/testing/src/classes/testevidencefidelityerror/)
- [`TestKernelDisposalProblem`](/api/testing/src/classes/testkerneldisposalproblem/)
- [`TestKernelDisposedProblem`](/api/testing/src/classes/testkerneldisposedproblem/)
- [`TestKernelLeakProblem`](/api/testing/src/classes/testkernelleakproblem/)
- [`TestKernelOutboundCallProblem`](/api/testing/src/classes/testkerneloutboundcallproblem/)
- [`TestKernelResourceFidelityProblem`](/api/testing/src/classes/testkernelresourcefidelityproblem/)
- [`TestKernelResourceNotFoundProblem`](/api/testing/src/classes/testkernelresourcenotfoundproblem/)
- [`TestKernelResourceRegistrationProblem`](/api/testing/src/classes/testkernelresourceregistrationproblem/)
- [`TestKernelValidationProblem`](/api/testing/src/classes/testkernelvalidationproblem/)
- [`TestRuntimeConfigurationProblem`](/api/testing/src/classes/testruntimeconfigurationproblem/)
- [`TestRuntimeDrainProblem`](/api/testing/src/classes/testruntimedrainproblem/)
- [`UnsupportedContractGenerationProblem`](/api/testing/src/classes/unsupportedcontractgenerationproblem/)
- [`TestResourceConfigurationProblem`](/api/testing-resources/src/classes/testresourceconfigurationproblem/)
- [`TestResourceLifecycleProblem`](/api/testing-resources/src/classes/testresourcelifecycleproblem/)
- [`TestResourceMissingDependencyProblem`](/api/testing-resources/src/classes/testresourcemissingdependencyproblem/)
- [`DuplicateTaskRegistrationProblem`](/api/tasks-core/src/classes/duplicatetaskregistrationproblem/)
- [`InvalidTaskReferenceProblem`](/api/tasks-core/src/classes/invalidtaskreferenceproblem/)
- [`TaskExecutionTimeoutProblem`](/api/tasks-core/src/classes/taskexecutiontimeoutproblem/)
- [`TaskNotFoundProblem`](/api/tasks-core/src/classes/tasknotfoundproblem/)
- [`TaskRunnerDIFailureProblem`](/api/tasks-core/src/classes/taskrunnerdifailureproblem/)
- [`QStashTaskConfigProblem`](/api/tasks-qstash/src/classes/qstashtaskconfigproblem/)
- [`QStashTaskPublishProblem`](/api/tasks-qstash/src/classes/qstashtaskpublishproblem/)
- [`QStashTaskValidationProblem`](/api/tasks-qstash/src/classes/qstashtaskvalidationproblem/)
- [`DuplicateTenantManagerRegistrationProblem`](/api/tenant-core/src/classes/duplicatetenantmanagerregistrationproblem/)
- [`TenantManagerNotRegisteredProblem`](/api/tenant-core/src/classes/tenantmanagernotregisteredproblem/)
- [`TenantNotFoundProblem`](/api/tenant-core/src/classes/tenantnotfoundproblem/)
- [`TenantRequiredProblem`](/api/tenant-core/src/classes/tenantrequiredproblem/)
- [`GraphQLBodyLimitConfigurationProblem`](/api/transports-graphql/src/classes/graphqlbodylimitconfigurationproblem/)
- [`GraphQLRequestBodyAbortedProblem`](/api/transports-graphql/src/classes/graphqlrequestbodyabortedproblem/)
- [`GraphQLRequestBodyTooLargeProblem`](/api/transports-graphql/src/classes/graphqlrequestbodytoolargeproblem/)
- [`GraphQLRequestHandlingFailedProblem`](/api/transports-graphql/src/classes/graphqlrequesthandlingfailedproblem/)
- [`GraphQLRequestTimeoutConfigurationProblem`](/api/transports-graphql/src/classes/graphqlrequesttimeoutconfigurationproblem/)
- [`GraphQLRequestTimeoutProblem`](/api/transports-graphql/src/classes/graphqlrequesttimeoutproblem/)
- [`GraphQLResolversNotConfiguredProblem`](/api/transports-graphql/src/classes/graphqlresolversnotconfiguredproblem/)
- [`GraphQLSchemaNotConfiguredProblem`](/api/transports-graphql/src/classes/graphqlschemanotconfiguredproblem/)
- [`GraphQLServerNotInitializedProblem`](/api/transports-graphql/src/classes/graphqlservernotinitializedproblem/)
- [`DiagnosticsConfigurationProblem`](/api/transports-http/src/classes/diagnosticsconfigurationproblem/)
- [`GracefulShutdownConfigurationProblem`](/api/transports-http/src/classes/gracefulshutdownconfigurationproblem/)
- [`GracefulShutdownTimeoutProblem`](/api/transports-http/src/classes/gracefulshutdowntimeoutproblem/)
- [`HttpBodyLimitConfigurationProblem`](/api/transports-http/src/classes/httpbodylimitconfigurationproblem/)
- [`HttpRequestBodyReadProblem`](/api/transports-http/src/classes/httprequestbodyreadproblem/)
- [`HttpRequestBodyTooLargeProblem`](/api/transports-http/src/classes/httprequestbodytoolargeproblem/)
- [`HttpRequestBodyUnavailableProblem`](/api/transports-http/src/classes/httprequestbodyunavailableproblem/)
- [`AfterCommitHooksProblem`](/api/tx-core/src/classes/aftercommithooksproblem/)
- [`AfterCommitOutcomeRequiredProblem`](/api/tx-core/src/classes/aftercommitoutcomerequiredproblem/)
- [`AfterCommitRegistrationClosedProblem`](/api/tx-core/src/classes/aftercommitregistrationclosedproblem/)
- [`DetachedTransactionOperationProblem`](/api/tx-core/src/classes/detachedtransactionoperationproblem/)
- [`DuplicateTxManagerRegistrationProblem`](/api/tx-core/src/classes/duplicatetxmanagerregistrationproblem/)
- [`InvalidTransactionTimeoutProblem`](/api/tx-core/src/classes/invalidtransactiontimeoutproblem/)
- [`TransactionContextProblem`](/api/tx-core/src/classes/transactioncontextproblem/)
- [`TransactionDecoratorProblem`](/api/tx-core/src/classes/transactiondecoratorproblem/)
- [`TransactionOutcomeContextProblem`](/api/tx-core/src/classes/transactionoutcomecontextproblem/)
- [`TransactionOutcomeUnknownProblem`](/api/tx-core/src/classes/transactionoutcomeunknownproblem/)
- [`TransactionRollbackConfirmedProblem`](/api/tx-core/src/classes/transactionrollbackconfirmedproblem/)
- [`TransactionTimeoutProblem`](/api/tx-core/src/classes/transactiontimeoutproblem/)
- [`TxManagerNotRegisteredError`](/api/tx-core/src/classes/txmanagernotregisterederror/)
- [`TxPropagationError`](/api/tx-core/src/classes/txpropagationerror/)
- [`RlsConfigurationProblem`](/api/tx-drizzle/src/classes/rlsconfigurationproblem/)
- [`RlsDebugLoggingProblem`](/api/tx-drizzle/src/classes/rlsdebugloggingproblem/)
- [`RlsExecuteUnsupportedProblem`](/api/tx-drizzle/src/classes/rlsexecuteunsupportedproblem/)
- [`SavepointUnsupportedProblem`](/api/tx-drizzle/src/classes/savepointunsupportedproblem/)
- [`TenantContextRequiredProblem`](/api/tx-drizzle/src/classes/tenantcontextrequiredproblem/)
- [`DuplicateWorkflowRegistrationProblem`](/api/workflow-core/src/classes/duplicateworkflowregistrationproblem/)
- [`SagaDefinitionProblem`](/api/workflow-core/src/classes/sagadefinitionproblem/)
- [`SagaExecutionFailedProblem`](/api/workflow-core/src/classes/sagaexecutionfailedproblem/)
- [`SagaExecutionInFlightProblem`](/api/workflow-core/src/classes/sagaexecutioninflightproblem/)
- [`SagaExecutionNotFoundProblem`](/api/workflow-core/src/classes/sagaexecutionnotfoundproblem/)
- [`SagaFinalizationProblem`](/api/workflow-core/src/classes/sagafinalizationproblem/)
- [`SagaListPaginationProblem`](/api/workflow-core/src/classes/sagalistpaginationproblem/)
- [`SagaReplayProblem`](/api/workflow-core/src/classes/sagareplayproblem/)
- [`SagaStoreConflictProblem`](/api/workflow-core/src/classes/sagastoreconflictproblem/)
- [`WorkflowDefinitionProblem`](/api/workflow-core/src/classes/workflowdefinitionproblem/)
- [`WorkflowExecutionFailedProblem`](/api/workflow-core/src/classes/workflowexecutionfailedproblem/)
- [`WorkflowExecutionInProgressProblem`](/api/workflow-core/src/classes/workflowexecutioninprogressproblem/)
- [`WorkflowNotFoundProblem`](/api/workflow-core/src/classes/workflownotfoundproblem/)
- [`WorkflowReplayUnsupportedProblem`](/api/workflow-core/src/classes/workflowreplayunsupportedproblem/)

## Properties

### category

> `readonly` **category**: [`ProblemCategory`](/api/problems-core/src/enumerations/problemcategory/)

---

### cause?

> `readonly` `optional` **cause?**: `Error`

#### Overrides

`Error.cause`

---

### code

> `readonly` **code**: `string`

---

### detail?

> `readonly` `optional` **detail?**: `string`

---

### extensions?

> `readonly` `optional` **extensions?**: [`ProblemExtensions`](/api/problems-core/src/type-aliases/problemextensions/)

---

### instance?

> `readonly` `optional` **instance?**: `string`

---

### message

> **message**: `string`

#### Inherited from

`Error.message`

---

### name

> **name**: `string`

#### Inherited from

`Error.name`

---

### stack?

> `optional` **stack?**: `string`

#### Inherited from

`Error.stack`

---

### type

> `readonly` **type**: `string`

---

### stackTraceLimit

> `static` **stackTraceLimit**: `number`

The `Error.stackTraceLimit` property specifies the number of stack frames
collected by a stack trace (whether generated by `new Error().stack` or
`Error.captureStackTrace(obj)`).

The default value is `10` but may be set to any valid JavaScript number. Changes
will affect any stack trace captured _after_ the value has been changed.

If set to a non-number value, or set to a negative number, stack traces will
not capture any frames.

#### Inherited from

`Error.stackTraceLimit`

## Accessors

### status

#### Get Signature

> **get** **status**(): `number`

##### Returns

`number`

---

### title

#### Get Signature

> **get** **title**(): `string`

##### Returns

`string`

## Methods

### toJSON()

> **toJSON**(): [`ProblemDetails`](/api/problems-core/src/type-aliases/problemdetails/)

#### Returns

[`ProblemDetails`](/api/problems-core/src/type-aliases/problemdetails/)

---

### captureStackTrace()

> `static` **captureStackTrace**(`targetObject`, `constructorOpt?`): `void`

Creates a `.stack` property on `targetObject`, which when accessed returns
a string representing the location in the code at which
`Error.captureStackTrace()` was called.

```js
const myObject = {};
Error.captureStackTrace(myObject);
myObject.stack; // Similar to `new Error().stack`
```

The first line of the trace will be prefixed with
`${myObject.name}: ${myObject.message}`.

The optional `constructorOpt` argument accepts a function. If given, all frames
above `constructorOpt`, including `constructorOpt`, will be omitted from the
generated stack trace.

The `constructorOpt` argument is useful for hiding implementation
details of error generation from the user. For instance:

```js
function a() {
  b();
}

function b() {
  c();
}

function c() {
  // Create an error without stack trace to avoid calculating the stack trace twice.
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  const error = new Error();
  Error.stackTraceLimit = stackTraceLimit;

  // Capture the stack trace above function b
  Error.captureStackTrace(error, b); // Neither function c, nor b is included in the stack trace
  throw error;
}

a();
```

#### Parameters

##### targetObject

`object`

##### constructorOpt?

`Function`

#### Returns

`void`

#### Inherited from

`Error.captureStackTrace`

---

### prepareStackTrace()

> `static` **prepareStackTrace**(`err`, `stackTraces`): `any`

#### Parameters

##### err

`Error`

##### stackTraces

`CallSite`[]

#### Returns

`any`

#### See

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

#### Inherited from

`Error.prepareStackTrace`
