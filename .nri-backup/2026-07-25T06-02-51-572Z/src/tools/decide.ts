import { DetectedSimpleChange, SimplicityScores, ExecutionPath } from '../graph/nodes';

const SIMPLE_SCORE_THRESHOLD = 7.0;

export function decide(detected: DetectedSimpleChange, scores: SimplicityScores): ExecutionPath {
  const check1 = detected.isSimple;
  const check2 = scores.componentScores.every(c => c.simplicityScore >= SIMPLE_SCORE_THRESHOLD);
  const check3 = scores.groupIsSimple;

  if (check1 && check2 && check3) {
    return 'quick-diff-patch';
  }
  return 'full-decision-graph';
}
