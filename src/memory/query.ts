/** Query-side vocabulary only; never adds an answer or changes stored evidence. */
export function memoryQuery(query: string) {
  const normalized = query.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const occupation =
    /职业|工作岗位|做什么工作|干哪[一门行]|从事.{0,6}(工作|行业)|以什么为生|工作.{0,6}谋生/u.test(
      normalized,
    );
  const address =
    /称呼|昵称|怎么.{0,6}叫我|该.{0,6}叫我|叫我.{0,6}(合适|心意|喜欢)|如何.{0,6}叫我/u.test(
      normalized,
    );
  const keywords = [
    ...(occupation ? ["从事", "职业", "任职"] : []),
    ...(address ? ["称呼", "昵称"] : []),
  ];
  const facets = [
    ...(occupation ? ["职业、工作岗位、从事的工作"] : []),
    ...(address ? ["希望被称呼的名字、昵称、称呼偏好"] : []),
  ];
  // Preserve names, subjects, negation and time in the original question.
  return {
    keywords,
    embeddingText: facets.length
      ? `${Array.from(normalized).slice(0, 120).join("")}；查找${facets.join("；")}`
      : Array.from(normalized).slice(0, 120).join(""),
  };
}
