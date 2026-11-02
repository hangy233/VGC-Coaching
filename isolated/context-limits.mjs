// Application input limit, independent of the provider's token context window.
// Output, diagnostic and deadline limits remain separate.
export const MAX_CONTEXT_BYTES = 8 * 1024 * 1024;

export const SESSION_REFRESH_TELEMETRY_FIELDS = Object.freeze([
  'sessionContextRefreshed','sessionContextRefreshRequired','sessionRefreshReason',
  'sessionRefreshPreviousInputTokens','sessionRefreshPreviousOutputTokens',
  'sessionRefreshReportedWindowTokens','sessionRefreshProjectedTokenUpperBound',
  'sessionRefreshNextPacketBytes','sessionRefreshRemainingMs',
  'sessionRefreshMinimumRemainingMs','sessionRefreshOriginalDeadlineAt',
  'sessionRefreshCompletedAt','sessionRefreshFullSnapshot','modelAttempted',
]);
