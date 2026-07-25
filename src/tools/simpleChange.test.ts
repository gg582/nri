import { ingest } from './ingest';
import { detect } from './detect';
import { plan } from './plan';
import { score } from './score';
import { decide } from './decide';

describe('simple-change bypass workflow', () => {
  it('ingests a raw change request', async () => {
    const raw = 'Fix trailing whitespace in src/cli.ts';
    const parsed = await ingest(raw);
    expect(parsed.changeDescription).toBe('Fix trailing whitespace in src/cli.ts');
    expect(parsed.scopeBoundaries.targetFiles).toContain('src/cli.ts');
  });

  it('detects a style-improvement change', () => {
    const parsed = {
      changeDescription: 'Fix trailing whitespace',
      businessContext: 'Cleanup',
      scopeBoundaries: { targetFiles: ['src/cli.ts'], excludedModules: [], maxChangeSize: 100 },
      rawRequest: 'Fix trailing whitespace in src/cli.ts',
    };
    const detected = detect(parsed);
    expect(detected.isSimple).toBe(true);
    expect(detected.indicators[0].category).toBe('style-improvement');
  });

  it('plans a validated task group', () => {
    const parsed = {
      changeDescription: 'Fix trailing whitespace',
      businessContext: 'Cleanup',
      scopeBoundaries: { targetFiles: ['src/cli.ts'], excludedModules: [], maxChangeSize: 100 },
      rawRequest: 'Fix trailing whitespace in src/cli.ts',
    };
    const detected = detect(parsed);
    const taskGroup = plan(parsed, detected);
    expect(taskGroup.validated).toBe(true);
    expect(taskGroup.editOperations.length).toBeGreaterThan(0);
  });

  it('scores a simple task group', () => {
    const parsed = {
      changeDescription: 'Fix trailing whitespace',
      businessContext: 'Cleanup',
      scopeBoundaries: { targetFiles: ['src/cli.ts'], excludedModules: [], maxChangeSize: 100 },
      rawRequest: 'Fix trailing whitespace in src/cli.ts',
    };
    const detected = detect(parsed);
    const taskGroup = plan(parsed, detected);
    const scores = score(taskGroup);
    expect(scores.componentScores.length).toBeGreaterThan(0);
    expect(typeof scores.weightedGroupScore).toBe('number');
  });

  it('selects quick diff patch for simple changes', () => {
    const detected = { isSimple: true, indicators: [], reason: '' };
    const scores = {
      componentScores: [{ componentId: 'c1', complexityScore: 1, riskScore: 1, scopeScore: 1, simplicityScore: 8 }],
      weightedGroupScore: 2,
      totalSteps: 3,
      groupIsSimple: true,
      threshold: 3,
    };
    expect(decide(detected, scores)).toBe('quick-diff-patch');
  });

  it('selects full decision graph for complex changes', () => {
    const detected = { isSimple: false, indicators: [], reason: '' };
    const scores = {
      componentScores: [{ componentId: 'c1', complexityScore: 5, riskScore: 5, scopeScore: 5, simplicityScore: 4 }],
      weightedGroupScore: 6,
      totalSteps: 10,
      groupIsSimple: false,
      threshold: 3,
    };
    expect(decide(detected, scores)).toBe('full-decision-graph');
  });
});
