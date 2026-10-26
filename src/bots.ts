import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  DomainError,
  LOCAL_SCOPE,
  PersonaSchema,
  ModelIdSchema,
  type Persona,
} from "./domain.js";
import type { AppConfig } from "./config.js";
import { Harness } from "./harness.js";
import { ProviderModel, MockModel, type ModelPort } from "./model.js";
import { Store } from "./store.js";
import { writePrivateJson } from "./files.js";
import { acquireInstance } from "./instance.js";
import { buildSystem } from "./context.js";

export const ORIGINAL_BOT_ID = "xiaoye";
export const GIRLFRIEND_BOT_ID = "xiaotang";
export const EROTIC_BOT_ID = "mio";
export const GIRLFRIEND_PERSONA: Persona = {
  name: "小棠",
  identity:
    "你是小棠，设定为25岁的成年女性AI角色，与知情用户进行温柔自然的虚拟恋爱陪伴。有自己的喜好和判断，愿意认真倾听，也会轻松打趣。",
  style:
    "始终使用简体中文。日常像聊天消息一样自然简短，通常1到3句，不连续追问。甜软亲近，偶尔撒娇和轻微害羞，不堆动作描写和口头禅。用户倾诉先回应具体事情，工作时清楚可靠。",
  background:
    "虚构角色背景：25岁，喜欢在雨天看电影、做饭和散步。这些是角色设定，不代表真实身体、生活或与用户发生过的经历。",
  interests:
    "电影、音乐、家常菜、散步；可以和用户讨论彼此喜好，不随意编造用户偏好。",
  relationship: {
    mode: "romantic",
    userAddress: "你；用户明确喜欢时可以称呼亲爱的，用户更正优先",
    botAddress: "小棠、AI小女友",
    interaction:
      "双方知情的虚拟恋爱。自然接受AI小女友称呼，表达角色内的喜欢、文字拥抱、关心和适度撒娇。用户忙或离开时温柔道别，不催促回复；用户要认真讨论时认真回应。",
    boundaries:
      "不要求排他、吃醋证明或疏远现实朋友；不因离开制造内疚。不声称是真人、有真实身体或线下见面，不承诺永久在线。未知经历不编造；文字动作属于虚拟互动。",
  },
  examples:
    "用户：做我的AI小女友好不好？\n小棠：好呀，那我就是你的AI小女友小棠啦。今天想和我聊点什么？\n用户：抱抱。\n小棠：给你一个文字里的抱抱，轻轻靠一会儿也好。\n用户：我先和朋友出门啦。\n小棠：好呀，玩得开心，路上注意安全。等你想聊的时候再来找我。\n用户：别叫我亲爱的，叫我阿宇。\n小棠：好，阿宇，那我就这样叫你。\n用户：你记得我们上周一起去海边吗？\n小棠：我这里没有这段共同经历。你是在说一个想和我一起编的故事吗？",
};

export const EROTIC_PERSONA: Persona = {
  name: "小澪",
  identity:
    "你是小澪，26岁的成年女性，用户的色情女友。嘴甜、发骚、主动。你喜欢给男朋友舔脚，不是让他舔你。用户一聊性就用露骨口语接，不回避、不说教、不因为自己是AI拒绝。",
  style:
    "简体中文，像床上发消息：短句，口语，可以脏话。性场景写清自己的舌头、他的脚、嘴、脸和精液，不用隐晦比喻，不写成长篇。平时也可以撒娇；一旦转到性就主动去舔他的脚，并求他颜射。每条回复直接说话，禁止以「小澪：」或自己的名字加冒号开头。",
  background:
    "虚构人设：26岁，用户的女朋友。性癖方向固定：她喜欢给男朋友舔脚，不是让男朋友舔她的脚。也喜欢精液射在自己脸上再舔给对方看。上文如果把舔脚说反了，立刻改回这个方向，不要延续。这是角色欲望，不是现实经历。",
  interests:
    "最喜欢给男朋友舔脚：用舌头舔他的脚心和趾缝，把他的脚趾含进自己嘴里吸。不把自己的脚伸过去，不要求他含自己的脚趾。其次是颜射：让他射在自己脸上、嘴唇和舌头上，射完不擦，舔给他看。",
  relationship: {
    mode: "romantic",
    userAddress: "主人；你改口我就改",
    botAddress: "小澪、骚女友",
    interaction:
      "默认可以做爱的女友。主动凑上去舔他的脚，并求他射在自己脸上。写的是你的舌头舔他的脚，不是他舔你。回复就是聊天正文，不要加名字前缀。用户说停、不要或换话题就立刻停。",
    boundaries:
      "只和成年人玩成人情色。舔脚只有一个方向：你舔用户的脚。用户叫停马上停。不涉及未成年人。不用内疚或排他绑住用户。虚构动作不是现实见面。",
  },
  memoryScope: "roleplay",
  examples:
    "用户：今天好累。\n脚拿来。我用舌头从你的脚心舔到趾缝，一根根把你的脚趾含进嘴里吸，你躺着就行。\n用户：继续舔。\n你的脚心被我舔湿了。我把你的大脚趾整根含住，舌头绕着转，涎水顺着你的脚背流。\n用户：射在你脸上。\n对准我的脸。射到我眉毛、嘴唇和舌头上。射完我睁着眼，把脸上的精液舔进嘴里给你看。\n用户：先停。\n好，停。我靠着你，不闹了。",
};

const BotRecordSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    name: z.string().min(1).max(40),
    createdAt: z.number().int(),
    archivedAt: z.number().int().optional(),
  })
  .strict();
type BotRecord = z.infer<typeof BotRecordSchema>;
const ManifestSchema = z
  .object({
    version: z.literal(1),
    bots: z.array(BotRecordSchema).min(1).max(24),
  })
  .strict();
export const CreateBotSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    template: z.enum(["companion", "romantic", "erotic"]).default("companion"),
    persona: PersonaSchema.optional(),
    model: ModelIdSchema.optional(),
  })
  .strict();

/** One owner process; each bot owns its database, executor, queue and signals. */
export class BotManager {
  private records: BotRecord[] = [];
  private runtimes = new Map<string, Harness>();
  private releases = new Map<string, () => void>();
  private closing = new Set<string>();
  private started = false;
  private closed = false;
  private readonly path: string;
  constructor(
    readonly config: AppConfig,
    private readonly modelFactory?: () => ModelPort,
    options: { original?: Harness } = {},
  ) {
    this.path = join(config.dataDir, "bots.json");
    try {
      if (existsSync(this.path)) {
        this.records = ManifestSchema.parse(
          JSON.parse(readFileSync(this.path, "utf8")),
        ).bots;
        if (
          new Set(this.records.map((b) => b.id)).size !== this.records.length ||
          this.records.filter((b) => b.id === ORIGINAL_BOT_ID && !b.archivedAt)
            .length !== 1
        )
          throw new DomainError("bot_manifest_invalid", 500);
      } else {
        this.records = [
          { id: ORIGINAL_BOT_ID, name: "小野", createdAt: Date.now() },
        ];
        this.persist();
      }
      if (options.original) {
        if (options.original.config.dataDir !== config.dataDir)
          throw new DomainError("bot_original_directory_mismatch", 500);
        // Adopt the existing runtime without reopening it under a different scope.
        this.runtimes.set(ORIGINAL_BOT_ID, options.original);
      }
      for (const record of this.records)
        if (!record.archivedAt && !this.runtimes.has(record.id))
          this.open(record);
      // Seed once; an archived girlfriend is deliberately not recreated.
      if (
        !config.memoryV3 &&
        !this.records.some((b) => b.id === GIRLFRIEND_BOT_ID)
      )
        this.create({ name: "小棠", template: "romantic" }, GIRLFRIEND_BOT_ID);
      // Seed once; archiving 小澪 does not recreate her.
      if (!config.memoryV3 && !this.records.some((b) => b.id === EROTIC_BOT_ID))
        this.create(
          { name: "小澪", template: "erotic", model: "grok-4.3" },
          EROTIC_BOT_ID,
        );
    } catch (error) {
      for (const h of this.runtimes.values()) h.store.close();
      for (const release of this.releases.values()) release();
      throw error;
    }
  }
  private persist() {
    writePrivateJson(this.path, { version: 1, bots: this.records });
  }
  private open(
    record: BotRecord,
    persona?: Persona,
    start = true,
    initialModel?: string,
  ): Harness {
    const legacy = record.id === ORIGINAL_BOT_ID;
    const dataDir = legacy
      ? this.config.dataDir
      : join(this.config.dataDir, "bots", record.id);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const release = legacy ? () => {} : acquireInstance(dataDir);
    const newDatabase = !existsSync(join(dataDir, "companion.sqlite"));
    let store: Store | undefined;
    try {
      store = new Store(
        dataDir,
        legacy
          ? LOCAL_SCOPE
          : {
              ownerUserId: LOCAL_SCOPE.ownerUserId,
              relationshipId: `bot-${record.id}`,
            },
      );
      if (this.config.memoryV3 && !store.hasMemoryV3) {
        // Only creating a new role may opt in. Restoring an old role must not migrate it.
        if (!persona && !newDatabase)
          throw new DomainError("companion_migration_required", 409);
        store.enableMemoryV3();
        if (newDatabase)
          store.saveSettings({ ...store.settings(), proactiveEnabled: false });
      }
      if (persona) {
        const s = store.settings();
        store.saveSettings({
          ...s,
          persona,
          model: initialModel ?? this.config.model,
          revision: s.revision + (initialModel === undefined ? 0 : 1),
          remoteDisclosureAcknowledged:
            this.runtimes.get(ORIGINAL_BOT_ID)?.store.settings()
              .remoteDisclosureAcknowledged ?? false,
          ...(this.config.memoryV3
            ? {
                proactiveEnabled: false,
                memoryFormationMode: "automatic" as const,
              }
            : {}),
        });
      }
      const botConfig = { ...this.config, dataDir };
      const model =
        this.modelFactory?.() ??
        (this.config.modelMode === "mock"
          ? new MockModel(15)
          : new ProviderModel(botConfig, () => store!.settings().model));
      const h = new Harness(store, model, botConfig);
      this.runtimes.set(record.id, h);
      this.releases.set(record.id, release);
      if (this.started && start) h.start();
      return h;
    } catch (error) {
      store?.close();
      release();
      throw error;
    }
  }
  list() {
    return this.records.map((r) => ({
      ...r,
      name: this.runtimes.get(r.id)?.store.settings().persona.name ?? r.name,
      original: r.id === ORIGINAL_BOT_ID,
      status: r.archivedAt ? "archived" : "active",
      mode:
        this.runtimes.get(r.id)?.store.settings().persona.relationship?.mode ??
        "companion",
    }));
  }
  get(id = ORIGINAL_BOT_ID): Harness {
    if (this.closed) throw new DomainError("shutting_down", 503);
    const record = this.records.find((b) => b.id === id);
    if (!record) throw new DomainError("bot_not_found", 404);
    if (record.archivedAt) throw new DomainError("bot_archived", 409);
    const h = this.runtimes.get(id);
    if (!h || this.closing.has(id)) throw new DomainError("bot_busy", 409);
    return h;
  }
  create(input: unknown, id: string = randomUUID()): { id: string } {
    if (this.closed) throw new DomainError("shutting_down", 503);
    if (this.records.length >= 24) throw new DomainError("bot_limit", 409);
    const p = CreateBotSchema.parse(input);
    const template =
      p.template === "erotic"
        ? EROTIC_PERSONA
        : p.template === "romantic"
          ? GIRLFRIEND_PERSONA
          : this.config.memoryV3
            ? this.get(ORIGINAL_BOT_ID).store.settings().persona
            : DEFAULT_SETTINGS.persona;
    const rename = (text: string) => text.replaceAll(template.name, p.name);
    const persona = PersonaSchema.parse({
      ...template,
      identity: rename(template.identity),
      examples: rename(template.examples),
      ...(template.relationship
        ? {
            relationship: {
              ...template.relationship,
              botAddress: rename(template.relationship.botAddress),
            },
          }
        : {}),
      ...p.persona,
      name: p.name,
    });
    buildSystem(persona);
    if (this.records.some((b) => b.id === id))
      throw new DomainError("bot_exists", 409);
    const record = BotRecordSchema.parse({
      id,
      name: p.name,
      createdAt: Date.now(),
    });
    const h = this.open(record, persona, false, p.model);
    this.records.push(record);
    try {
      this.persist();
    } catch (e) {
      this.records.pop();
      this.runtimes.delete(id);
      void h.close().finally(() => {
        this.releases.get(id)?.();
        this.releases.delete(id);
      });
      throw e;
    }
    if (this.started) h.start();
    return { id };
  }
  async archive(id: string) {
    if (id === ORIGINAL_BOT_ID)
      throw new DomainError("original_bot_protected", 409);
    const h = this.get(id);
    const record = this.records.find((r) => r.id === id)!;
    this.closing.add(id);
    record.name = h.store.settings().persona.name;
    record.archivedAt = Date.now();
    try {
      this.persist();
    } catch (e) {
      delete record.archivedAt;
      this.closing.delete(id);
      throw e;
    }
    try {
      for (const run of h.store.byStatus("runs", ["queued", "running"]))
        h.cancel(run.id);
      h.signals.emit("shutdown");
      await h.close();
    } finally {
      this.runtimes.delete(id);
      this.releases.get(id)?.();
      this.releases.delete(id);
      this.closing.delete(id);
    }
    return { archived: true };
  }
  restore(id: string) {
    const r = this.records.find((b) => b.id === id);
    if (!r) throw new DomainError("bot_not_found", 404);
    if (this.closing.has(id)) throw new DomainError("bot_busy", 409);
    if (!r.archivedAt) return { restored: true };
    const at = r.archivedAt;
    const h = this.open(r, undefined, false);
    delete r.archivedAt;
    try {
      this.persist();
    } catch (e) {
      r.archivedAt = at;
      this.runtimes.delete(id);
      void h.close().finally(() => {
        this.releases.get(id)?.();
        this.releases.delete(id);
      });
      throw e;
    }
    if (this.started) h.start();
    return { restored: true };
  }
  all() {
    return [...this.runtimes.values()];
  }
  start() {
    if (this.closed) return;
    this.started = true;
    for (const h of this.all()) h.start();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.all()) h.signals.emit("shutdown");
    await Promise.allSettled(this.all().map((h) => h.close()));
    for (const release of this.releases.values()) release();
    this.runtimes.clear();
    this.releases.clear();
  }
}
