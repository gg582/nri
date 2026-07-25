import type { TaskGroup, SimplicityScores, ComponentScore } from '../graph/nodes.js';

const THRESHOLD = 3.0;
const MAX_STEPS = 5;

export function score(taskGroup: TaskGroup): SimplicityScores {
  const componentScores: ComponentScore[] = taskGroup.filesToModify.map((file, index) => {
    const ops = taskGroup.editOperations.filter(op => op.file === file).length;
    const complexityScore = Math.min(10, ops * 2 + 1);
    const riskScore = Math.min(10, ops * 1.5 + 1);
    const scopeScore = Math.min(10, (taskGroup.filesToModify.length / 5) * 5);
    const simplicityScore = Math.max(0, 10 - (complexityScore + riskScore + scopeScore) / 3);
    return {
      componentId: `component-${index}-${file}`,
      complexityScore,
      riskScore,
      scopeScore,
      simplicityScore,
    };
  });

  const totalSteps = taskGroup.orderedSteps.length;

  let weightedGroupScore = 0;
  if (componentScores.length > 0) {
    weightedGroupScore = componentScores.reduce((acc, c) => acc + c.simplicityScore, 0) / componentScores.length;
  }

  if (totalSteps > MAX_STEPS) {
    weightedGroupScore += (totalSteps - MAX_STEPS) * 0.5;
  }

  const groupIsSimple = weightedGroupScore <= THRESHOLD && totalSteps <= MAX_STEPS;

  return {
    componentScores,
    weightedGroupScore,
    totalSteps,
    groupIsSimple,
    threshold: THRESHOLD,
  };
}
