import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeXaiBilling, probeXaiInference } from '@/utils/quota/providerRequests';
import { XaiProbeError, classifyXaiProbe, parseXaiErrorEnvelope } from '@/utils/quota/xaiErrors';
import { DEFAULT_CODEX_INSPECTION_SETTINGS } from './codexInspectionSettings';
import { inspectSingleXaiAccount } from './xaiInspectionProbe';

vi.mock('@/utils/quota/providerRequests', () => ({
  probeXaiBilling: vi.fn(),
  probeXaiInference: vi.fn(),
}));

const mockProbeXaiBilling = vi.mocked(probeXaiBilling);
const mockProbeXaiInference = vi.mocked(probeXaiInference);
const settings = {
  baseUrl: '',
  token: '',
  ...DEFAULT_CODEX_INSPECTION_SETTINGS,
  targetTypes: ['xai'],
  targetType: 'xai',
  usedPercentThreshold: 100,
};
const rawAccount = {
  name: 'xai-auth.json',
  type: 'xai',
  auth_index: 'xai-1',
  account: 'xai-user@example.test',
};
const baseAccount = {
  key: 'xai-auth.json::xai-1',
  fileName: 'xai-auth.json',
  displayAccount: 'xai-user@example.test',
  authIndex: 'xai-1',
  accountId: null,
  provider: 'xai',
  disabled: false,
  autoRecoverOwned: false,
  status: '',
  state: '',
  raw: rawAccount,
};

const healthySummary = {
  periodType: 'weekly' as const,
  usagePercent: 25,
  periodEnd: '2026-07-22T00:00:00Z',
  productUsage: [{ product: 'Grok 4', usagePercent: 30 }],
  monthlyLimitCents: 10000,
  usedCents: 4000,
  includedUsedCents: null,
  onDemandCapCents: null,
  onDemandUsedCents: null,
  onDemandUsedPercent: null,
  billingPeriodEnd: '2026-08-01T00:00:00Z',
  usedPercent: 40,
};

const inferenceError = (statusCode: number, body: unknown) => {
  const envelope = parseXaiErrorEnvelope({ statusCode, body });
  return new XaiProbeError(
    `HTTP ${statusCode}`,
    envelope,
    classifyXaiProbe({ surface: 'inference', envelope })
  );
};

describe('inspectSingleXaiAccount', () => {
  beforeEach(() => {
    mockProbeXaiBilling.mockReset();
    mockProbeXaiInference.mockReset();
    mockProbeXaiBilling.mockResolvedValue({
      summary: healthySummary,
      failures: [],
      partial: false,
    });
    mockProbeXaiInference.mockResolvedValue({ statusCode: 200 });
  });

  it('uses a real inference request as the health authority and keeps billing quota display', async () => {
    const result = await inspectSingleXaiAccount(baseAccount, settings);

    expect(mockProbeXaiBilling).toHaveBeenCalledWith(rawAccount, expect.any(Function), {
      timeout: settings.timeout,
    });
    expect(mockProbeXaiInference).toHaveBeenCalledWith(
      rawAccount,
      expect.any(Function),
      { timeout: settings.timeout },
      {
        model: settings.xaiInferenceModel,
        prompt: settings.xaiInferencePrompt,
      }
    );
    expect(result).toMatchObject({
      action: 'keep',
      statusCode: 200,
      usedPercent: 40,
      errorKind: 'inference_healthy',
      actionReason: 'monitoring.xai_inspection_reason_inference_healthy',
    });
    expect((result.quotaWindows ?? []).map((window) => window.id)).toEqual([
      'xai-weekly',
      'xai-monthly',
      'xai-product-0',
    ]);
  });

  it('does not treat unavailable billing as an unhealthy credential when inference succeeds', async () => {
    mockProbeXaiBilling.mockRejectedValue(new Error('billing endpoint unavailable'));

    const result = await inspectSingleXaiAccount(baseAccount, settings);

    expect(result).toMatchObject({
      action: 'keep',
      statusCode: 200,
      usedPercent: null,
      errorKind: 'inference_healthy',
    });
  });

  it('only auto-enables an inspection-owned disabled credential after real inference succeeds', async () => {
    const manual = await inspectSingleXaiAccount(
      { ...baseAccount, disabled: true, autoRecoverOwned: false },
      settings
    );
    const owned = await inspectSingleXaiAccount(
      { ...baseAccount, disabled: true, autoRecoverOwned: true },
      settings
    );

    expect(manual).toMatchObject({
      action: 'keep',
      actionReason: 'monitoring.xai_inspection_reason_inference_manual_disable',
      autoRecoverEligible: false,
    });
    expect(owned).toMatchObject({ action: 'enable', autoRecoverEligible: true });
  });

  it.each([
    {
      name: 'expired credentials',
      statusCode: 401,
      body: { code: 'unauthenticated:bad-credentials' },
      action: 'reauth',
      errorKind: 'auth_invalid',
    },
    {
      name: 'ambiguous quota response',
      statusCode: 402,
      body: { error: 'Payment required' },
      action: 'keep',
      errorKind: 'quota_or_entitlement_unknown',
    },
    {
      name: 'rate limiting',
      statusCode: 429,
      body: { error: 'Too many requests' },
      action: 'keep',
      errorKind: 'rate_limited',
    },
  ])('uses inference status for $name', async ({ action, body, errorKind, statusCode }) => {
    mockProbeXaiInference.mockRejectedValue(inferenceError(statusCode, body));

    const result = await inspectSingleXaiAccount(baseAccount, settings);

    expect(result).toMatchObject({ action, errorKind, statusCode });
  });

  it('keeps the credential unchanged when inference completes without a completion event', async () => {
    mockProbeXaiInference.mockRejectedValue(inferenceError(200, { type: 'response.in_progress' }));

    const result = await inspectSingleXaiAccount(baseAccount, settings);

    expect(result).toMatchObject({
      action: 'keep',
      statusCode: 200,
      errorKind: 'protocol_changed',
    });
  });
});
