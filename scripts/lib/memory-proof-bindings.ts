export type BindingWitness = {
  evidenceId: string;
  role: "direct" | "identity";
  sourceSubject?: string;
};
export type SubjectLink = {
  from: string;
  to: string;
  evidenceId: string;
  quote: string;
};
const canonicalSubject = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/\s/gu, "")
    .replace(/^(?:你|您)/u, "用户")
    .replace(/用户的/gu, "用户");

/** Resolve only references anchored in the answer, never a new identity from
 * the fact store. Named entities cannot be swapped merely because both occur.
 * Evidence bridges remain mandatory after this linguistic resolution. */
export function resolveAnchoredSubject(
  original: string | undefined,
  proposed: string | undefined,
  answerContext: string,
  links: SubjectLink[] = [],
) {
  if (!original) return proposed;
  if (!proposed) return original;
  const from = canonicalSubject(original),
    to = canonicalSubject(proposed);
  if (from === to) return proposed;
  const deictic =
    /^(?:他|她|它|这(?:个|位|座|只|条|栋|所).+|那(?:个|位|座|只|条|栋|所).+)$/u.test(
      from,
    );
  const qualified =
    !from.startsWith("用户") && to.startsWith("用户") && to.endsWith(from);
  if ((deictic || qualified) && canonicalSubject(answerContext).includes(to))
    return proposed;
  if (deictic) {
    const visible = [
      ...new Set(
        links
          .flatMap((link) =>
            canonicalSubject(link.from) === to
              ? [link.to]
              : canonicalSubject(link.to) === to
                ? [link.from]
                : [],
          )
          .filter((name) =>
            canonicalSubject(answerContext).includes(canonicalSubject(name)),
          ),
      ),
    ];
    if (visible.length === 1) return visible[0];
  }
  return original;
}
function mentionsSubject(text: string, subject: string) {
  if (text.includes(subject)) return true;
  // User-owned noun phrases can be discontinuous in Chinese topic/把
  // constructions. This is a necessary mention check, not entailment. Proper
  // names stay contiguous: never erase characters from a person's name.
  if (!subject.startsWith("用户")) return false;
  let cursor = 0;
  for (const char of subject) {
    const found = text.indexOf(char, cursor);
    if (found < 0) return false;
    cursor = found + char.length;
  }
  return true;
}

/** Require the entity mapping that a semantic reviewer used to be present in
 * its proof table too. Textual occurrence is a necessary structural check;
 * the semantic reviewer must still establish what each record means.
 */
export function validateSubjectBindings(
  subject: string,
  witnesses: BindingWitness[],
  links: SubjectLink[],
  facts: { id: string; text: string }[],
): string | undefined {
  const start = canonicalSubject(subject);
  const edges: { from: string; to: string; id: string }[] = [];
  for (const link of links) {
    const text = canonicalSubject(
      facts.find((f) => f.id === link.evidenceId)?.text ?? "",
    );
    const from = canonicalSubject(link.from),
      to = canonicalSubject(link.to);
    if (
      !link.quote ||
      !facts.find((f) => f.id === link.evidenceId)?.text.includes(link.quote) ||
      !from ||
      !to ||
      from === to ||
      !mentionsSubject(text, from) ||
      !mentionsSubject(text, to)
    )
      return "invalid_subject_link";
    edges.push(
      { from, to, id: link.evidenceId },
      { from: to, to: from, id: link.evidenceId },
    );
  }
  const used = new Set<string>();
  for (const direct of witnesses.filter((w) => w.role === "direct")) {
    const target = canonicalSubject(direct.sourceSubject ?? "");
    const text = canonicalSubject(
      facts.find((f) => f.id === direct.evidenceId)?.text ?? "",
    );
    if (!target || !text.includes(target)) return "invalid_source_subject";
    // Apposition expresses both endpoints; its identity edge is consumed even
    // when the direct fact uses the relationship endpoint. It cannot be omitted.
    const roots = edges
      .filter(
        (edge) =>
          start === edge.from + edge.to || start === edge.to + edge.from,
      )
      .map((edge) => ({ node: edge.from, ids: [edge.id] }));
    const queue = [{ node: start, ids: [] as string[] }, ...roots],
      seen = new Set([start]);
    let found = false;
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]!;
      if (item.node === target) {
        for (const id of item.ids) used.add(id);
        found = true;
        break;
      }
      for (const edge of edges.filter((e) => e.from === item.node))
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          queue.push({ node: edge.to, ids: [...item.ids, edge.id] });
        }
    }
    if (!found) return "missing_subject_bridge";
  }
  if (
    witnesses.some((w) => w.role === "identity" && !used.has(w.evidenceId)) ||
    links.some((link) => !used.has(link.evidenceId))
  )
    return "irrelevant_subject_bridge";
  return undefined;
}
