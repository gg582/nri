/** A compact, deterministic representation of a multi-turn engineering conversation. */
export interface ConversationTurn {
  request: string;
  outcome: string;
}

export interface ConversationGraph {
  nodes: Array<{ id: string; request: string; outcome: string }>;
  edges: Array<{ from: string; to: string; relation: "follow-up" | "new-topic" }>;
}

function relation(previous: string, next: string): "follow-up" | "new-topic" {
  const followUp = /\b(that|this|it|previous|above|same|continue|also|then)\b|그것|이것|이전|위|계속|추가/u;
  if (followUp.test(next)) return "follow-up";
  const words = previous.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  return words.some((word) => next.toLowerCase().includes(word)) ? "follow-up" : "new-topic";
}

/**
 * Preserve the dependency chain (a -> a1 -> a2 -> b) while bounding prompt
 * size. Older turns are represented as graph nodes rather than pasted prose.
 */
export function compressConversation(turns: readonly ConversationTurn[], maxTurns = 6): string {
  const kept = turns.slice(-maxTurns);
  if (kept.length === 0) return "";
  const graph: ConversationGraph = {
    nodes: kept.map((turn, index) => ({
      id: `t${index + 1}`,
      request: turn.request.slice(0, 800),
      outcome: turn.outcome.slice(0, 1_200),
    })),
    edges: kept.slice(1).map((turn, index) => ({
      from: `t${index + 1}`,
      to: `t${index + 2}`,
      relation: relation(kept[index].request, turn.request),
    })),
  };
  return JSON.stringify(graph);
}
