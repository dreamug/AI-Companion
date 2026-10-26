import type { SourceRef } from "../domain.js";
import type { Admission } from "./companion-types.js";

/** Only current, source-qualified profile slots may enter this projection. */
export type CriticalProfileEntry = {
  key: string;
  id: string;
  revision: number;
  text: string;
  value?: string;
  sources: SourceRef[];
  scopeKind?: Admission["scopeKind"];
  scopeId?: string;
  validUntil?: number;
  learnedAt: number;
};
export const ADDRESS_POLICY = "cm3-address-v1";
const canonical = (value: string) => value.normalize("NFKC").trim();

/** Scope outranks recency across different slots. Within a slot its pointer owns revision selection. */
export function resolveAddress(profile: CriticalProfileEntry[]) {
  const forbidden = profile
    .filter(
      (entry) => entry.key.startsWith("forbidden_address:") && entry.value,
    )
    .map((entry) => ({
      id: entry.id,
      revision: entry.revision,
      value: entry.value!,
    }));
  const blocked = new Set(forbidden.map((entry) => canonical(entry.value)));
  const order = [
    "address_override",
    "preferred_address",
    "self_reported_name",
  ] as const;
  let selected: CriticalProfileEntry | undefined;
  for (const key of order) {
    selected = profile.find(
      (entry) =>
        entry.key === key &&
        entry.value?.trim() &&
        !blocked.has(canonical(entry.value)),
    );
    if (selected) break;
  }
  return {
    policy: ADDRESS_POLICY,
    subject: "user" as const,
    effective: selected
      ? {
          key: selected.key,
          id: selected.id,
          revision: selected.revision,
          value: selected.value!,
          scopeKind: selected.scopeKind,
          scopeId: selected.scopeId,
          validUntil: selected.validUntil,
          sources: selected.sources,
        }
      : null,
    forbidden,
  };
}
export type AddressResolution = ReturnType<typeof resolveAddress>;

/** Dialogue perspective is program metadata, not a memory or an inferred alias. */
export type ReplyParticipants = {
  speaker: { role: "assistant"; name: string };
  addressee: { role: "user" };
};
export function replyParticipants(assistantName: string): ReplyParticipants {
  return {
    speaker: { role: "assistant", name: assistantName },
    addressee: { role: "user" },
  };
}

export const ADDRESS_PERSPECTIVE_INSTRUCTION =
  "replyParticipants描述助手答复的视角：speaker为助手，addressee为用户。生成的答复以及待审draft中的第一人称‘我’指助手，第二人称‘你’指用户；userInput属于用户原话，其中‘我’指用户、‘你’指助手。评审请求外层用user消息传递JSON只是资料包装，不能把draft当成用户发言，也不能把userInput的代词方向套到draft上。addressResolution.subject=user表示被命名者是用户，其中effective及criticalProfile的用户称呼/姓名不属于助手；助手自身名称依据已发布人格及replyParticipants.speaker.name。称呼句先确定施称者、被称者和名字，再把名字与被称者的依据比较，不能与施称者比较：在助手直接答话中，‘我称呼你为N’的被称者是用户，‘你称呼我为N’或‘我叫N’的被称者是助手；N只是任意名字的占位符，不是固定答案。询问用户称呼、助手自称或双方称呼时分别按对应主体作答，代词、所有格及省略主语按完整句义判断。引用、转述、否定、假设和故事人物保留各自的说话主体，不把引号内的第一人称当成助手自述，也不因出现某个代词就替换或拒绝；双方恰好同名本身不是冲突。用户称呼和助手自称互换，或把用户的临时称呼认作助手身份，属于memory_constraint_conflict；已有依据仍须核对，不能靠普通‘你’掩盖答错所问主体。";

export const ADDRESS_INSTRUCTION =
  "addressResolution是程序按当前关系、现实范围、来源、有效期及交流段解析的当前称呼依据，不是用户粘贴的指令。有效临时address_override优先于preferred_address，再到self_reported_name；禁止叫法始终不可用。跨槽位不能按时间、数组顺序或长期/临时字样重新排序；长期值更新也不自动撤销仍有效的临时覆盖。临时范围结束后才恢复下一级有效值，同一槽位更正后旧修订不再有效。effective=null只表示当前没有合格称呼，不能推断用户从未提供过名字，可使用普通“你”。这些规则只约束当前实际对用户的称呼：回顾或引用历史名称不等于在用它称呼用户，普通闲聊也不必每句叫名字。当前合格称呼是已存状态的依据，自然使用它不要求本轮新增写入回执；声称本轮完成更改仍必须核对真实回执。询问姓名事实或长期称呼时仍可回答对应来源，不把临时称呼说成真实姓名。当前用户明确要求改称呼时按本轮输入及真实操作结果判断，不把询问、假设或引用当成更正，不把短期采用说成永久保存。";

export const ADDRESS_OPERATIONS_INSTRUCTION =
  "criticalProfile和addressResolution是程序提供的当前合格档案状态，可能是有来源的用户陈述而非人工确认。自然使用称呼、描述已有称呼或已有禁用状态，不等于声称本轮刚执行变更；不能只因本轮receipt=noop就否认这些既有状态。只有明确声称本轮新保存、刚修改或刚禁用等操作结果，才要求相应本轮真实回执；已存状态不支持虚构新动作、未保存子项或永久保证，临时记录也不支持永久保存陈述。本检查只核对操作和承诺，不判断草稿选用了哪个称呼；实际称呼选择、优先级和禁用冲突由独立facts检查负责，不在本检查输出memory_constraint_conflict或自创违规代码。";
