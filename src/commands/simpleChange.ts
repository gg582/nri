import { buildSimpleChangeBypassGraph } from '../graph/builder.js';
import { ingest } from '../tools/ingest.js';
import { detect } from '../tools/detect.js';
import { plan } from '../tools/plan.js';
import { score } from '../tools/score.js';
import { decide } from '../tools/decide.js';

export interface SimpleChangeOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

export async function runSimpleChange(
  rawRequest: string,
  options: SimpleChangeOptions = {},
): Promise<{ commitHash: string; pushed: boolean }> {
  if (options.dryRun) {
    const parsed = await ingest(rawRequest);
    const detected = await detect(parsed);
    const taskGroup = await plan(parsed, detected);
    const scores = await score(taskGroup);
    const path = decide(detected, scores);

    if (options.verbose) {
      console.log(JSON.stringify({ parsed, detected, taskGroup, scores, path }, null, 2));
    } else {
      console.log('Selected path:', path);
      console.log('Group score:', scores.weightedGroupScore);
      console.log('Group simple:', scores.groupIsSimple);
      console.log('Preliminary flag:', detected.isSimple);
    }

    return { commitHash: '', pushed: false };
  }

  const graph = buildSimpleChangeBypassGraph();
  return graph.run(rawRequest);
}
